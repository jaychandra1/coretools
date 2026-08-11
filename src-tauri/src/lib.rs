//! CoreTools native backend.
//!
//! This backend is deliberately tiny. It exposes exactly two privileged
//! operations — reading and writing UTF-8 text files that the user explicitly
//! selected through a native dialog. All diffing and YAML optimization happens
//! in the frontend (in-memory), so no business logic or user data ever passes
//! through, or is retained by, the native layer.
//!
//! There are no network dependencies, no persistence, and no logging of file
//! contents.

mod hello;

use std::fs;
use std::path::Path;

/// Hard upper bound on files we are willing to read into memory (50 MiB).
/// Protects against accidentally loading a huge/binary file and exhausting RAM.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// Read a user-selected text file into a string.
///
/// The path always originates from a native open-dialog on the frontend, never
/// from untrusted content. We still validate defensively: the target must be a
/// regular file and within the size limit.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);

    if !p.is_file() {
        return Err("Selected path is not a regular file.".into());
    }

    let meta = fs::metadata(p).map_err(|e| format!("Could not read file metadata: {e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "File is too large ({} bytes). Maximum supported size is {} bytes.",
            meta.len(),
            MAX_FILE_BYTES
        ));
    }

    fs::read_to_string(p).map_err(|e| format!("Could not read file as UTF-8 text: {e}"))
}

/// Write `contents` to a user-selected destination path.
///
/// The path always originates from a native save-dialog on the frontend. This
/// is the only way data leaves the application, and it happens only when the
/// user explicitly confirms a destination.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(Path::new(&path), contents)
        .map_err(|e| format!("Could not write file: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            hello::hello_available,
            hello::hello_create_key,
            hello::hello_sign,
            hello::hello_delete_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running CoreTools");
}
