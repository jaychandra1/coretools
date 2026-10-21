//! Camera permission for the app's own QR scanner (Windows / WebView2).
//!
//! WebView2 asks "http://tauri.localhost wants to use your cameras" the first
//! time the Authenticator's QR scanner starts. That origin is just Tauri's
//! internal address for the app's own pages and can't be renamed, so the
//! prompt reads like a foreign website asking. The user already expressed
//! intent by clicking "Scan with camera" in the app, so this handler answers
//! WebView2's permission request for the CAMERA itself.
//!
//! Scope, deliberately narrow (audit L1):
//!
//! - only `COREWEBVIEW2_PERMISSION_KIND_CAMERA` is answered; every other
//!   kind (microphone, location, notifications, …) keeps the default
//!   WebView2 behaviour;
//! - the camera is granted only while the scanner is open — the frontend
//!   arms it with `qr_camera_armed(true)` when scanning starts and disarms
//!   it when scanning stops — and only to the app's own origin; any other
//!   camera request is denied outright;
//! - no answer is saved in the WebView2 profile (audit N2): a saved ALLOW
//!   would answer later requests without asking this handler (so without
//!   the arming check), a saved DENY would break the scanner for good. Any
//!   decision an older version saved is reset at startup;
//! - Windows' own camera privacy switch and the camera-in-use indicator
//!   still apply; this only removes the in-app prompt.
//!
//! IMPORTANT: `webview2-com` in Cargo.toml must match the version Tauri uses
//! (it's the type of `PlatformWebview::controller()`); the Windows CI check
//! fails loudly if they drift apart.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long one arming lasts at most. The scanner asks for the camera right
/// after arming and disarms once that request is answered; the limit only
/// ends an arming whose disarm never came (the page reloaded meanwhile).
const ARMING_LIFETIME: Duration = Duration::from_secs(60);

/// The scanner's armings (see `qr_camera_armed`). A count, not a flag
/// (audit N2): a scanner restarted while its previous camera request is
/// still pending arms again, and the older request's disarm mustn't close
/// the newer one.
#[derive(Default)]
struct Arming {
    /// Armings not disarmed yet.
    open: u32,
    /// When the latest arming lapses.
    until: Option<Instant>,
}

impl Arming {
    fn is_armed(&self, now: Instant) -> bool {
        self.open > 0 && self.until.is_some_and(|until| now < until)
    }

    fn set(&mut self, armed: bool, now: Instant) {
        if !self.is_armed(now) {
            // Lapsed: armings whose disarm never came don't carry over.
            self.open = 0;
        }
        if armed {
            self.open = self.open.saturating_add(1);
            self.until = now.checked_add(ARMING_LIFETIME);
        } else {
            self.open = self.open.saturating_sub(1);
        }
    }
}

static ARMING: Mutex<Arming> = Mutex::new(Arming {
    open: 0,
    until: None,
});

/// The QR scanner opened (`true`) or closed (`false`). Camera requests are
/// granted only in between.
#[tauri::command]
pub fn qr_camera_armed(armed: bool) {
    if let Ok(mut arming) = ARMING.lock() {
        arming.set(armed, Instant::now());
    }
}

/// Whether the scanner is armed right now (a poisoned lock counts as no).
#[cfg(windows)]
fn camera_armed() -> bool {
    ARMING
        .lock()
        .map(|arming| arming.is_armed(Instant::now()))
        .unwrap_or(false)
}

/// Whether a camera request from `uri` gets the camera: only the app's own
/// pages, and only while the scanner is armed.
#[cfg(any(windows, test))]
fn camera_allowed(armed: bool, uri: &str) -> bool {
    armed
        && reqwest::Url::parse(uri).is_ok_and(|url| {
            crate::links::is_app_origin(
                url.scheme(),
                url.host_str(),
                url.port(),
                cfg!(debug_assertions),
            )
        })
}

/// Install the handler on a window's webview. No-op outside Windows.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    // Best effort: if it can't be installed, WebView2 simply keeps prompting.
    let _ = window.with_webview(|webview| imp::answer_camera_requests(&webview.controller()));
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}

#[cfg(windows)]
mod imp {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Controller, ICoreWebView2PermissionRequestedEventArgs3,
        ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        COREWEBVIEW2_PERMISSION_STATE_DEFAULT, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::PermissionRequestedEventHandler;
    use webview2_com::SetPermissionStateCompletedHandler;
    use windows_core::{Interface, HSTRING, PWSTR};

