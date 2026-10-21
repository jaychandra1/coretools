//! Where the webview may send the user: the system browser, or nowhere.
//!
//! `open_external_url` opens saved login pages and help links in the
//! system browser. A compromised page could otherwise use it to smuggle
//! data out in a URL (audit S-7 / M3), so beyond accepting only plain
//! http(s) URLs:
//!
//! - a short list of the app's own and Google's account pages opens
//!   directly;
//! - any other host needs the user's OK in a native dialog drawn by this
//!   process ("Open example.com in your browser?"), once per host and
//!   session;
//! - at most 10 links open per minute, so a page can't flood the browser
//!   or stack up dialogs.
//!
//! The navigation guard keeps the webview itself on the app's own pages:
//! any navigation to another origin is refused.

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;

/// Hosts opened without asking (https only).
const TRUSTED_HOSTS: [&str; 4] = [
    "coretools-chi.vercel.app",
    "myaccount.google.com",
    "support.google.com",
    "accounts.google.com",
];
/// GitHub opens without asking only within this project's account.
const GITHUB_HOST: &str = "github.com";
const GITHUB_OWNER_PATH: &str = "/jaychandra1/";
const MAX_URL_LEN: usize = 2048;
const MAX_OPENS_PER_WINDOW: usize = 10;
const OPEN_WINDOW: Duration = Duration::from_secs(60);
/// The dev server's port (tauri.conf.json → build.devUrl); debug builds only.
const DEV_SERVER_PORT: u16 = 1420;

/// Whether an origin is one the app's own pages are served from:
/// `tauri://localhost` (macOS, Linux), `http(s)://tauri.localhost`
/// (Windows), and in debug builds the Vite dev server.
pub fn is_app_origin(scheme: &str, host: Option<&str>, port: Option<u16>, dev: bool) -> bool {
    match (scheme, host, port) {
        ("tauri", Some("localhost"), None) => true,
        ("http" | "https", Some("tauri.localhost"), None) => true,
        ("http", Some("localhost"), Some(DEV_SERVER_PORT)) => dev,
        _ => false,
    }
}

/// Refuse every navigation of the webview away from the app's own pages.
/// Links never navigate it (they open in the system browser), so anything
/// else is an injected redirect or a stray form/link.
pub fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let allowed = is_app_origin(
                url.scheme(),
                url.host_str(),
                url.port(),
                cfg!(debug_assertions),
            );
            if !allowed {
                crate::diagnostics::record("navigation", "refused a navigation off the app");
            }
            allowed
        })
        .build()
}

/// Sliding-window limit on links opened.
#[derive(Default)]
struct OpenRate(VecDeque<Instant>);

impl OpenRate {
    fn allow(&mut self, now: Instant) -> bool {
        while let Some(&oldest) = self.0.front() {
            if now.saturating_duration_since(oldest) < OPEN_WINDOW {
                break;
            }
            self.0.pop_front();
        }
        if self.0.len() >= MAX_OPENS_PER_WINDOW {
            return false;
        }
        self.0.push_back(now);
        true
    }
}

/// Per-session link state: hosts the user confirmed, and the rate limit.
#[derive(Default)]
pub struct ExternalLinks {
    confirmed_hosts: Mutex<HashSet<String>>,
    rate: Mutex<OpenRate>,
    asking: AtomicBool,
}

/// An absolute http(s) URL with a host and no embedded credentials (which
/// would land on the browser's command line and in its history).
fn parse_external(url: &str) -> Result<Url, String> {
    if url.len() > MAX_URL_LEN {
        return Err("invalid_url".into());
    }
    let parsed = Url::parse(url).map_err(|_| "invalid_url".to_string())?;
    let plain = matches!(parsed.scheme(), "http" | "https")
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none();
    if plain {
        Ok(parsed)
    } else {
        Err("invalid_url".into())
    }
}

/// Whether a URL is on the fixed allow-list (no confirmation needed).
fn trusted_without_asking(url: &Url) -> bool {
    if url.scheme() != "https" || url.port().is_some() {
        return false;
    }
    match url.host_str() {
        // The parser has already resolved dot segments, so this prefix
        // can't be escaped with `/jaychandra1/../`.
        Some(GITHUB_HOST) => url.path().starts_with(GITHUB_OWNER_PATH),
        Some(host) => TRUSTED_HOSTS.contains(&host),
        None => false,
    }
}

