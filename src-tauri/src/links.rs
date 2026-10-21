//! Where the webview may send the user: the system browser, or nowhere.
//!
//! `open_external_url` opens saved login pages and help links in the
//! system browser. A compromised page could otherwise use it to smuggle
//! data out in a URL (audit S-7 / M3, N3), so beyond accepting only plain
//! http(s) URLs:
//!
//! - only this project's GitHub pages (the release notes and downloads)
//!   open directly, and only without a query string or fragment, which
//!   could carry data. Google's sign-in page is not among them: its OAuth
//!   `state` parameter would be a ready-made channel;
//! - any other link needs the user's OK in a native dialog drawn by this
//!   process, which shows the link itself (its first 200 characters). The
//!   OK covers that exact link for the session — not its site, so data
//!   can't ride along in another URL on a site the user allowed once;
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

/// GitHub opens without asking only within this project's account.
const GITHUB_HOST: &str = "github.com";
const GITHUB_OWNER_PATH: &str = "/jaychandra1/";
const MAX_URL_LEN: usize = 2048;
/// Longest part of a link the confirmation dialog shows, in characters.
const MAX_SHOWN_CHARS: usize = 200;
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

/// Per-session link state: links the user confirmed, and the rate limit.
#[derive(Default)]
pub struct ExternalLinks {
    confirmed_links: Mutex<HashSet<String>>,
    rate: Mutex<OpenRate>,
    asking: AtomicBool,
}

impl ExternalLinks {
    /// Whether the user already confirmed exactly this link.
    fn is_confirmed(&self, link: &str) -> bool {
        self.confirmed_links
            .lock()
            .is_ok_and(|links| links.contains(link))
    }
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

/// Whether a URL opens without asking: a page of this project's GitHub
/// account, with no query or fragment that could carry data (audit N3).
fn trusted_without_asking(url: &Url) -> bool {
    // The parser has already resolved dot segments, so the owner prefix
    // can't be escaped with `/jaychandra1/../`.
    url.scheme() == "https"
        && url.port().is_none()
        && url.host_str() == Some(GITHUB_HOST)
        && url.path().starts_with(GITHUB_OWNER_PATH)
        && url.query().is_none()
        && url.fragment().is_none()
}

/// The link as the confirmation dialog shows it: the parser's ASCII form
/// (an international host in punycode), cut after 200 characters.
fn shown_link(url: &Url) -> String {
    let text = url.as_str();
    match text.char_indices().nth(MAX_SHOWN_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
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

    // Confirmations are per exact link (audit N3): one for a site's login
    // page doesn't let a query string or another path through unasked.
    let link = parsed.as_str().to_string();
    let known = trusted_without_asking(&parsed) || links.is_confirmed(&link);
    if !known {
        // One dialog at a time; a second request meanwhile is dropped.
        if links.asking.swap(true, Ordering::SeqCst) {
            return Err("canceled".into());
        }
        let shown = shown_link(&parsed);
        let question = format!("Open this link in your browser?\n\n{shown}");
        let confirmed = crate::confirm(&app, "Open link", question, "Open").await;
        links.asking.store(false, Ordering::SeqCst);
        if !confirmed {
            return Err("canceled".into());
        }
        if let Ok(mut confirmed_links) = links.confirmed_links.lock() {
            confirmed_links.insert(link);
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
        assert!(!is_app_origin(
            "http",
            Some("tauri.localhost.evil.example"),
            None,
            false
        ));
        assert!(!is_app_origin(
            "http",
            Some("tauri.localhost"),
            Some(8080),
            false
        ));
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
            let own = is_app_origin(url.scheme(), url.host_str(), url.port(), dev);
            assert!(own, "{url}");
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
    fn opens_only_this_projects_github_pages_without_asking() {
        assert!(trusted("https://github.com/jaychandra1/artifacts/releases"));
        assert!(trusted(
            "https://github.com/jaychandra1/artifacts/releases/tag/x"
        ));
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
            // A query string or fragment could carry data out (audit N3).
            "https://github.com/jaychandra1/artifacts?data=x",
            "https://github.com/jaychandra1/artifacts?",
            "https://github.com/jaychandra1/artifacts#data",
            // Google's pages and the website ask too: OAuth's `state`
            // would carry anything (audit N3).
            "https://accounts.google.com/o/oauth2/v2/auth?state=data",
            "https://accounts.google.com/",
            "https://myaccount.google.com/connections",
            "https://support.google.com/accounts/answer/1",
            "https://coretools-chi.vercel.app/privacy.html",
            "https://accounts.google.com.evil.example/",
            "https://evil.example/?u=https://accounts.google.com/",
            "https://accounts.google.com@evil.example/",
        ] {
            assert!(!trusted(url), "{url}");
        }
    }

    #[test]
    fn the_dialog_shows_the_link_itself() {
        let short = Url::parse("https://example.com/a?b=c").unwrap();
        assert_eq!(shown_link(&short), "https://example.com/a?b=c");
        let long = Url::parse(&format!("https://example.com/?q={}", "a".repeat(500))).unwrap();
        let shown = shown_link(&long);
        assert_eq!(shown.chars().count(), MAX_SHOWN_CHARS + 1);
        assert!(shown.starts_with("https://example.com/?q=aaa") && shown.ends_with('…'));
        // An international host is shown in its ASCII form.
        let international = Url::parse("https://exämple.com/").unwrap();
        assert!(shown_link(&international).starts_with("https://xn--"));
    }

    #[test]
    fn a_confirmation_covers_only_that_exact_link() {
        let links = ExternalLinks::default();
        links
            .confirmed_links
            .lock()
            .unwrap()
            .insert("https://example.com/login".to_string());
        assert!(links.is_confirmed("https://example.com/login"));
        assert!(!links.is_confirmed("https://example.com/login?next=data"));
        assert!(!links.is_confirmed("https://example.com/other"));
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