    /// Where the app's pages are served from on Windows: Tauri uses http
    /// unless `useHttpsScheme` is set, so both are reset.
    const APP_ORIGINS: [&str; 2] = ["http://tauri.localhost", "https://tauri.localhost"];

    pub fn answer_camera_requests(controller: &ICoreWebView2Controller) {
        // SAFETY: plain COM calls on live interfaces handed to us by Tauri on
        // the webview's thread; no raw pointers outlive the calls.
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
            return;
        };
        forget_saved_camera_decisions(&core);
        let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            // SAFETY: `kind` is a valid out-pointer for the duration of the call.
            unsafe { args.PermissionKind(&mut kind)? };
            if kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                return Ok(());
            }
            // The answer must not be saved in the profile. A WebView2 too
            // old to be told so (before 1.0.1661) gets no answer from here:
            // it shows its own prompt, as it would without this handler.
            let Ok(unsaved) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() else {
                return Ok(());
            };
            let mut uri = PWSTR::null();
            // SAFETY: `uri` is a valid out-pointer for the duration of the
            // call; WebView2 fills it with a CoTaskMemAlloc'd string, which
            // `take_pwstr` copies and frees exactly once.
            unsafe { args.Uri(&mut uri)? };
            let uri = webview2_com::take_pwstr(uri);
            let state = if super::camera_allowed(super::camera_armed(), &uri) {
                COREWEBVIEW2_PERMISSION_STATE_ALLOW
            } else {
                COREWEBVIEW2_PERMISSION_STATE_DENY
            };
            // SAFETY: setting properties on the live event args.
            unsafe {
                unsaved.SetSavesInProfile(false)?;
                unsaved.SetState(state)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: `handler` is a live COM object; `token` is a valid out-pointer.
        let _ = unsafe { core.add_PermissionRequested(&handler, &mut token) };
    }

    /// Reset the camera permission an older version may have saved in the
    /// WebView2 profile for the app's origins (audit N2): while one is
    /// saved, WebView2 may answer by itself and never ask the handler.
    /// `COREWEBVIEW2_PERMISSION_STATE_DEFAULT` erases the saved state. Best
    /// effort: runtimes before 1.0.1661 lack `ICoreWebView2Profile4`.
    fn forget_saved_camera_decisions(core: &ICoreWebView2) {
        let Ok(webview) = core.cast::<ICoreWebView2_13>() else {
            return;
        };
        // SAFETY: plain COM call on a live interface.
        let Ok(profile) = (unsafe { webview.Profile() }) else {
            return;
        };
        let Ok(profile) = profile.cast::<ICoreWebView2Profile4>() else {
            return;
        };
        for origin in APP_ORIGINS {
            let origin = HSTRING::from(origin);
            let done = SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(())));
            // SAFETY: plain COM call on a live interface; `origin` and `done`
            // outlive it (WebView2 keeps its own reference to `done`).
            unsafe {
                let _ = profile.SetPermissionState(
                    COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                    &origin,
                    COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                    &done,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_the_camera_only_to_the_armed_app_origin() {
        assert!(camera_allowed(true, "http://tauri.localhost/"));
        assert!(camera_allowed(
            true,
            "https://tauri.localhost/#/authenticator"
        ));
        assert!(!camera_allowed(false, "http://tauri.localhost/"));
        assert!(!camera_allowed(true, "https://evil.example/"));
        assert!(!camera_allowed(
            true,
            "http://tauri.localhost.evil.example/"
        ));
        assert!(!camera_allowed(true, "not a uri"));
        assert!(!camera_allowed(true, ""));
    }

    #[test]
    fn an_older_disarm_cannot_close_a_newer_arming() {
        let now = Instant::now();
        let mut arming = Arming::default();
        assert!(!arming.is_armed(now));
        arming.set(true, now); // scan A starts
        arming.set(true, now); // scan B starts while A's request is pending
        arming.set(false, now); // A's request is answered
        assert!(arming.is_armed(now));
        arming.set(false, now); // B's
        assert!(!arming.is_armed(now));
        // A stray extra disarm leaves nothing owed.
        arming.set(false, now);
        arming.set(true, now);
        assert!(arming.is_armed(now));
    }

    #[test]
    fn an_arming_without_its_disarm_lapses() {
        let now = Instant::now();
        let mut arming = Arming::default();
        arming.set(true, now);
        assert!(arming.is_armed(now + Duration::from_secs(1)));
        let later = now + ARMING_LIFETIME;
        assert!(!arming.is_armed(later));
        // The lapsed arming isn't carried into the next scan.
        arming.set(true, later);
        arming.set(false, later);
        assert!(!arming.is_armed(later));
    }
}
