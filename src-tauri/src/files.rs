//! User-picked files: native dialogs, and the reads and writes they allow.
//!
//! The trust model is enforced HERE, not in the webview. The open and save
//! dialogs run in Rust, and each path they return becomes a grant for one
//! operation of that kind: a picked file can be read once, a save target
//! written once (audit M1). The read/write commands look the path string up
//! among the grants BEFORE touching the filesystem (audit M2), so a
//! compromised webview can't read or write anything else, can't probe
//! whether a file exists (an unknown path always gets the same error), and
//! can't make Windows open a UNC or device path it chose — which would send
//! the user's NTLM credentials to that server.
//!
//! Only after a grant matches is the path resolved again; it must still
//! resolve to where it pointed when the user picked it, so a directory or
//! link swapped in between is refused. Reads are capped while reading, and
//! writes go through a temporary file renamed over the target.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use tauri::ipc::{InvokeBody, Request};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// Hard upper bound on files we are willing to read into memory (50 MiB).
/// Protects against accidentally loading a huge/binary file and exhausting RAM.
const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

/// Hard upper bound on writes (100 MiB) — applies to text and binary alike.
const MAX_WRITE_BYTES: usize = 100 * 1024 * 1024;

/// Unused grants kept at most; beyond this the oldest is forgotten.
const MAX_GRANTS: usize = 32;

/// Header naming the destination of a raw-body `write_binary_file`: the
/// STANDARD base64 of the UTF-8 path (headers can't carry arbitrary text).
const PATH_HEADER: &str = "x-path";

/// Longest suggested name handed to the save dialog, in characters.
const MAX_DEFAULT_NAME_CHARS: usize = 120;

/// Replacing the target is tried this often, this far apart, while Windows
/// reports it busy (audit N4).
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(50);

/// Suggested extensions kept as they are; any other gets ".txt" appended.
/// The last five are what JSON Studio's code generator saves.
const SAVE_EXTENSIONS: [&str; 20] = [
    "txt", "json", "yaml", "yml", "csv", "tsv", "xml", "md", "xlsx", "env", "ini", "toml", "log",
    "diff", "patch", "ts", "cs", "java", "py", "go",
];

/// Path separators and the other characters Windows forbids in file names.
const FORBIDDEN_NAME_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// The one answer for a path that has no grant (never issued, issued for the
/// other operation, or already used). It must not reveal anything else.
const NOT_ISSUED: &str = "Path was not issued by a file dialog.";
const CHANGED: &str = "The selected file changed on disk. Pick it again.";
const BAD_REQUEST: &str = "Invalid file write request.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileOp {
    Read,
    Write,
}

/// One dialog-issued path, good for one operation.
struct Grant {
    /// The exact string handed to the webview — the lookup key.
    issued: String,
    /// The path exactly as the dialog returned it.
    path: PathBuf,
    /// Where it resolved when the user picked it.
    canonical: PathBuf,
    op: FileOp,
}

impl Grant {
    /// Whether this is the grant for exactly `issued` and `op`. A plain
    /// string comparison: nothing here touches the filesystem.
    fn is(&self, issued: &str, op: FileOp) -> bool {
        self.op == op && self.issued == issued
    }
}

#[derive(Default)]
struct Grants(Vec<Grant>);

impl Grants {
    fn issue(&mut self, grant: Grant) {
        self.0.retain(|g| !g.is(&grant.issued, grant.op));
        if self.0.len() >= MAX_GRANTS {
            self.0.remove(0);
        }
        self.0.push(grant);
    }

    /// Remove and return the grant for exactly `issued` and `op`.
    fn consume(&mut self, issued: &str, op: FileOp) -> Option<Grant> {
        let index = self.0.iter().position(|g| g.is(issued, op))?;
        Some(self.0.remove(index))
    }
}

/// Grants issued by the dialogs and not used yet.
#[derive(Default)]
pub struct AuthorizedPaths(Mutex<Grants>);

impl AuthorizedPaths {
    fn issue(&self, grant: Grant) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Internal state unavailable".to_string())?
            .issue(grant);
        Ok(())
    }

    fn consume(&self, issued: &str, op: FileOp) -> Result<Grant, String> {
        self.0
            .lock()
            .ok()
            .and_then(|mut grants| grants.consume(issued, op))
            .ok_or_else(|| NOT_ISSUED.to_string())
    }
}

