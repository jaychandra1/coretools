//! CoreTools native backend.
//!
//! This backend is deliberately tiny, and the trust model is enforced HERE,
//! not in the webview: file dialogs are opened from Rust, every path they
//! issue is canonicalized and remembered, and the read/write commands accept
//! only a remembered path — exactly once. A compromised webview can therefore
//! never read or write a path the user did not just pick in a native dialog.
//!
//! No logging of file contents. Its only persistence is a small local
//! diagnostics log of error causes (`diagnostics.rs`). Network code: the
//! opt-in cloud backup (`cloud.rs`) talks exclusively to Google's
//! OAuth/Drive endpoints, keeps its credential in the OS keychain, and only
//! ever uploads content the frontend has already encrypted end-to-end; the
//! opt-in update check (`updates.rs`) reads one fixed public URL.

mod cloud;
mod diagnostics;
mod hello;
mod secure_clipboard;
mod updates;
mod webview_permissions;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Hard upper bound on files we are willing to read into memory (50 MiB).
/// Protects against accidentally loading a huge/binary file and exhausting RAM.
const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

/// Hard upper bound on writes (100 MiB) — applies to text and binary alike.
const MAX_WRITE_BYTES: usize = 100 * 1024 * 1024;

/// Paths the user has explicitly picked in a native dialog, canonicalized.
/// Each entry authorizes exactly one file operation and is consumed by it.
#[derive(Default)]
struct AuthorizedPaths(Mutex<HashSet<PathBuf>>);

/// Canonical form for a file that is about to be written: the parent must
/// exist and canonicalize; the file itself may not exist yet.
fn canonical_for_write(path: &Path) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("Path has no parent directory.")?;
    let name = path.file_name().ok_or("Path has no file name.")?;
    let parent = fs::canonicalize(parent)
        .map_err(|e| format!("Could not resolve the target directory: {e}"))?;
    Ok(parent.join(name))
}

/// Remove `path` from the authorized set. Returns false when it was never
/// authorized (or was already used) — the caller must refuse the operation.
fn consume(state: &AuthorizedPaths, canonical: &Path) -> bool {
    state.0.lock().map(|mut set| set.remove(canonical)).unwrap_or(false)
}

/// Show the native open-dialog and authorize the picked file for one read.
/// Runs the blocking dialog off the main thread. Returns None on cancel.
#[tauri::command]
async fn pick_open_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file_path) = picked else { return Ok(None) };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("Could not resolve the selected file: {e}"))?;

    let state = app.state::<AuthorizedPaths>();
    state
        .0
        .lock()
        .map_err(|_| "Internal state unavailable".to_string())?
        .insert(canonical.clone());
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

/// Show the native save-dialog and authorize the chosen path for one write.
#[tauri::command]
async fn pick_save_path(
    app: tauri::AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_file_name(&default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file_path) = picked else { return Ok(None) };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let canonical = canonical_for_write(&path)?;

    let state = app.state::<AuthorizedPaths>();
    state
        .0
        .lock()
        .map_err(|_| "Internal state unavailable".to_string())?
        .insert(canonical.clone());
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

/// Read a user-selected text file into a string.
///
/// The path must have been issued by `pick_open_path` (canonical match,
/// single use). Defensive checks on top: regular file, size cap, UTF-8 only.
#[tauri::command]
fn read_text_file(
    state: tauri::State<'_, AuthorizedPaths>,
    path: String,
) -> Result<String, String> {
    let canonical = fs::canonicalize(Path::new(&path))
        .map_err(|e| format!("Could not resolve file: {e}"))?;
    if !consume(&state, &canonical) {
        return Err("Path was not issued by a file dialog.".into());
    }

    if !canonical.is_file() {
        return Err("Selected path is not a regular file.".into());
    }

    let meta =
        fs::metadata(&canonical).map_err(|e| format!("Could not read file metadata: {e}"))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "File is too large ({} bytes). Maximum supported size is {} bytes.",
            meta.len(),
            MAX_READ_BYTES
        ));
    }

    fs::read_to_string(&canonical).map_err(|e| format!("Could not read file as UTF-8 text: {e}"))
}

/// Write `contents` to a destination issued by `pick_save_path` (canonical
/// match, single use, size-capped).
#[tauri::command]
fn write_text_file(
    state: tauri::State<'_, AuthorizedPaths>,
    path: String,
    contents: String,
) -> Result<(), String> {
    if contents.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Refusing to write {} bytes (limit {} bytes).",
            contents.len(),
            MAX_WRITE_BYTES
        ));
    }
    let canonical = canonical_for_write(Path::new(&path))?;
    if !consume(&state, &canonical) {
        return Err("Path was not issued by a file dialog.".into());
    }
    fs::write(&canonical, contents).map_err(|e| format!("Could not write file: {e}"))
}

/// Binary counterpart of `write_text_file` (e.g. .xlsx exports). Same trust
/// model: dialog-issued path, single use, size cap.
#[tauri::command]
fn write_binary_file(
    state: tauri::State<'_, AuthorizedPaths>,
    path: String,
    contents: Vec<u8>,
) -> Result<(), String> {
    if contents.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Refusing to write {} bytes (limit {} bytes).",
            contents.len(),
            MAX_WRITE_BYTES
        ));
    }
    let canonical = canonical_for_write(Path::new(&path))?;
    if !consume(&state, &canonical) {
        return Err("Path was not issued by a file dialog.".into());
    }
    fs::write(&canonical, contents).map_err(|e| format!("Could not write file: {e}"))
}

/// Open a saved login page (Credential Manager) in the system browser.
///
/// Only absolute http(s) URLs with a host are accepted, re-serialized by the
/// URL parser before use — so a page can't launch file:, custom-protocol or
/// shell handlers through this command.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if url.len() > 2048 {
        return Err("invalid_url".into());
    }
    let parsed = reqwest::Url::parse(&url).map_err(|_| "invalid_url".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("invalid_url".into());
    }
    cloud::open_browser(parsed.as_str())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // In-app updates only where the release workflow compiled in a public key.
    let updater_enabled = updates::updater_configured(context.config());
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    if updater_enabled {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .setup(|app| {
            diagnostics::init(app);
            // Answer the QR scanner's camera request ourselves instead of
            // WebView2's "http://tauri.localhost wants to…" prompt.
            if let Some(window) = app.get_webview_window("main") {
                webview_permissions::install(&window);
            }
            Ok(())
        })
        .manage(AuthorizedPaths::default())
        .manage(cloud::CloudState::default())
        .manage(secure_clipboard::SecureClipboard::default())
        .manage(updates::UpdaterEnabled(updater_enabled))
        .invoke_handler(tauri::generate_handler![
            pick_open_path,
            pick_save_path,
            read_text_file,
            write_text_file,
            write_binary_file,
            open_external_url,
            hello::hello_available,
            hello::hello_create_key,
            hello::hello_sign,
            hello::hello_delete_key,
            hello::hello_verify_user,
            cloud::cloud_available,
            cloud::cloud_status,
            cloud::cloud_connect,
            cloud::cloud_cancel_connect,
            cloud::cloud_disconnect,
            cloud::cloud_list,
            cloud::cloud_upload,
            cloud::cloud_download,
            cloud::cloud_delete,
            secure_clipboard::clipboard_copy_secret,
            secure_clipboard::clipboard_clear_if,
            updates::check_for_update,
            updates::install_update,
            diagnostics::diagnostics_record,
            diagnostics::diagnostics_report
        ])
        .run(context)
        .expect("error while running CoreTools");
}
