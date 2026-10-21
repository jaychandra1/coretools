//! Copy secrets without leaking them into clipboard history (audit F-07).
//!
//! The webview's clipboard API can only put plain text on the clipboard, so
//! with Windows clipboard history (Win+V) on, every copied password and 2FA
//! code stayed in the history — and with "sync across devices", was uploaded
//! to the Microsoft account, outside the app's end-to-end encryption.
//!
//! Copying through here marks the data the way password managers do:
//!  - Windows: `ExcludeClipboardContentFromMonitorProcessing` — kept out of
//!    clipboard history, cloud clipboard and clipboard monitors;
//!  - macOS: `org.nspasteboard.ConcealedType` — the nspasteboard.org
//!    convention clipboard managers honour;
//!  - Linux: `x-kde-passwordManagerHint=secret` — honoured by Klipper and
//!    most clipboard managers.
//!
//! The text passes through this process only to be placed on the clipboard;
//! it is never stored or logged. The clipboard handle is kept for the life of
//! the app because on X11 the copying process must keep serving the data.
//! Clipboard calls run on the blocking pool, never on the main (UI) thread:
//! on X11 each is a round trip to the X server (audit M7).

use std::sync::{Arc, Mutex};

use arboard::Clipboard;
use tauri::State;

/// Longest secret accepted (passwords, notes, OTP codes are far shorter).
const MAX_SECRET_CHARS: usize = 4096;

/// The clipboard handle, created on first use and shared with the blocking
/// tasks that use it.
#[derive(Default)]
pub struct SecureClipboard(Arc<Mutex<Option<Clipboard>>>);

/// Run `work` with the clipboard on the blocking pool.
async fn with_clipboard<T, F>(state: &SecureClipboard, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Clipboard) -> Result<T, arboard::Error> + Send + 'static,
{
    let shared = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = shared
            .lock()
            .map_err(|_| "clipboard_unavailable".to_string())?;
        if guard.is_none() {
            *guard = Some(Clipboard::new().map_err(|_| "clipboard_unavailable".to_string())?);
        }
        let clipboard = guard
            .as_mut()
            .ok_or_else(|| "clipboard_unavailable".to_string())?;
        work(clipboard).map_err(|_| "clipboard_unavailable".to_string())
    })
    .await
    .map_err(|_| "clipboard_unavailable".to_string())?
}

/// Put `text` on the clipboard, excluded from history and cloud sync.
#[tauri::command]
pub async fn clipboard_copy_secret(
    state: State<'_, SecureClipboard>,
    text: String,
) -> Result<(), String> {
    if text.chars().count() > MAX_SECRET_CHARS {
        return Err("clipboard_too_large".into());
    }
    with_clipboard(state.inner(), move |clipboard| {
        let set = clipboard.set();
        #[cfg(windows)]
        let set = {
            use arboard::SetExtWindows;
            set.exclude_from_monitoring()
        };
        #[cfg(target_os = "macos")]
        let set = {
            use arboard::SetExtApple;
            set.exclude_from_history()
        };
        #[cfg(target_os = "linux")]
        let set = {
            use arboard::SetExtLinux;
            set.exclude_from_history()
        };
        set.text(text)
    })
    .await
}

/// Clear the clipboard only if it still holds `expected`, so whatever the user
/// copied since is never destroyed. Returns whether it cleared.
#[tauri::command]
pub async fn clipboard_clear_if(
    state: State<'_, SecureClipboard>,
    expected: String,
) -> Result<bool, String> {
    with_clipboard(state.inner(), move |clipboard| {
        let unchanged = clipboard.get_text().is_ok_and(|text| text == expected);
        if unchanged {
            clipboard.clear().map(|_| true)
        } else {
            Ok(false)
        }
    })
    .await
}