/// Run filesystem work on the blocking pool — never on the main (UI)
/// thread, nor on an async worker (audit M7).
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Canonical form for a file that is about to be written: the parent must
/// exist and canonicalize; the file itself may not exist yet.
fn canonical_for_write(path: &Path) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("Path has no parent directory.")?;
    let name = path.file_name().ok_or("Path has no file name.")?;
    let parent = fs::canonicalize(parent)
        .map_err(|e| format!("Could not resolve the target directory: {e}"))?;
    Ok(parent.join(name))
}

/// A harmless name to suggest in the save dialog (audit L2): the final path
/// component only, without control or forbidden characters, at most 120
/// characters, and ending in ".txt" unless its extension is one we save.
fn clean_default_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control() && !FORBIDDEN_NAME_CHARS.contains(c))
        .collect();
    // Windows drops trailing dots and spaces from names.
    let cleaned = cleaned.trim();
    let cleaned = cleaned.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    let (stem, extension) = match cleaned.rsplit_once('.') {
        Some((stem, ext)) if SAVE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) => {
            (stem, Some(ext))
        }
        _ => (cleaned, None),
    };
    if stem.is_empty() && extension.is_none() {
        return "untitled.txt".to_string();
    }
    let suffix = match extension {
        Some(ext) => format!(".{ext}"),
        None => ".txt".to_string(),
    };
    let budget = MAX_DEFAULT_NAME_CHARS.saturating_sub(suffix.chars().count());
    let stem: String = stem.chars().take(budget).collect();
    format!("{stem}{suffix}")
}

/// Read at most `cap` bytes; `None` when there is more. Bounded while
/// reading, so a file that grows after a size check can't exhaust memory
/// (audit L3).
fn read_at_most(reader: impl Read, cap: u64) -> std::io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader.take(cap.saturating_add(1)).read_to_end(&mut bytes)?;
    Ok(if bytes.len() as u64 > cap {
        None
    } else {
        Some(bytes)
    })
}

fn read_granted(grant: &Grant) -> Result<String, String> {
    let canonical =
        fs::canonicalize(&grant.path).map_err(|e| format!("Could not resolve file: {e}"))?;
    if canonical != grant.canonical {
        return Err(CHANGED.into());
    }
    if !fs::metadata(&canonical).is_ok_and(|meta| meta.is_file()) {
        return Err("Selected path is not a regular file.".into());
    }
    let file = File::open(&canonical).map_err(|e| format!("Could not open file: {e}"))?;
    let bytes = read_at_most(file, MAX_READ_BYTES)
        .map_err(|e| format!("Could not read file: {e}"))?
        .ok_or_else(|| {
            format!("File is too large. Maximum supported size is {MAX_READ_BYTES} bytes.")
        })?;
    String::from_utf8(bytes).map_err(|e| format!("Could not read file as UTF-8 text: {e}"))
}

fn check_write_size(len: usize) -> Result<(), String> {
    if len > MAX_WRITE_BYTES {
        Err(format!("Refusing to write {len} bytes (limit {MAX_WRITE_BYTES} bytes)."))
    } else {
        Ok(())
    }
}

/// Write to a temporary file in the target's directory, flush it to disk,
/// then rename it over the target (audit L4): a crash or a full disk leaves
/// the previous file intact instead of a truncated one. `rename` replaces
/// an existing file on Windows too.
///
/// Audit N4: on Unix the temporary file starts readable by the owner only
/// and takes over the permissions of the file it replaces, so saving never
/// widens who can read a file. Where no file may be added to the folder
/// (one the user can write files in but not create them in, or one macOS
/// privacy controls guard), the target is overwritten in place instead.
fn write_atomic(target: &Path, contents: &[u8]) -> Result<(), String> {
    let dir = target.parent().ok_or("Path has no parent directory.")?;
    let mut random = [0u8; 9];
    getrandom::getrandom(&mut random).map_err(|_| "Could not write file.".to_string())?;
    let temp = dir.join(format!(".coretools-{}.tmp", URL_SAFE_NO_PAD.encode(random)));
    let result = match create_temp(&temp) {
        Ok(file) => {
            let replaced = fill_and_replace(file, &temp, target, contents);
            if replaced.is_err() {
                let _ = fs::remove_file(&temp);
            }
            replaced
        }
        Err(e) if e.kind() == ErrorKind::PermissionDenied => write_in_place(target, contents),
        Err(e) => Err(e),
    };
    result.map_err(|e| format!("Could not write file: {e}"))
}

