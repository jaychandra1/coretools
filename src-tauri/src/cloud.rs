//! Google Drive transport for the Authenticator's optional cloud backup.
//!
//! Everything network-related lives HERE, not in the webview:
//!   - Google sign-in is the OAuth 2.0 authorization-code flow with PKCE in
//!     the user's own browser, redirected back to a one-shot loopback
//!     listener (RFC 8252) — the app never sees the Google password;
//!   - the refresh token is kept in the OS keychain (Windows Credential
//!     Manager / macOS Keychain / Secret Service) and never crosses IPC;
//!   - every HTTP request is made by this module, to fixed Google endpoints.
//!
//! The webview keeps its no-network CSP. It can only ask for a fixed set of
//! operations on the connected account's private `appDataFolder` — a hidden
//! per-app folder; the granted `drive.appdata` scope cannot see any other
//! Drive content — and the only content it hands over is the backup it has
//! already encrypted end-to-end. Tokens are never accepted FROM the webview,
//! so a compromised page couldn't redirect uploads to another account either.
//!
//! Errors are stable string tokens ("cloud_network", "oauth_canceled", …)
//! that the frontend maps to messages. Provider responses are never echoed.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::header::CONTENT_TYPE;
use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// OAuth client of type "Desktop app", injected at build time (see
/// DEPLOYMENT.md). Google documents installed-app client secrets as not
/// confidential; PKCE is what protects the authorization code.
const CLIENT_ID: Option<&str> = option_env!("CORETOOLS_GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("CORETOOLS_GOOGLE_CLIENT_SECRET");

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
const FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";

/// Drive access confined to this app's own hidden folder.
const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata";
/// `openid email` only to show which account is connected.
const SCOPES: &str = "openid email https://www.googleapis.com/auth/drive.appdata";

/// Renaming these orphans existing sign-ins, and the Windows uninstaller
/// deletes the entry by name (installer/hooks.nsh) — change both together.
const KEYRING_SERVICE: &str = "io.coretools.authenticator.cloud";
const KEYRING_USER: &str = "google";

/// One series per module: 2FA accounts, and Credential Manager logins.
/// Nothing else in the app-data folder is listed, read or written.
const FILE_PREFIXES: [&str; 2] = ["coretools-authenticator-", "coretools-credmanager-"];
const FILE_FIELDS: &str = "id,name,createdTime,size,md5Checksum,appProperties";
/// Backups are a few KiB; anything near this is not ours.
const MAX_BACKUP_BYTES: usize = 5 * 1024 * 1024;
/// One page of the file list (≤ 100 entries of a few hundred bytes).
const MAX_LIST_BYTES: usize = 1024 * 1024;
/// Token responses, upload results and error bodies.
const MAX_SMALL_BODY_BYTES: usize = 64 * 1024;
/// The list follows `nextPageToken` at most this many times.
const MAX_LIST_PAGES: usize = 20;
/// How long to wait for the user to finish signing in in the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Longest one loopback connection may take to deliver its request; a
/// client that connects and stalls can't hold the sign-in up (audit L5).
const CONNECTION_DEADLINE: Duration = Duration::from_secs(10);
/// Each blocking read waits at most this long, so a cancel or the sign-in
/// deadline ends even a read from a silent connection promptly.
const READ_SLICE: Duration = Duration::from_millis(250);
/// Longest an access token is cached, whatever `expires_in` says (audit L6).
const MAX_TOKEN_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
/// Disconnecting waits at most this long for Google to revoke the grant.
const REVOKE_TIMEOUT: Duration = Duration::from_secs(5);

// ---- state ---------------------------------------------------------------------

struct AccessToken {
    token: String,
    expires_at: Instant,
}

/// Short-lived access token cache and sign-in coordination. The refresh
/// token is NOT held here — it is read from the keychain when needed.
#[derive(Default)]
pub struct CloudState {
    access: Mutex<Option<AccessToken>>,
    cancel: Arc<AtomicBool>,
    connecting: AtomicBool,
}

impl CloudState {
    fn cached_token(&self) -> Option<String> {
        let guard = self.access.lock().ok()?;
        guard
            .as_ref()
            .filter(|t| t.expires_at > Instant::now())
            .map(|t| t.token.clone())
    }

    fn set_token(&self, token: String, expires_in: u64) {
        let Some(expires_at) = Instant::now().checked_add(token_lifetime(expires_in)) else {
            return; // not cached: the next request refreshes it
        };
        if let Ok(mut guard) = self.access.lock() {
            *guard = Some(AccessToken { token, expires_at });
        }
    }

    fn clear_token(&self) {
        if let Ok(mut guard) = self.access.lock() {
            *guard = None;
        }
    }
}

// ---- wire types ----------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccount {
    email: String,
    device_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    id: String,
    name: String,
    created_time: String,
    size: u64,
    md5_checksum: String,
    device_id: String,
    device_label: String,
    /// How many entries the backup holds, as its uploader declared
    /// (audit D-5) — shown before restoring. None for older backups.
    records: Option<u32>,
}