/// Open a saved login page or help link in the system browser.
///
/// Errors: "invalid_url"; "open_rate_limited" (more than 10 per minute);
/// "canceled" (the user declined the dialog, or another one is open).
#[tauri::command]
pub async fn open_external_url(
    app: tauri::AppHandle,
    links: tauri::State<'_, ExternalLinks>,
    url: String,
) -> Result<(), String> {
    let parsed = parse_external(&url)?;
    let allowed = links
        .rate
        .lock()
        .map(|mut rate| rate.allow(Instant::now()))
        .unwrap_or(false);
    if !allowed {
        crate::diagnostics::record("links", "open_rate_limited");
        return Err("open_rate_limited".into());
    }

    let host = parsed.host_str().unwrap_or_default().to_string();
    let known = trusted_without_asking(&parsed)
        || links
            .confirmed_hosts
            .lock()
            .map(|hosts| hosts.contains(&host))
            .unwrap_or(false);
    if !known {
        // One dialog at a time; a second request meanwhile is dropped.
        if links.asking.swap(true, Ordering::SeqCst) {
            return Err("canceled".into());
        }
        let question = format!("Open {host} in your browser?");
        let confirmed = crate::confirm(&app, "Open link", question, "Open").await;
        links.asking.store(false, Ordering::SeqCst);
        if !confirmed {
            return Err("canceled".into());
        }
        if let Ok(mut hosts) = links.confirmed_hosts.lock() {
            hosts.insert(host);
        }
    }
    crate::cloud::open_browser(parsed.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trusted(url: &str) -> bool {
        trusted_without_asking(&Url::parse(url).unwrap())
    }

    #[test]
    fn recognises_only_the_apps_own_origins() {
        assert!(is_app_origin("tauri", Some("localhost"), None, false));
        assert!(is_app_origin("http", Some("tauri.localhost"), None, false));
        assert!(is_app_origin("https", Some("tauri.localhost"), None, false));
        assert!(is_app_origin("http", Some("localhost"), Some(1420), true));
        assert!(!is_app_origin("http", Some("localhost"), Some(1420), false));
        assert!(!is_app_origin("http", Some("localhost"), Some(8080), true));
        assert!(!is_app_origin("https", Some("evil.example"), None, true));
        assert!(!is_app_origin("http", Some("tauri.localhost.evil.example"), None, false));
        assert!(!is_app_origin("http", Some("tauri.localhost"), Some(8080), false));
        assert!(!is_app_origin("file", None, None, true));
        assert!(!is_app_origin("data", None, None, true));
    }

    #[test]
    fn app_urls_parse_to_app_origins() {
        for (url, dev) in [
            ("tauri://localhost/index.html", false),
            ("http://tauri.localhost/#/authenticator", false),
            ("http://localhost:1420/", true),
        ] {
            let url = Url::parse(url).unwrap();
            assert!(is_app_origin(url.scheme(), url.host_str(), url.port(), dev), "{url}");
        }
    }

    #[test]
    fn accepts_only_plain_http_urls() {
        assert!(parse_external("https://example.com/login").is_ok());
        assert!(parse_external("http://intranet.example/login").is_ok());
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "https://user:secret@example.com/",
            "https://user@example.com/",
            "not a url",
        ] {
            assert!(parse_external(url).is_err(), "{url}");
        }
        assert!(parse_external(&format!("https://example.com/{}", "a".repeat(2048))).is_err());
    }

    #[test]
    fn opens_the_fixed_allow_list_without_asking() {
        assert!(trusted("https://github.com/jaychandra1/artifacts/releases"));
        assert!(trusted("https://coretools-chi.vercel.app/privacy.html"));
        assert!(trusted("https://myaccount.google.com/connections"));
        assert!(trusted("https://support.google.com/accounts/answer/1"));
        assert!(trusted("https://accounts.google.com/"));
    }

    #[test]
    fn asks_for_everything_else() {
        for url in [
            "https://github.com/someone-else/repo",
            "https://github.com/jaychandra1/../someone-else/repo",
            "https://github.com/jaychandra1",
            "http://github.com/jaychandra1/artifacts",
            "https://github.com:8443/jaychandra1/artifacts",
            "https://gist.github.com/jaychandra1/x",
            "https://accounts.google.com.evil.example/",
            "https://evil.example/?u=https://accounts.google.com/",
            "https://accounts.google.com@evil.example/",
        ] {
            assert!(!trusted(url), "{url}");
        }
    }

    #[test]
    fn limits_opens_per_minute() {
        let start = Instant::now();
        let mut rate = OpenRate::default();
        for _ in 0..MAX_OPENS_PER_WINDOW {
            assert!(rate.allow(start));
        }
        assert!(!rate.allow(start + Duration::from_secs(30)));
        // A minute later the earlier opens have aged out.
        let later = start + OPEN_WINDOW;
        for _ in 0..MAX_OPENS_PER_WINDOW {
            assert!(rate.allow(later));
        }
        assert!(!rate.allow(later));
    }
}
