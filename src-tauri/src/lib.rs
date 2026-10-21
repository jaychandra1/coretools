//! CoreTools native backend.
//!
//! This backend is deliberately tiny, and the trust model is enforced HERE,
//! not in the webview: file dialogs are opened from Rust, and the read/write
//! commands accept only a path a dialog just issued, for that operation,
//! exactly once (`files.rs`). A compromised webview can therefore never read
//! or write a path the user did not just pick in a native dialog. Links
//! leave the app only through `links.rs` (allow-list, or the user's OK in a
//! native dialog), and the webview can't navigate away from the app.
//!
//! No logging of file contents. Its only persistence is a small local
//! diagnostics log of error causes (`diagnostics.rs`). Network code: the
//! opt-in cloud backup (`cloud.rs`) talks exclusively to Google's
//! OAuth/Drive endpoints, keeps its credential in the OS keychain, and only
//! ever uploads content the frontend has already encrypted end-to-end; the
//! opt-in update check (`updates.rs`) reads one fixed public URL.

mod cloud;
mod diagnostics;
mod files;
mod hello;
mod links;
mod secure_clipboard;
mod updates;
mod webview_permissions;

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Ask the user to confirm an action in a native dialog drawn by this
/// process — the webview can't fake or skip it. Runs the blocking dialog
/// off the main thread; failing to show it counts as "no".
pub(crate) async fn confirm(
    app: &tauri::AppHandle,
    title: &str,
    message: String,
    ok_label: &str,
) -> bool {
    let dialog_app = app.clone();
    let title = title.to_string();
    let ok_label = ok_label.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(ok_label, "Cancel".to_string()))
            .blocking_show()
    })
    .await
    .unwrap_or(false)
}

/// A second launch brings the running window forward instead of opening
/// another copy on the same vault (audit D-1).
fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    diagnostics::install_panic_hook();
    let context = tauri::generate_context!();
    // In-app updates only where the release workflow compiled in a public key.
    let updater_enabled = updates::updater_configured(context.config());
    // Single instance first: a second launch must exit before anything else
    // starts up.
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(links::navigation_guard())
        .plugin(tauri_plugin_dialog::init());
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
        .manage(files::AuthorizedPaths::default())
        .manage(links::ExternalLinks::default())
        .manage(cloud::CloudState::default())
        .manage(secure_clipboard::SecureClipboard::default())
        .manage(updates::UpdaterEnabled(updater_enabled))
        .invoke_handler(tauri::generate_handler![
            files::pick_open_path,
            files::pick_save_path,
            files::read_text_file,
            files::write_text_file,
            files::write_binary_file,
            links::open_external_url,
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
            diagnostics::diagnostics_report,
            webview_permissions::qr_camera_armed
        ])
        .run(context)
        .expect("error while running CoreTools");
}