/// A new temporary file; on Unix readable and writable by the owner only.
fn create_temp(temp: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(temp)
}

fn fill_and_replace(
    mut file: File,
    temp: &Path,
    target: &Path,
    contents: &[u8],
) -> std::io::Result<()> {
    file.write_all(contents)?;
    file.flush()?;
    keep_permissions(&file, target)?;
    file.sync_all()?;
    // Closed before the rename: Windows can't rename a file that is open.
    drop(file);
    rename_over(temp, target)
}

/// Give the new file the permissions of the one it replaces (Unix). A new
/// file keeps the owner-only mode it was created with.
#[cfg(unix)]
fn keep_permissions(file: &File, target: &Path) -> std::io::Result<()> {
    match fs::metadata(target) {
        Ok(existing) => file.set_permissions(existing.permissions()),
        Err(_) => Ok(()),
    }
}

#[cfg(not(unix))]
fn keep_permissions(_file: &File, _target: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Rename `temp` over `target`. On Windows a virus scanner, the search
/// indexer or a sync client (OneDrive) briefly holding the target open
/// makes the rename fail, so it is retried a few times first (audit N4).
fn rename_over(temp: &Path, target: &Path) -> std::io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(temp, target) {
            Err(e) if attempt < RENAME_ATTEMPTS && busy(&e) => {
                attempt += 1;
                std::thread::sleep(RENAME_RETRY_DELAY);
            }
            result => return result,
        }
    }
}

/// Whether a failed rename may work when retried: access denied, or a
/// sharing or lock violation (Windows).
#[cfg(windows)]
fn busy(error: &std::io::Error) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    let code = error.raw_os_error();
    error.kind() == ErrorKind::PermissionDenied
        || code == Some(ERROR_SHARING_VIOLATION)
        || code == Some(ERROR_LOCK_VIOLATION)
}

#[cfg(not(windows))]
fn busy(_error: &std::io::Error) -> bool {
    false
}

/// Overwrite the target in place — not crash-safe, so only for folders no
/// temporary file can be created in (audit N4). Never through a link: the
/// user picked the link itself, not where it points.
fn write_in_place(target: &Path, contents: &[u8]) -> std::io::Result<()> {
    if fs::symlink_metadata(target).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(std::io::Error::new(ErrorKind::PermissionDenied, "the file is a link"));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(target)?;
    file.write_all(contents)?;
    file.flush()?;
    file.sync_all()
}

fn write_granted(grant: &Grant, contents: &[u8]) -> Result<(), String> {
    let canonical = canonical_for_write(&grant.path)?;
    if canonical != grant.canonical {
        return Err(CHANGED.into());
    }
    write_atomic(&canonical, contents)
}

/// The path in a `write_binary_file` request's `x-path` header.
fn decode_path_header(value: &str) -> Option<String> {
    if value.len() > 64 * 1024 {
        return None;
    }
    let bytes = STANDARD.decode(value.trim()).ok()?;
    String::from_utf8(bytes).ok()
}

/// Show the native open-dialog and grant the picked file one read.
/// Runs the blocking dialog off the main thread. Returns None on cancel.
#[tauri::command]
pub async fn pick_open_path(
    app: tauri::AppHandle,
    paths: State<'_, AuthorizedPaths>,
) -> Result<Option<String>, String> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_file())
            .await
            .map_err(|e| e.to_string())?;

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let resolve = path.clone();
    let canonical = blocking(move || {
        fs::canonicalize(resolve).map_err(|e| format!("Could not resolve the selected file: {e}"))
    })
    .await?;

    let issued = path.to_string_lossy().into_owned();
    paths.issue(Grant {
        issued: issued.clone(),
        path,
        canonical,
        op: FileOp::Read,
    })?;
    Ok(Some(issued))
}

