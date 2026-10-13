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
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::header::CONTENT_TYPE;
use reqwest::{StatusCode, Url};
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

const KEYRING_SERVICE: &str = "io.coretools.authenticator.cloud";
const KEYRING_USER: &str = "google";

/// One series per module: 2FA accounts, and Credential Manager logins.
/// Nothing else in the app-data folder is listed, read or written.
const FILE_PREFIXES: [&str; 2] = ["coretools-authenticator-", "coretools-credmanager-"];
const FILE_FIELDS: &str = "id,name,createdTime,size,md5Checksum,appProperties";
/// Backups are a few KiB; anything near this is not ours.
const MAX_BACKUP_BYTES: usize = 5 * 1024 * 1024;
/// How long to wait for the user to finish signing in in the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

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
        if let Ok(mut guard) = self.access.lock() {
            // Treat it as expired a minute early so no request races expiry.
            let lifetime = Duration::from_secs(expires_in.saturating_sub(60).max(1));
            *guard = Some(AccessToken {
                token,
                expires_at: Instant::now() + lifetime,
            });
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
struct FileList {
    #[serde(default)]
    files: Vec<DriveFile>,
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

/// The one HTTPS client (rustls, https-only); also used by the update check.
pub(crate) fn http() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let built = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("CoreTools/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "cloud_network".to_string())?;
    Ok(CLIENT.get_or_init(|| built))
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
        let body = response.text().await.unwrap_or_default();
        // invalid_grant: access revoked, password changed, or token aged out.
        return Err(if body.contains("invalid_grant") {
            "cloud_auth_revoked".into()
        } else if body.contains("invalid_client") {
            "cloud_not_configured".into()
        } else {
            status_error(status, &body)
        });
    }
    let tokens: TokenResponse = response
        .json()
        .await
        .map_err(|_| "cloud_unavailable".to_string())?;
    state.set_token(tokens.access_token.clone(), tokens.expires_in.unwrap_or(3600));
    Ok(tokens.access_token)
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
        let body = response.text().await.unwrap_or_default();
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

fn handle_redirect(mut stream: TcpStream, expected_state: &str) -> Redirect {
    // Accepted sockets can inherit non-blocking mode (Windows); read with a
    // timeout instead so a silent client can't stall the flow.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    while buffer.len() < 16 * 1024 && !buffer.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    }

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
            Ok((stream, _)) => match handle_redirect(stream, expected_state) {
                Redirect::Code(code) => return Ok(code),
                Redirect::Denied => return Err("oauth_denied".into()),
                Redirect::Ignored => {}
            },
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
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
    let tokens: TokenResponse = response
        .json()
        .await
        .map_err(|_| "oauth_exchange_failed".to_string())?;

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

/// Forget the credential locally, then revoke it at Google (best effort —
/// offline or already revoked is fine; the local copy is gone either way).
#[tauri::command]
pub async fn cloud_disconnect(state: tauri::State<'_, CloudState>) -> Result<(), String> {
    let credential = load_credential().ok().flatten();
    state.clear_token();
    delete_credential()?;
    if let (Some(credential), Ok(client)) = (credential, http()) {
        let _ = client
            .post(REVOKE_ENDPOINT)
            .form(&[("token", credential.refresh_token.as_str())])
            .send()
            .await;
    }
    Ok(())
}

/// List the backup versions in the app-data folder (newest first).
#[tauri::command]
pub async fn cloud_list(state: tauri::State<'_, CloudState>) -> Result<Vec<RemoteFile>, String> {
    let fields = format!("files({FILE_FIELDS})");
    let response = drive_send(state.inner(), |client, token| {
        client.get(FILES_ENDPOINT).bearer_auth(token).query(&[
            ("spaces", "appDataFolder"),
            ("q", "trashed = false"),
            ("orderBy", "createdTime desc"),
            ("pageSize", "100"),
            ("fields", fields.as_str()),
        ])
    })
    .await?;
    let list: FileList = response
        .json()
        .await
        .map_err(|_| "cloud_unavailable".to_string())?;
    Ok(list
        .files
        .into_iter()
        .filter(|file| is_backup_name(&file.name))
        .map(RemoteFile::from)
        .collect())
}

/// Upload one (already end-to-end encrypted) backup version.
#[tauri::command]
pub async fn cloud_upload(
    state: tauri::State<'_, CloudState>,
    name: String,
    content: String,
    device_id: String,
    device_label: String,
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
    let file: DriveFile = response
        .json()
        .await
        .map_err(|_| "cloud_unavailable".to_string())?;
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
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BACKUP_BYTES as u64)
    {
        return Err("cloud_too_large".into());
    }
    let bytes = response.bytes().await.map_err(net_error)?;
    if bytes.len() > MAX_BACKUP_BYTES {
        return Err("cloud_too_large".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "cloud_corrupt".to_string())
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
