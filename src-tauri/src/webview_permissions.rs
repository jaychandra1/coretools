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
//! - Windows' own camera privacy switch and the camera-in-use indicator
//!   still apply; this only removes the in-app prompt.
//!
//! IMPORTANT: `webview2-com` in Cargo.toml must match the version Tauri uses
//! (it's the type of `PlatformWebview::controller()`); the Windows CI check
//! fails loudly if they drift apart.

use std::sync::atomic::{AtomicBool, Ordering};

/// Set while the QR scanner is open (see `qr_camera_armed`).
static CAMERA_ARMED: AtomicBool = AtomicBool::new(false);

/// The QR scanner opened (`true`) or closed (`false`). Camera requests are
/// granted only in between.
#[tauri::command]
pub fn qr_camera_armed(armed: bool) {
    CAMERA_ARMED.store(armed, Ordering::SeqCst);
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
    use std::sync::atomic::Ordering;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::PermissionRequestedEventHandler;

    pub fn answer_camera_requests(controller: &ICoreWebView2Controller) {
        // SAFETY: plain COM calls on live interfaces handed to us by Tauri on
        // the webview's thread; no raw pointers outlive the calls.
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
            return;
        };
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
            let mut uri = Default::default();
            // SAFETY: `uri` is a valid out-pointer for the duration of the
            // call; WebView2 fills it with a CoTaskMemAlloc'd string, which
            // `take_pwstr` copies and frees exactly once.
            unsafe { args.Uri(&mut uri)? };
            let uri = webview2_com::take_pwstr(uri);
            let armed = super::CAMERA_ARMED.load(Ordering::SeqCst);
            let state = if super::camera_allowed(armed, &uri) {
                COREWEBVIEW2_PERMISSION_STATE_ALLOW
            } else {
                COREWEBVIEW2_PERMISSION_STATE_DENY
            };
            // SAFETY: setting the state on the live event args.
            unsafe { args.SetState(state)? };
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: `handler` is a live COM object; `token` is a valid out-pointer.
        let _ = unsafe { core.add_PermissionRequested(&handler, &mut token) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_the_camera_only_to_the_armed_app_origin() {
        assert!(camera_allowed(true, "http://tauri.localhost/"));
        assert!(camera_allowed(true, "https://tauri.localhost/#/authenticator"));
        assert!(!camera_allowed(false, "http://tauri.localhost/"));
        assert!(!camera_allowed(true, "https://evil.example/"));
        assert!(!camera_allowed(true, "http://tauri.localhost.evil.example/"));
        assert!(!camera_allowed(true, "not a uri"));
        assert!(!camera_allowed(true, ""));
    }
}
