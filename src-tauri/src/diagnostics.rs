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
//! characters and capped. The webview may add at most 30 lines a minute,
//! so a misbehaving page can't flush the useful lines out of the log.
//! Panics are recorded by source location, plus the message only when it
//! is a fixed string from the code.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::Manager;

const MAX_BYTES: u64 = 256 * 1024;
const MAX_LINE_CHARS: usize = 300;
const REPORT_LINES: usize = 200;
/// Lines the webview may record per minute; the rest are only counted.
const UI_RECORDS_PER_WINDOW: u32 = 30;
const UI_WINDOW: Duration = Duration::from_secs(60);
/// Longest panic payload kept (only `&'static str` payloads, from code).
const PANIC_MESSAGE_CHARS: usize = 120;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static UI_BUDGET: Mutex<UiBudget> = Mutex::new(UiBudget {
    window_start: None,
    used: 0,
    dropped: 0,
});

/// Fixed-window budget for UI records.
struct UiBudget {
    window_start: Option<Instant>,
    used: u32,
    dropped: u32,
}

impl UiBudget {
    /// `Some(n)` when a record may be written now — `n` lines were dropped
    /// in the previous window and should be summarised first — or `None`
    /// when this one is dropped.
    fn admit(&mut self, now: Instant) -> Option<u32> {
        let expired = match self.window_start {
            Some(start) => now.saturating_duration_since(start) >= UI_WINDOW,
            None => true,
        };
        let mut dropped_before = 0;
        if expired {
            dropped_before = std::mem::take(&mut self.dropped);
            self.window_start = Some(now);
            self.used = 0;
        }
        if self.used >= UI_RECORDS_PER_WINDOW {
            self.dropped = self.dropped.saturating_add(1);
            return None;
        }
        self.used += 1;
        Some(dropped_before)
    }
}

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
    // A panic elsewhere while holding the lock poisons it; logging goes on.
    let guard = WRITE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    append(&guard, source, cause);
}

/// Write one line; `_guard` proves the caller holds WRITE_LOCK.
fn append(_guard: &MutexGuard<'_, ()>, source: &str, cause: &str) {
    let Some(path) = LOG_PATH.get() else { return };
    if fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_BYTES) {
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

/// Record panics (audit observability): where, and a code-supplied message
/// at most. A formatted message could carry user data, so only static
/// `&str` payloads are kept. Then the previous hook runs as before.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|at| format!("{}:{}", at.file(), at.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| clean(text, PANIC_MESSAGE_CHARS))
            .unwrap_or_else(|| "(message withheld)".to_string());
        // Never block here: the panicking thread may hold the lock already.
        let guard = match WRITE_LOCK.try_lock() {
            Ok(guard) => Some(guard),
            Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        };
        if let Some(guard) = guard {
            append(&guard, "panic", &format!("{location} {message}"));
        }
        previous(info);
    }));
}

/// Run log file I/O on the blocking pool, never on the main (UI) thread
/// (audit M7).
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "diagnostics_unavailable".to_string())
}

/// One UI line, rate-limited (see `diagnostics_record`).
fn record_from_ui(source: &str, cause: &str) {
    let admitted = UI_BUDGET
        .lock()
        .ok()
        .and_then(|mut budget| budget.admit(Instant::now()));
    let Some(dropped) = admitted else {
        return;
    };
    if dropped > 0 {
        let summary = format!("{dropped} more UI lines dropped (rate limit)");
        record("ui", &summary);
    }
    record(&format!("ui:{}", clean(source, 16)), cause);
}

/// The webview records UI-side failures (error tokens, never content).
/// At most 30 lines a minute; drops are counted into one summary line.
#[tauri::command]
pub async fn diagnostics_record(source: String, cause: String) -> Result<(), String> {
    blocking(move || record_from_ui(&source, &cause)).await
}

/// The newest lines of the log, oldest first.
fn report() -> String {
    let Some(path) = LOG_PATH.get() else {
        return String::new();
    };
    let older = fs::read_to_string(path.with_extension("log.1")).unwrap_or_default();
    let newer = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = older.lines().chain(newer.lines()).collect();
    let start = lines.len().saturating_sub(REPORT_LINES);
    lines[start..].join("\n")
}

/// The newest lines of the log, oldest first, for "Copy diagnostics".
#[tauri::command]
pub async fn diagnostics_report() -> Result<String, String> {
    blocking(report).await
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

    #[test]
    fn rate_limits_ui_records_and_counts_the_drops() {
        let start = Instant::now();
        let mut budget = UiBudget {
            window_start: None,
            used: 0,
            dropped: 0,
        };
        for _ in 0..UI_RECORDS_PER_WINDOW {
            assert_eq!(budget.admit(start), Some(0));
        }
        for _ in 0..5 {
            assert_eq!(budget.admit(start + Duration::from_secs(59)), None);
        }
        // The next window reports the five dropped lines once.
        assert_eq!(budget.admit(start + UI_WINDOW), Some(5));
        assert_eq!(budget.admit(start + UI_WINDOW), Some(0));
    }
}
