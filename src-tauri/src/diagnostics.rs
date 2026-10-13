//! A small local diagnostics log (audit F-16).
//!
//! Errors used to collapse into user-facing tokens with the cause thrown
//! away (every transport failure became "cloud_network"), so a support
//! request had nothing to go on. This keeps a rotating log in the app's log
//! directory — two files of at most 256 KiB — that the user can copy into a
//! support request from "About & diagnostics". Nothing leaves the device
//! unless the user copies it.
//!
//! What is recorded: a UTC timestamp, a source ("cloud", "ui", …) and a
//! short cause (an error class, an HTTP status, Google's error *reason*).
//! Never recorded: secrets, tokens, file contents, URLs, account names. The
//! callers pass causes only, and every line is stripped of control
//! characters and capped.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

const MAX_BYTES: u64 = 256 * 1024;
const MAX_LINE_CHARS: usize = 300;
const REPORT_LINES: usize = 200;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Resolve the log file under the app's log directory. Called once at setup.
pub fn init(app: &tauri::App) {
    if let Ok(dir) = app.path().app_log_dir() {
        if fs::create_dir_all(&dir).is_ok() {
            let _ = LOG_PATH.set(dir.join("diagnostics.log"));
        }
    }
}

fn clean(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (UTC).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn timestamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Append one line. Best effort: diagnostics must never break the app.
pub fn record(source: &str, cause: &str) {
    let Some(path) = LOG_PATH.get() else { return };
    let Ok(_guard) = WRITE_LOCK.lock() else { return };
    if fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!(
        "{}\t{}\t{}\n",
        timestamp(secs),
        clean(source, 24),
        clean(cause, MAX_LINE_CHARS)
    );
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// The webview records UI-side failures (error tokens, never content).
#[tauri::command]
pub fn diagnostics_record(source: String, cause: String) -> Result<(), String> {
    record(&format!("ui:{}", clean(&source, 16)), &cause);
    Ok(())
}

/// The newest lines of the log, oldest first, for "Copy diagnostics".
#[tauri::command]
pub fn diagnostics_report() -> Result<String, String> {
    let Some(path) = LOG_PATH.get() else {
        return Ok(String::new());
    };
    let older = fs::read_to_string(path.with_extension("log.1")).unwrap_or_default();
    let newer = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = older.lines().chain(newer.lines()).collect();
    let start = lines.len().saturating_sub(REPORT_LINES);
    Ok(lines[start..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(timestamp(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(timestamp(1_791_888_000), "2026-10-13T10:40:00Z");
    }

    #[test]
    fn strips_control_characters_and_caps_length() {
        assert_eq!(clean("a\nb\tc\u{7}", 10), "abc");
        assert_eq!(clean(&"x".repeat(500), 300).len(), 300);
    }
}