/// Show the native save-dialog and grant the chosen path one write.
#[tauri::command]
pub async fn pick_save_path(
    app: tauri::AppHandle,
    paths: State<'_, AuthorizedPaths>,
    default_name: String,
) -> Result<Option<String>, String> {
    let suggested = clean_default_name(&default_name);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(suggested)
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let resolve = path.clone();
    let canonical = blocking(move || canonical_for_write(&resolve)).await?;

    let issued = path.to_string_lossy().into_owned();
    paths.issue(Grant {
        issued: issued.clone(),
        path,
        canonical,
        op: FileOp::Write,
    })?;
    Ok(Some(issued))
}

/// Read a user-selected text file into a string.
///
/// `path` must be a string `pick_open_path` returned (single use). On top:
/// still the same file, a regular file, size cap, UTF-8 only.
#[tauri::command]
pub async fn read_text_file(
    paths: State<'_, AuthorizedPaths>,
    path: String,
) -> Result<String, String> {
    let grant = paths.consume(&path, FileOp::Read)?;
    blocking(move || read_granted(&grant)).await
}

/// Write `contents` to a destination `pick_save_path` returned (single use,
/// size-capped, atomic).
#[tauri::command]
pub async fn write_text_file(
    paths: State<'_, AuthorizedPaths>,
    path: String,
    contents: String,
) -> Result<(), String> {
    check_write_size(contents.len())?;
    let grant = paths.consume(&path, FileOp::Write)?;
    blocking(move || write_granted(&grant, contents.as_bytes())).await
}

/// The bytes of a `write_binary_file` request, size-capped. Normally the
/// raw IPC body; where Tauri falls back to its postMessage IPC the same
/// bytes arrive as a JSON array of numbers (audit N5), whose length is
/// checked before anything is copied.
fn request_bytes(body: &InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        InvokeBody::Raw(bytes) => {
            check_write_size(bytes.len())?;
            Ok(bytes.clone())
        }
        InvokeBody::Json(serde_json::Value::Array(items)) => {
            check_write_size(items.len())?;
            items
                .iter()
                .map(|item| item.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect::<Option<Vec<u8>>>()
                .ok_or_else(|| BAD_REQUEST.to_string())
        }
        InvokeBody::Json(_) => Err(BAD_REQUEST.into()),
    }
}