#[derive(Serialize, Deserialize)]
struct StoredCredential {
    refresh_token: String,
    email: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    scope: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFile {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    created_time: String,
    size: Option<String>,
    #[serde(default)]
    md5_checksum: String,
    #[serde(default)]
    app_properties: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileList {
    #[serde(default)]
    files: Vec<DriveFile>,
    #[serde(default)]
    next_page_token: Option<String>,
}

/// The `records` app property: a plain decimal count, or None.
fn parse_records(value: Option<&str>) -> Option<u32> {
    let value = value?.trim();
    if value.is_empty() || value.len() > 10 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

impl From<DriveFile> for RemoteFile {
    fn from(file: DriveFile) -> Self {
        RemoteFile {
            size: file.size.and_then(|s| s.parse().ok()).unwrap_or(0),
            device_id: file.app_properties.get("deviceId").cloned().unwrap_or_default(),
            device_label: file
                .app_properties
                .get("deviceLabel")
                .cloned()
                .unwrap_or_default(),
            records: parse_records(file.app_properties.get("records").map(String::as_str)),
            id: file.id,
            name: file.name,
            created_time: file.created_time,
            md5_checksum: file.md5_checksum,
        }
    }
}

// ---- helpers -------------------------------------------------------------------

fn client_id() -> Result<&'static str, String> {
    match CLIENT_ID {
        Some(id) if !id.trim().is_empty() => Ok(id),
        _ => Err("cloud_not_configured".into()),
    }
}

fn client_secret() -> Option<&'static str> {
    CLIENT_SECRET.filter(|secret| !secret.trim().is_empty())
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("CoreTools/", env!("CARGO_PKG_VERSION")))
}

/// The one HTTPS client (rustls, https-only); also used by the update check.
/// Trusts the bundled Mozilla roots plus the OS trust store, so networks
/// that inspect TLS with a root the OS trusts work (audit L11). Should the
/// OS store be unreadable, it falls back to the bundled roots alone.
pub(crate) fn http() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let built = match client_builder().build() {
        Ok(client) => client,
        Err(_) => {
            crate::diagnostics::record("cloud", "OS trust store unusable; bundled roots only");
            client_builder()
                .tls_built_in_native_certs(false)
                .build()
                .map_err(|_| "cloud_network".to_string())?
        }
    };
    Ok(CLIENT.get_or_init(|| built))
}

/// Why a size-capped body read stopped.
pub(crate) enum BodyError {
    TooLarge,
    Network(reqwest::Error),
}

/// Append `chunk` unless that would make `body` exceed `cap`.
fn append_capped(body: &mut Vec<u8>, chunk: &[u8], cap: usize) -> bool {
    if body.len().saturating_add(chunk.len()) > cap {
        return false;
    }
    body.extend_from_slice(chunk);
    true
}

