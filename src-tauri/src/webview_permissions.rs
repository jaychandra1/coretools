//! Camera permission for the app's own QR scanner (Windows / WebView2).
//!
//! WebView2 asks "http://tauri.localhost wants to use your cameras" the first
//! time the Authenticator's QR scanner starts. That origin is just Tauri's
//! internal address for the app's own pages and can't be renamed, so the
//! prompt reads like a foreign website asking. The user already expressed
//! intent by clicking "Scan with camera" in the app, so this handler answers
//! WebView2's permission request for the CAMERA itself.
//!
//! Scope, deliberately narrow:
//!   - only `COREWEBVIEW2_PERMISSION_KIND_CAMERA` is granted; every other
//!     kind (microphone, location, notifications, …) keeps the default
//!     WebView2 behaviour;
//!   - only the app's own pages can be in this webview — the CSP forbids
//!     frames (`frame-src 'none'`) and nothing navigates it to a remote site
//!     (login links open in the system browser) — so there is no third-party
//!     origin that could receive the grant;
//!   - Windows' own camera privacy switch and the camera-in-use indicator
//!     still apply; this only removes the in-app prompt.
//!
//! IMPORTANT: `webview2-com` in Cargo.toml must match the version Tauri uses
//! (it's the type of `PlatformWebview::controller()`); the Windows CI check
//! fails loudly if they drift apart.

/// Install the handler on a window's webview. No-op outside Windows.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    // Best effort: if it can't be installed, WebView2 simply keeps prompting.
    let _ = window.with_webview(|webview| imp::allow_camera(&webview.controller()));
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}

#[cfg(windows)]
mod imp {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    pub fn allow_camera(controller: &ICoreWebView2Controller) {
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
            if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                // SAFETY: setting the state on the live event args.
                unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: `handler` is a live COM object; `token` is a valid out-pointer.
        let _ = unsafe { core.add_PermissionRequested(&handler, &mut token) };
    }
}