/// Binary counterpart of `write_text_file` (e.g. .xlsx exports). The bytes
/// travel as the raw IPC body — a JSON number array was ~4× their size —
/// and the destination in the `x-path` header (base64 of the UTF-8 path).
/// Same trust model: dialog-issued path, single use, size cap, atomic.
#[tauri::command]
pub async fn write_binary_file(
    paths: State<'_, AuthorizedPaths>,
    request: Request<'_>,
) -> Result<(), String> {
    let contents = request_bytes(request.body())?;
    let path = request
        .headers()
        .get(PATH_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(decode_path_header)
        .ok_or_else(|| BAD_REQUEST.to_string())?;
    let grant = paths.consume(&path, FileOp::Write)?;
    blocking(move || write_granted(&grant, &contents)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(issued: &str, op: FileOp) -> Grant {
        Grant {
            issued: issued.into(),
            path: PathBuf::from(issued),
            canonical: PathBuf::from(issued),
            op,
        }
    }

    /// A fresh empty directory under the system temp dir.
    fn scratch_dir() -> PathBuf {
        let mut random = [0u8; 9];
        getrandom::getrandom(&mut random).unwrap();
        let name = format!("coretools-files-test-{}", URL_SAFE_NO_PAD.encode(random));
        let dir = std::env::temp_dir().join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_grant_serves_only_its_own_operation_once() {
        let mut grants = Grants::default();
        grants.issue(grant("/home/me/a.yaml", FileOp::Read));
        assert!(grants.consume("/home/me/a.yaml", FileOp::Write).is_none());
        assert!(grants.consume("/home/me/a.yaml", FileOp::Read).is_some());
        assert!(grants.consume("/home/me/a.yaml", FileOp::Read).is_none());
    }

    #[test]
    fn read_and_write_grants_for_one_path_are_separate() {
        let mut grants = Grants::default();
        grants.issue(grant("C:\\out.json", FileOp::Read));
        grants.issue(grant("C:\\out.json", FileOp::Write));
        assert!(grants.consume("C:\\out.json", FileOp::Write).is_some());
        assert!(grants.consume("C:\\out.json", FileOp::Write).is_none());
        assert!(grants.consume("C:\\out.json", FileOp::Read).is_some());
    }

    #[test]
    fn matches_the_issued_string_exactly() {
        let issued = "C:\\Users\\me\\a.txt";
        let mut grants = Grants::default();
        grants.issue(grant(issued, FileOp::Read));
        for other in [
            "c:\\users\\me\\a.txt",
            "C:/Users/me/a.txt",
            "\\\\?\\C:\\Users\\me\\a.txt",
            "C:\\Users\\me\\.\\a.txt",
        ] {
            assert!(grants.consume(other, FileOp::Read).is_none(), "{other}");
        }
        assert!(grants.consume(issued, FileOp::Read).is_some());
    }

    #[test]
    fn refuses_unissued_network_and_device_paths_without_touching_them() {
        let paths = AuthorizedPaths::default();
        for path in [
            "\\\\attacker.example\\share\\x.txt",
            "\\\\?\\UNC\\attacker.example\\share\\x.txt",
            "\\\\.\\pipe\\x",
            "//attacker.example/share/x.txt",
        ] {
            for op in [FileOp::Read, FileOp::Write] {
                let refused = paths.consume(path, op).err();
                assert_eq!(refused.as_deref(), Some(NOT_ISSUED), "{path}");
            }
        }
    }

    #[test]
    fn keeps_a_bounded_number_of_grants() {
        let mut grants = Grants::default();
        for i in 0..(MAX_GRANTS + 8) {
            grants.issue(grant(&format!("/tmp/{i}.txt"), FileOp::Read));
        }
        assert_eq!(grants.0.len(), MAX_GRANTS);
        assert!(grants.consume("/tmp/0.txt", FileOp::Read).is_none());
        let newest = format!("/tmp/{}.txt", MAX_GRANTS + 7);
        assert!(grants.consume(&newest, FileOp::Read).is_some());
    }

    #[test]
    fn reissuing_a_path_replaces_its_grant() {
        let mut grants = Grants::default();
        grants.issue(grant("/tmp/a.txt", FileOp::Read));
        grants.issue(grant("/tmp/a.txt", FileOp::Read));
        assert_eq!(grants.0.len(), 1);
    }

    #[test]
    fn cleans_suggested_save_names() {
        assert_eq!(clean_default_name("report.json"), "report.json");
        assert_eq!(clean_default_name("Report.XLSX"), "Report.XLSX");
        assert_eq!(clean_default_name(".env"), ".env");
        assert_eq!(clean_default_name("../../etc/passwd"), "passwd.txt");
        assert_eq!(clean_default_name("C:\\Windows\\evil.yaml"), "evil.yaml");
        assert_eq!(clean_default_name("run.exe"), "run.exe.txt");
        assert_eq!(clean_default_name("setup.bat"), "setup.bat.txt");
        assert_eq!(clean_default_name("link.lnk"), "link.lnk.txt");
        assert_eq!(clean_default_name("root.ts"), "root.ts");
        assert_eq!(clean_default_name("a\u{0}b\nc:d?.csv"), "abcd.csv");
        assert_eq!(clean_default_name("notes.md. . "), "notes.md");
        assert_eq!(clean_default_name("no-extension"), "no-extension.txt");
        assert_eq!(clean_default_name(""), "untitled.txt");
        assert_eq!(clean_default_name("dir/"), "untitled.txt");
        assert_eq!(clean_default_name("..."), "untitled.txt");
    }

    #[test]
    fn caps_suggested_save_names() {
        let long = format!("{}.json", "x".repeat(500));
        let cleaned = clean_default_name(&long);
        assert_eq!(cleaned.chars().count(), MAX_DEFAULT_NAME_CHARS);
        assert!(cleaned.ends_with(".json"));
        let cleaned = clean_default_name(&"é".repeat(500));
        assert_eq!(cleaned.chars().count(), MAX_DEFAULT_NAME_CHARS);
        assert!(cleaned.ends_with(".txt"));
    }

    #[test]
    fn reads_are_capped_while_reading() {
        let data = [7u8; 100];
        let all = read_at_most(&data[..], 100).unwrap();
        assert_eq!(all.map(|bytes| bytes.len()), Some(100));
        assert_eq!(read_at_most(&data[..], 99).unwrap(), None);
        assert_eq!(read_at_most(&data[..0], 10).unwrap(), Some(Vec::new()));
    }

    #[test]
    fn decodes_the_path_header() {
        let encoded = STANDARD.encode("C:\\Users\\me\\Données\\out.xlsx");
        assert_eq!(
            decode_path_header(&encoded).as_deref(),
            Some("C:\\Users\\me\\Données\\out.xlsx")
        );
        assert_eq!(decode_path_header("not base64!"), None);
        assert_eq!(decode_path_header(&STANDARD.encode([0xffu8, 0xfe])), None);
        assert_eq!(decode_path_header(&"A".repeat(70_000)), None);
    }

    #[test]
    fn refuses_oversized_writes() {
        assert!(check_write_size(MAX_WRITE_BYTES).is_ok());
        assert!(check_write_size(MAX_WRITE_BYTES + 1).is_err());
    }

    #[test]
    fn takes_the_bytes_as_a_raw_body_or_a_json_array() {
        let raw = InvokeBody::Raw(vec![1, 2, 255]);
        assert_eq!(request_bytes(&raw).unwrap(), [1, 2, 255]);
        // Tauri's postMessage IPC sends the same bytes as numbers (N5).
        let json = InvokeBody::Json(serde_json::json!([1, 2, 255]));
        assert_eq!(request_bytes(&json).unwrap(), [1, 2, 255]);
        for bad in [
            serde_json::json!([1, 256]),
            serde_json::json!([1, -1]),
            serde_json::json!([1.5]),
            serde_json::json!(["1"]),
            serde_json::json!({ "0": 1 }),
            serde_json::json!(null),
        ] {
            let refused = request_bytes(&InvokeBody::Json(bad)).err();
            assert_eq!(refused.as_deref(), Some(BAD_REQUEST));
        }
    }

    #[test]
    fn writes_atomically_and_leaves_no_temporary_files() {
        let dir = scratch_dir();
        let target = dir.join("out.txt");
        write_atomic(&target, b"first").unwrap();
        write_atomic(&target, b"second, longer").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second, longer");
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("out.txt")]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_write_cleans_up_its_temporary_file() {
        let dir = scratch_dir();
        // Renaming a file over a non-empty directory fails on every platform.
        let target = dir.join("occupied");
        fs::create_dir_all(target.join("inside")).unwrap();
        assert!(write_atomic(&target, b"data").is_err());
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("occupied")]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_save_keeps_the_files_permissions_and_a_new_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let dir = scratch_dir();
        let target = dir.join("out.txt");
        write_atomic(&target, b"new").unwrap();
        assert_eq!(mode(&target), 0o600);
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        write_atomic(&target, b"replaced").unwrap();
        assert_eq!(mode(&target), 0o640);
        assert_eq!(fs::read(&target).unwrap(), b"replaced");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn saves_in_place_where_no_file_can_be_added() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir();
        let target = dir.join("out.txt");
        fs::write(&target, "old").unwrap();
        // The file may be written, but the folder takes no new files.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let written = write_atomic(&target, b"new");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        written.unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn retries_while_the_target_is_briefly_held_open() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = scratch_dir();
        let target = dir.join("out.txt");
        fs::write(&target, "old").unwrap();
        // Held open without sharing, as a virus scanner might, for 50 ms.
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(held);
        });
        write_atomic(&target, b"new").unwrap();
        release.join().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_file_that_moved_since_it_was_picked() {
        let dir = scratch_dir();
        let picked = dir.join("picked.txt");
        let other = dir.join("other.txt");
        fs::write(&picked, "picked").unwrap();
        fs::write(&other, "other").unwrap();

        let mut swapped = grant(&picked.to_string_lossy(), FileOp::Read);
        swapped.canonical = fs::canonicalize(&other).unwrap();
        assert_eq!(read_granted(&swapped).err().as_deref(), Some(CHANGED));

        let mut genuine = grant(&picked.to_string_lossy(), FileOp::Read);
        genuine.canonical = fs::canonicalize(&picked).unwrap();
        assert_eq!(read_granted(&genuine).unwrap(), "picked");

        let mut write = grant(&picked.to_string_lossy(), FileOp::Write);
        write.canonical = canonical_for_write(&other).unwrap();
        assert_eq!(write_granted(&write, b"x").err().as_deref(), Some(CHANGED));
        assert_eq!(fs::read_to_string(&picked).unwrap(), "picked");
        fs::remove_dir_all(&dir).unwrap();
    }
}