/// Read a response body chunk by chunk, refusing as soon as it exceeds
/// `cap` — never buffering an oversized body first (audit L3).
pub(crate) async fn read_capped(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, BodyError> {
    if response.content_length().is_some_and(|length| length > cap as u64) {
        return Err(BodyError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(BodyError::Network)? {
        if !append_capped(&mut body, &chunk, cap) {
            return Err(BodyError::TooLarge);
        }
    }
    Ok(body)
}

/// A capped JSON body; None (recorded in diagnostics) when it can't be read.
async fn read_json<T: DeserializeOwned>(response: reqwest::Response, cap: usize) -> Option<T> {
    let parsed = match read_capped(response, cap).await {
        Ok(body) => serde_json::from_slice(&body).ok(),
        Err(BodyError::TooLarge) => None,
        Err(BodyError::Network(error)) => {
            crate::diagnostics::record("cloud", &error_class(&error));
            None
        }
    };
    if parsed.is_none() {
        crate::diagnostics::record("cloud", "unreadable response body");
    }
    parsed
}

/// A capped error body as text (empty when unreadable).
async fn read_error_text(response: reqwest::Response) -> String {
    read_capped(response, MAX_SMALL_BODY_BYTES)
        .await
        .map(|body| String::from_utf8_lossy(&body).into_owned())
        .unwrap_or_default()
}

/// URL-safe random string from the OS CSPRNG (PKCE verifier, CSRF state…).
fn random_token(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).map_err(|_| "oauth_listen_failed".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

/// Timeouts, DNS failures, refused connections, TLS errors: all "can't reach".
fn net_error(error: reqwest::Error) -> String {
    crate::diagnostics::record("cloud", &error_class(&error));
    "cloud_network".into()
}

/// A transport failure's class for the diagnostics log — never its URL.
pub(crate) fn error_class(error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_decode() {
        "decode"
    } else if error.is_body() {
        "body"
    } else if error.is_request() {
        "request"
    } else {
        "other"
    };
    match error.status() {
        Some(status) => format!("network {kind} (http {})", status.as_u16()),
        None => format!("network {kind}"),
    }
}

/// The `reason` codes in a Google API error body:
/// `{"error":{"errors":[{"domain":"usageLimits","reason":"userRateLimitExceeded"}]}}`.
fn error_reasons(body: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|json| {
            json.get("error")?.get("errors")?.as_array().map(|errors| {
                errors
                    .iter()
                    .filter_map(|e| e.get("reason")?.as_str().map(str::to_owned))
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// Map an HTTP failure to a stable token. Google uses 403 for very different
/// things (storage full, rate limits, missing scope, admin policy), so a 403
/// is classified by the error's structured `reason`, never by a substring.
/// An unrecognised 403 is reported as such — never as revoked access, which
/// would stop backups and push every user to reconnect.
fn status_error(status: StatusCode, body: &str) -> String {
    let reasons = error_reasons(body);
    crate::diagnostics::record(
        "cloud",
        &format!("http {} {}", status.as_u16(), reasons.join(",")),
    );
    let has = |wanted: &[&str]| reasons.iter().any(|r| wanted.contains(&r.as_str()));
    match status.as_u16() {
        401 => "cloud_auth_revoked".into(),
        403 if has(&["storageQuotaExceeded"]) => "cloud_quota".into(),
        403 if has(&["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"]) => {
            "cloud_unavailable".into()
        }
        403 if has(&["domainPolicy"]) => "cloud_domain_policy".into(),
        403 if has(&["insufficientPermissions", "insufficientScopes", "authError"]) => {
            "cloud_auth_revoked".into()
        }
        404 => "cloud_not_found".into(),
        408 | 429 | 500..=599 => "cloud_unavailable".into(),
        code => format!("cloud_http_{code}"),
    }
}

/// Strip control characters and cap the UTF-8 length (Drive limits each
/// appProperties key+value pair to 124 bytes).
fn clean_label(value: &str, max_bytes: usize) -> String {
    let mut out = String::new();
    for c in value.chars().filter(|c| !c.is_control()) {
        if out.len() + c.len_utf8() > max_bytes {
            break;
        }
        out.push(c);
    }
    out.trim().to_string()
}

fn is_backup_name(name: &str) -> bool {
    FILE_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

fn validate_name(name: &str) -> Result<(), String> {
    let ok = is_backup_name(name)
        && name.ends_with(".json")
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if ok {
        Ok(())
    } else {
        Err("cloud_invalid_request".into())
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
    if ok {
        Ok(())
    } else {
        Err("cloud_invalid_request".into())
    }
}

/// This computer's name, used only to label the backups it uploads.
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|name| clean_label(&name, 60))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| {
            match std::env::consts::OS {
                "windows" => "Windows PC",
                "macos" => "Mac",
                _ => "Linux PC",
            }
            .to_string()
        })
}

/// The `email` claim of an ID token. It came straight from Google's token
/// endpoint over TLS, so (OIDC Core §3.1.3.7) the signature needn't be
/// re-verified — and it is only used as a display label.
fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("email")?.as_str().map(str::to_owned)
}

// ---- keychain ------------------------------------------------------------------

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "cloud_keychain_unavailable".to_string())
}

fn load_credential() -> Result<Option<StoredCredential>, String> {
    match keyring_entry()?.get_password() {
        Ok(json) => Ok(serde_json::from_str(&json).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("cloud_keychain_unavailable".into()),
    }
}

fn store_credential(credential: &StoredCredential) -> Result<(), String> {
    let json =
        serde_json::to_string(credential).map_err(|_| "cloud_keychain_unavailable".to_string())?;
    keyring_entry()?
        .set_password(&json)
        .map_err(|_| "cloud_keychain_unavailable".to_string())
}

fn delete_credential() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("cloud_keychain_unavailable".into()),
    }
}

// ---- tokens --------------------------------------------------------------------

async fn access_token(state: &CloudState) -> Result<String, String> {
    if let Some(token) = state.cached_token() {
        return Ok(token);
    }
    let credential = load_credential()?.ok_or("cloud_not_connected")?;
    let client_id = client_id()?;
    let mut form = vec![
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", credential.refresh_token.as_str()),
    ];
    if let Some(secret) = client_secret() {
        form.push(("client_secret", secret));
    }

    let response = http()?
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(net_error)?;
    let status = response.status();
    if !status.is_success() {
        let body = read_error_text(response).await;
        // invalid_grant: access revoked, password changed, or token aged out.
        return Err(if body.contains("invalid_grant") {
            "cloud_auth_revoked".into()
        } else if body.contains("invalid_client") {
            "cloud_not_configured".into()
        } else {
            status_error(status, &body)
        });
    }
    let tokens: TokenResponse = read_json(response, MAX_SMALL_BODY_BYTES)
        .await
        .ok_or("cloud_unavailable")?;
    state.set_token(tokens.access_token.clone(), tokens.expires_in.unwrap_or(3600));
    Ok(tokens.access_token)
}

/// How long to cache an access token: a minute short of `expires_in`, so
/// no request races expiry, and never more than a day — a huge value from
/// the server can't overflow `Instant` arithmetic (audit L6).
fn token_lifetime(expires_in: u64) -> Duration {
    Duration::from_secs(expires_in.saturating_sub(60).max(1)).min(MAX_TOKEN_LIFETIME)
}

/// Send a Drive request with the current access token, refreshing it once
/// if Google rejects it as expired.
async fn drive_send<F>(state: &CloudState, build: F) -> Result<reqwest::Response, String>
where
    F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
{
    let client = http()?;
    for attempt in 0..2 {
        let token = access_token(state).await?;
        let response = build(client, &token).send().await.map_err(net_error)?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED && attempt == 0 {
            state.clear_token();
            continue;
        }
        if status.is_success() {
            return Ok(response);
        }
        let body = read_error_text(response).await;
        return Err(status_error(status, &body));
    }
    Err("cloud_auth_revoked".into())
}

// ---- sign-in -------------------------------------------------------------------

/// Hand a URL to the OS default browser.
pub(crate) fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(url).spawn();

    let mut child = spawned.map_err(|_| "oauth_browser_failed".to_string())?;
    // Reap the launcher so it doesn't linger as a zombie on Unix.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

const PAGE_SUCCESS: &str =
    "<h1>Google account connected</h1><p>You can close this tab and return to CoreTools.</p>";
const PAGE_DENIED: &str =
    "<h1>Sign-in canceled</h1><p>CoreTools was not connected. You can close this tab.</p>";
const PAGE_STALE: &str =
    "<h1>This sign-in link has expired</h1><p>Start again from CoreTools.</p>";

fn respond(stream: &mut TcpStream, status: u16, message: &str) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>CoreTools</title>\
         <style>body{{font-family:system-ui,sans-serif;display:grid;place-items:center;\
         min-height:90vh;margin:0;background:#f6f7f9;color:#1c2530}}\
         main{{max-width:420px;text-align:center;padding:24px}}h1{{font-size:20px}}</style>\
         </head><body><main>{message}</main></body></html>"
    );
    let length = body.len();
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {length}\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n{body}"
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// What one request to the loopback listener amounted to.
enum Redirect {
    Code(String),
    Denied,
    Ignored,
}

/// When one connection must have delivered its request: `CONNECTION_DEADLINE`
/// from now, but never after the sign-in itself times out.
fn connection_deadline(now: Instant, sign_in_deadline: Instant) -> Instant {
    now.checked_add(CONNECTION_DEADLINE)
        .map_or(sign_in_deadline, |deadline| deadline.min(sign_in_deadline))
}

/// The request head of one loopback connection, or None when the client
/// stalled past its deadline or the sign-in was canceled meanwhile.
fn read_request_head(
    stream: &mut TcpStream,
    cancel: &AtomicBool,
    sign_in_deadline: Instant,
) -> Option<Vec<u8>> {
    // Accepted sockets can inherit non-blocking mode (Windows); read in
    // short timed slices instead, so a silent or trickling client is dropped
    // at its deadline and a cancel is noticed mid-read.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(READ_SLICE));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let deadline = connection_deadline(Instant::now(), sign_in_deadline);
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    while buffer.len() < 16 * 1024 && !buffer.windows(4).any(|w| w == b"\r\n\r\n") {
        if cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(_) => break,
        }
    }
    Some(buffer)
}

fn handle_redirect(
    mut stream: TcpStream,
    expected_state: &str,
    cancel: &AtomicBool,
    sign_in_deadline: Instant,
) -> Redirect {
    let Some(buffer) = read_request_head(&mut stream, cancel, sign_in_deadline) else {
        return Redirect::Ignored; // dropped without an answer
    };

    let request = String::from_utf8_lossy(&buffer);
    let target = request.lines().next().and_then(|line| {
        let mut parts = line.split_whitespace();
        match (parts.next(), parts.next()) {
            (Some("GET"), Some(target)) if target.starts_with('/') => Some(target.to_string()),
            _ => None,
        }
    });
    let Some(target) = target else {
        respond(&mut stream, 400, "Bad request");
        return Redirect::Ignored;
    };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        respond(&mut stream, 400, "Bad request");
        return Redirect::Ignored;
    };
    if url.path() != "/" {
        respond(&mut stream, 404, "Not found"); // e.g. /favicon.ico
        return Redirect::Ignored;
    }

    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    if params.get("state").map(String::as_str) != Some(expected_state) {
        // Not this flow (stale tab, other local software): keep waiting.
        respond(&mut stream, 400, PAGE_STALE);
        return Redirect::Ignored;
    }
    if let Some(code) = params.get("code").filter(|code| !code.is_empty()) {
        respond(&mut stream, 200, PAGE_SUCCESS);
        return Redirect::Code(code.clone());
    }
    respond(&mut stream, 200, PAGE_DENIED);
    Redirect::Denied
}

/// Block until the browser comes back with an authorization code (or the
/// user denies, cancels in the app, or the sign-in times out).
fn wait_for_code(
    listener: TcpListener,
    expected_state: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("oauth_listen_failed: {e}"))?;
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("oauth_canceled".into());
        }
        if Instant::now() >= deadline {
            return Err("oauth_timeout".into());
        }
        match listener.accept() {
            Ok((stream, _)) => match handle_redirect(stream, expected_state, cancel, deadline) {
                Redirect::Code(code) => return Ok(code),
                Redirect::Denied => return Err("oauth_denied".into()),
                Redirect::Ignored => {}
            },
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("oauth_listen_failed: {e}")),
        }
    }
}

