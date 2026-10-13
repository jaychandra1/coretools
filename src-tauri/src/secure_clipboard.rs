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

use std::sync::Mutex;

use arboard::Clipboard;
use tauri::State;

/// Longest secret accepted (passwords, notes, OTP codes are far shorter).
const MAX_SECRET_CHARS: usize = 4096;

#[derive(Default)]
pub struct SecureClipboard(Mutex<Option<Clipboard>>);

fn with_clipboard<T>(
    state: &SecureClipboard,
    run: impl FnOnce(&mut Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "clipboard_unavailable".to_string())?;
    if guard.is_none() {
        *guard = Some(Clipboard::new().map_err(|_| "clipboard_unavailable".to_string())?);
    }
    let clipboard = guard
        .as_mut()
        .ok_or_else(|| "clipboard_unavailable".to_string())?;
    run(clipboard).map_err(|_| "clipboard_unavailable".to_string())
}

/// Put `text` on the clipboard, excluded from history and cloud sync.
#[tauri::command]
pub fn clipboard_copy_secret(state: State<'_, SecureClipboard>, text: String) -> Result<(), String> {
    if text.chars().count() > MAX_SECRET_CHARS {
        return Err("clipboard_too_large".into());
    }
    with_clipboard(state.inner(), |clipboard| {
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
}

/// Clear the clipboard only if it still holds `expected`, so whatever the user
/// copied since is never destroyed. Returns whether it cleared.
#[tauri::command]
pub fn clipboard_clear_if(state: State<'_, SecureClipboard>, expected: String) -> Result<bool, String> {
    with_clipboard(state.inner(), |clipboard| match clipboard.get_text() {
        Ok(current) if current == expected => clipboard.clear().map(|_| true),
        _ => Ok(false),
    })
}