async fn sign_in(state: &CloudState, client_id: &'static str) -> Result<CloudAccount, String> {
    // RFC 8252 §7.3: loopback IP literal on an ephemeral port picked by the OS.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("oauth_listen_failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("oauth_listen_failed: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    // PKCE (RFC 7636, S256) + CSRF state.
    let verifier = random_token(32)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let csrf_state = random_token(16)?;

    let auth_url = Url::parse_with_params(
        AUTH_ENDPOINT,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", csrf_state.as_str()),
            ("access_type", "offline"),
            // Always offer the account picker, and re-consent so Google
            // issues a refresh token on every connect.
            ("prompt", "select_account consent"),
        ],
    )
    .map_err(|_| "oauth_listen_failed".to_string())?;
    open_browser(auth_url.as_str())?;

    let cancel = Arc::clone(&state.cancel);
    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_code(listener, &csrf_state, &cancel)
    })
    .await
    .map_err(|_| "oauth_canceled".to_string())??;

    let mut form = vec![
        ("client_id", client_id),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri.as_str()),
    ];
    if let Some(secret) = client_secret() {
        form.push(("client_secret", secret));
    }
    let response = http()?
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(net_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("oauth_exchange_failed: {}", status.as_u16()));
    }
    let tokens: TokenResponse = read_json(response, MAX_SMALL_BODY_BYTES)
        .await
        .ok_or("oauth_exchange_failed")?;

    // Google's granular consent lets the user untick Drive access; without
    // it nothing can be backed up, so refuse instead of failing later.
    let granted = tokens.scope.as_deref().unwrap_or_default();
    if !granted.split(' ').any(|scope| scope == DRIVE_SCOPE) {
        return Err("oauth_scope_denied".into());
    }
    let refresh_token = tokens.refresh_token.ok_or("oauth_no_refresh_token")?;
    let email = tokens
        .id_token
        .as_deref()
        .and_then(email_from_id_token)
        .unwrap_or_default();

    store_credential(&StoredCredential {
        refresh_token,
        email: email.clone(),
    })?;
    state.set_token(tokens.access_token, tokens.expires_in.unwrap_or(3600));
    Ok(CloudAccount {
        email,
        device_name: device_name(),
    })
}

// ---- commands ------------------------------------------------------------------

/// Whether this build has a Google OAuth client configured.
#[tauri::command]
pub fn cloud_available() -> bool {
    client_id().is_ok()
}

/// The connected account, from the keychain. Never touches the network.
#[tauri::command]
pub async fn cloud_status() -> Result<Option<CloudAccount>, String> {
    if client_id().is_err() {
        return Ok(None);
    }
    Ok(load_credential()?.map(|credential| CloudAccount {
        email: credential.email,
        device_name: device_name(),
    }))
}

/// Run Google sign-in in the system browser and store the credential.
#[tauri::command]
pub async fn cloud_connect(state: tauri::State<'_, CloudState>) -> Result<CloudAccount, String> {
    let client_id = client_id()?;
    if state.connecting.swap(true, Ordering::SeqCst) {
        return Err("cloud_busy".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let result = sign_in(state.inner(), client_id).await;
    state.connecting.store(false, Ordering::SeqCst);
    result
}

/// Abort a sign-in that is waiting for the browser.
#[tauri::command]
pub fn cloud_cancel_connect(state: tauri::State<'_, CloudState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Ask Google to revoke the grant. True when it is gone: revoked now, or
/// already invalid (Google answers 400 `invalid_token`).
async fn revoke_at_google(refresh_token: &str) -> bool {
    let Ok(client) = http() else { return false };
    let sent = client
        .post(REVOKE_ENDPOINT)
        .timeout(REVOKE_TIMEOUT)
        .form(&[("token", refresh_token)])
        .send()
        .await;
    match sent {
        Ok(response) if response.status().is_success() => true,
        Ok(response) if response.status() == StatusCode::BAD_REQUEST => {
            read_error_text(response).await.contains("invalid_token")
        }
        Ok(response) => {
            let status = response.status().as_u16();
            crate::diagnostics::record("cloud", &format!("revoke http {status}"));
            false
        }
        Err(error) => {
            crate::diagnostics::record("cloud", &format!("revoke {}", error_class(&error)));
            false
        }
    }
}

/// Revoke the grant at Google first (best effort, a few seconds at most),
/// then forget the credential locally — always, whether or not revoking
/// worked. Returns whether Google confirmed the revocation; when it
/// didn't (offline, Google unreachable), the UI should tell the user to
/// remove CoreTools' access at myaccount.google.com.
#[tauri::command]
pub async fn cloud_disconnect(state: tauri::State<'_, CloudState>) -> Result<bool, String> {
    let credential = load_credential().ok().flatten();
    let revoked = match &credential {
        Some(credential) => revoke_at_google(&credential.refresh_token).await,
        None => true, // nothing stored, nothing to revoke
    };
    if !revoked {
        crate::diagnostics::record("cloud", "revoke failed; local sign-in removed anyway");
    }
    state.clear_token();
    delete_credential()?;
    Ok(revoked)
}

/// List the backup versions in the app-data folder (newest first),
/// following `nextPageToken` (audit L7) up to `MAX_LIST_PAGES` pages.
#[tauri::command]
pub async fn cloud_list(state: tauri::State<'_, CloudState>) -> Result<Vec<RemoteFile>, String> {
    let fields = format!("nextPageToken,files({FILE_FIELDS})");
    let mut files = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_LIST_PAGES {
        let response = drive_send(state.inner(), |client, token| {
            let request = client.get(FILES_ENDPOINT).bearer_auth(token).query(&[
                ("spaces", "appDataFolder"),
                ("q", "trashed = false"),
                ("orderBy", "createdTime desc"),
                ("pageSize", "100"),
                ("fields", fields.as_str()),
            ]);
            match page_token.as_deref() {
                Some(page) => request.query(&[("pageToken", page)]),
                None => request,
            }
        })
        .await?;
        let list: FileList = read_json(response, MAX_LIST_BYTES)
            .await
            .ok_or("cloud_unavailable")?;
        files.extend(
            list.files
                .into_iter()
                .filter(|file| is_backup_name(&file.name))
                .map(RemoteFile::from),
        );
        match list.next_page_token {
            Some(next) if !next.is_empty() => page_token = Some(next),
            _ => return Ok(files),
        }
    }
    crate::diagnostics::record("cloud", "backup list truncated at the page limit");
    Ok(files)
}

/// Upload one (already end-to-end encrypted) backup version. `records` is
/// how many entries it holds, kept in the file's `appProperties` so the
/// version list can show it without downloading (audit D-5).
#[tauri::command]
pub async fn cloud_upload(
    state: tauri::State<'_, CloudState>,
    name: String,
    content: String,
    device_id: String,
    device_label: String,
    records: u32,
) -> Result<RemoteFile, String> {
    validate_name(&name)?;
    if content.is_empty() || content.len() > MAX_BACKUP_BYTES {
        return Err("cloud_too_large".into());
    }
    let metadata = serde_json::json!({
        "name": name,
        "parents": ["appDataFolder"],
        "mimeType": "application/json",
        "appProperties": {
            "kind": "coretools-authenticator-backup",
            "deviceId": clean_label(&device_id, 64),
            "deviceLabel": clean_label(&device_label, 100),
            "records": records.to_string(),
        },
    });
    let boundary = format!("coretools-{}", random_token(18)?);
    if content.contains(&boundary) {
        return Err("cloud_integrity".into()); // astronomically unlikely
    }
    let body = format!(
        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n\
         --{boundary}\r\nContent-Type: application/json\r\n\r\n{content}\r\n--{boundary}--\r\n"
    );
    let content_type = format!("multipart/related; boundary={boundary}");

    let response = drive_send(state.inner(), |client, token| {
        client
            .post(UPLOAD_ENDPOINT)
            .bearer_auth(token)
            .query(&[("uploadType", "multipart"), ("fields", FILE_FIELDS)])
            .header(CONTENT_TYPE, content_type.as_str())
            .body(body.clone())
    })
    .await?;
    let file: DriveFile = read_json(response, MAX_SMALL_BODY_BYTES)
        .await
        .ok_or("cloud_unavailable")?;
    Ok(RemoteFile::from(file))
}

/// Download one backup version's content.
#[tauri::command]
pub async fn cloud_download(
    state: tauri::State<'_, CloudState>,
    id: String,
) -> Result<String, String> {
    validate_id(&id)?;
    let url = format!("{FILES_ENDPOINT}/{id}");
    let response = drive_send(state.inner(), |client, token| {
        client
            .get(url.as_str())
            .bearer_auth(token)
            .query(&[("alt", "media")])
    })
    .await?;
    let bytes = read_capped(response, MAX_BACKUP_BYTES)
        .await
        .map_err(|error| match error {
            BodyError::TooLarge => "cloud_too_large".to_string(),
            BodyError::Network(error) => net_error(error),
        })?;
    String::from_utf8(bytes).map_err(|_| "cloud_corrupt".to_string())
}

/// Delete one backup version. Already-gone counts as success.
#[tauri::command]
pub async fn cloud_delete(state: tauri::State<'_, CloudState>, id: String) -> Result<(), String> {
    validate_id(&id)?;
    let url = format!("{FILES_ENDPOINT}/{id}");
    match drive_send(state.inner(), |client, token| {
        client.delete(url.as_str()).bearer_auth(token)
    })
    .await
    {
        Ok(_) => Ok(()),
        Err(e) if e == "cloud_not_found" => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_appendix_b() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    // The Windows uninstaller deletes this keychain entry by name
    // (installer/hooks.nsh); keyring stores it as "<user>.<service>".
    #[test]
    fn uninstaller_hook_deletes_this_keychain_entry() {
        let hooks = include_str!("../installer/hooks.nsh");
        let target = format!("w \"{KEYRING_USER}.{KEYRING_SERVICE}\"");
        assert!(hooks.contains(&target), "installer/hooks.nsh must delete {target}");
    }

    #[test]
    fn reads_email_from_id_token() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"email":"me@example.com","sub":"1"}"#);
        let token = format!("eyJhbGciOiJSUzI1NiJ9.{payload}.signature");
        assert_eq!(email_from_id_token(&token).as_deref(), Some("me@example.com"));
        assert_eq!(email_from_id_token("garbage"), None);
    }

    #[test]
    fn validates_names_and_ids() {
        assert!(validate_name("coretools-authenticator-20261011T103000123Z-1a2b3c4d.json").is_ok());
        assert!(validate_name("coretools-credmanager-20261011T103000123Z-1a2b3c4d.json").is_ok());
        assert!(validate_name("coretools-credmanager-../x.json").is_err());
        assert!(validate_name("other.json").is_err());
        assert!(validate_name("coretools-authenticator-../x.json").is_err());
        assert!(validate_id("1AbC_d-9").is_ok());
        assert!(validate_id("../files").is_err());
        assert!(validate_id("").is_err());
    }

    #[test]
    fn reads_record_counts_defensively() {
        assert_eq!(parse_records(Some("12")), Some(12));
        assert_eq!(parse_records(Some(" 0 ")), Some(0));
        assert_eq!(parse_records(Some("4294967295")), Some(u32::MAX));
        for bad in ["", "-1", "+5", "1.5", "abc", "4294967296", "99999999999"] {
            assert_eq!(parse_records(Some(bad)), None, "{bad}");
        }
        assert_eq!(parse_records(None), None);
    }

    #[test]
    fn maps_drive_files_with_and_without_record_counts() {
        let json = br#"{"files":[
            {"id":"a","name":"coretools-authenticator-1.json","size":"10",
             "appProperties":{"deviceId":"d","deviceLabel":"PC","records":"7"}},
            {"id":"b","name":"coretools-credmanager-1.json"}],
            "nextPageToken":"page-2"}"#;
        let list: FileList = serde_json::from_slice(json).unwrap();
        assert_eq!(list.next_page_token.as_deref(), Some("page-2"));
        let files: Vec<RemoteFile> = list.files.into_iter().map(RemoteFile::from).collect();
        assert_eq!(files[0].records, Some(7));
        assert_eq!(files[0].size, 10);
        assert_eq!(files[1].records, None);
        let last: FileList = serde_json::from_slice(br#"{"files":[]}"#).unwrap();
        assert!(last.next_page_token.is_none());
    }

    #[test]
    fn caps_token_lifetimes() {
        assert_eq!(token_lifetime(3600), Duration::from_secs(3540));
        assert_eq!(token_lifetime(0), Duration::from_secs(1));
        assert_eq!(token_lifetime(u64::MAX), MAX_TOKEN_LIFETIME);
        // The cache must never overflow, whatever the server sent.
        assert!(Instant::now().checked_add(token_lifetime(u64::MAX)).is_some());
        let state = CloudState::default();
        state.set_token("t".into(), u64::MAX);
        assert_eq!(state.cached_token().as_deref(), Some("t"));
    }

    #[test]
    fn caps_bodies_while_reading() {
        let mut body = Vec::new();
        assert!(append_capped(&mut body, &[1; 6], 10));
        assert!(append_capped(&mut body, &[2; 4], 10));
        assert!(!append_capped(&mut body, &[3], 10));
        assert_eq!(body.len(), 10);
    }

    #[test]
    fn loopback_connections_get_a_bounded_deadline() {
        let now = Instant::now();
        let far = now + Duration::from_secs(300);
        assert_eq!(connection_deadline(now, far), now + CONNECTION_DEADLINE);
        let near = now + Duration::from_secs(2);
        assert_eq!(connection_deadline(now, near), near);
    }

    #[test]
    fn a_stalled_loopback_client_is_dropped_on_cancel() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        // Connects and never sends anything.
        let _client = TcpStream::connect(address).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        let cancel = AtomicBool::new(true);
        let started = Instant::now();
        let far = started + Duration::from_secs(300);
        assert!(read_request_head(&mut stream, &cancel, far).is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn caps_labels_by_bytes() {
        assert_eq!(clean_label("  DESKTOP-1\n ", 60), "DESKTOP-1");
        assert!(clean_label(&"é".repeat(100), 100).len() <= 100);
    }

    #[test]
    fn maps_http_status_to_tokens() {
        assert_eq!(status_error(StatusCode::NOT_FOUND, ""), "cloud_not_found");
        assert_eq!(status_error(StatusCode::UNAUTHORIZED, ""), "cloud_auth_revoked");
        assert_eq!(status_error(StatusCode::TOO_MANY_REQUESTS, ""), "cloud_unavailable");
        assert_eq!(status_error(StatusCode::SERVICE_UNAVAILABLE, ""), "cloud_unavailable");
        assert_eq!(status_error(StatusCode::IM_A_TEAPOT, ""), "cloud_http_418");
    }

    /// A Google API error body carrying one `reason`.
    fn google_error(reason: &str) -> String {
        format!(
            r#"{{"error":{{"code":403,"message":"x","errors":[{{"domain":"usageLimits","reason":"{reason}","message":"x"}}]}}}}"#
        )
    }

    #[test]
    fn classifies_403_by_structured_reason() {
        let forbidden = |reason: &str| status_error(StatusCode::FORBIDDEN, &google_error(reason));
        // The audit's F-22: Google's per-user limit (capital R) is a retryable
        // rate limit, not revoked access.
        assert_eq!(forbidden("userRateLimitExceeded"), "cloud_unavailable");
        assert_eq!(forbidden("rateLimitExceeded"), "cloud_unavailable");
        assert_eq!(forbidden("dailyLimitExceeded"), "cloud_unavailable");
        assert_eq!(forbidden("storageQuotaExceeded"), "cloud_quota");
        assert_eq!(forbidden("insufficientPermissions"), "cloud_auth_revoked");
        assert_eq!(forbidden("domainPolicy"), "cloud_domain_policy");
        // Unknown or unparseable 403s are reported as such, never as revoked.
        assert_eq!(forbidden("somethingNew"), "cloud_http_403");
        assert_eq!(status_error(StatusCode::FORBIDDEN, "<html>Forbidden</html>"), "cloud_http_403");
    }
}
