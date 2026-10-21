//! Update notifications (audit F-02) and in-app updates.
//!
//! `check_for_update` asks the public release index for the newest version —
//! only when the user turned notifications on, or clicked "Check now". The
//! URL is fixed here, the response is size-capped while it is read and
//! validated, and every link must point into the public release repository,
//! so a tampered index can't send users anywhere else. The index may also
//! stage a release (`rollout`, percent) and pace checks (`checkAfterHours`);
//! malformed values are ignored. The request carries no identifiers beyond
//! the app's User-Agent.
//!
//! `install_update` runs only when the user clicks "Update now" and then
//! confirms a native "Install CoreTools x.y.z and restart?" dialog: Tauri's
//! updater downloads this platform's build, verifies its minisign signature
//! against the public key compiled into the app (tauri.conf.json →
//! plugins.updater.pubkey, set by the release workflow) and installs it —
//! on Windows as an update (`/UPDATE`: the vault is kept) — then restarts.
//! Only a build signed with the release's private key installs, so a
//! compromised artifacts repository can't ship new code. Nor can it offer
//! an OLDER signed build under a newer version number (audit S-5): before
//! anything is downloaded, the file must come from that version's own
//! release (`…/download/coretools-v<version>/`), and its signature's trusted
//! comment must name a file of that version (`CoreTools_<version>_…`). The
//! trusted comment is covered by minisign's global signature, which the
//! updater verifies, so it can't be edited. It is read only where minisign
//! reads it — line 3 of the four-line signature file, by the same parser the
//! updater uses — never from the unsigned first line (audit N1). Builds
//! without a public key (local builds) have no updater; the UI then
//! downloads the installer instead.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::cloud::BodyError;

const LATEST_URL: &str =
    "https://raw.githubusercontent.com/jaychandra1/artifacts/main/coretools/releases/latest.json";
const RELEASE_PREFIX: &str = "https://github.com/jaychandra1/artifacts/releases/";
/// Direct asset downloads (a subset of RELEASE_PREFIX).
const DOWNLOAD_PREFIX: &str = "https://github.com/jaychandra1/artifacts/releases/download/";
const MAX_BYTES: usize = 64 * 1024;
/// Prefix of line 1 of a minisign signature file — the untrusted comment,
/// which no signature covers.
const UNTRUSTED_COMMENT_PREFIX: &str = "untrusted comment:";
/// Prefix of line 3 of a minisign signature file — the trusted comment.
const TRUSTED_COMMENT_PREFIX: &str = "trusted comment: ";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestJson {
    version: String,
    #[serde(default)]
    date: String,
    release_url: String,
    /// Optional one-line notice for installed copies (e.g. a security fix).
    #[serde(default)]
    notice: Option<String>,
    /// Marks a release that fixes a security issue.
    #[serde(default)]
    security: bool,
    #[serde(default)]
    assets: Vec<LatestAsset>,
    /// Staged rollout: the percentage of installs offered this release.
    /// Read leniently (any JSON value), validated in `validate`.
    #[serde(default)]
    rollout: Option<serde_json::Value>,
    /// Suggested hours between automatic checks.
    #[serde(default)]
    check_after_hours: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestAsset {
    name: String,
    #[serde(default)]
    versioned_url: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    date: String,
    release_url: String,
    notice: Option<String>,
    security: bool,
    /// This platform's installer, straight from the release (no page).
    download_url: Option<String>,
    /// 1–100, or None (offer to everyone).
    rollout: Option<u8>,
    /// 1–168, or None (the app's default schedule).
    check_after_hours: Option<u32>,
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 32
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        && version.split('.').count() == 3
}

/// A link into the public release repository: https on github.com under
/// `prefix`, nothing but plain path characters, and exactly as the URL
/// parser would write it — so `..`, `.` or `%2e%2e` segments, which the
/// parser resolves, can't climb out of the prefix (audit S-6 / M5).
fn safe_link(url: &str, prefix: &str) -> bool {
    if !url.starts_with(prefix)
        || url.len() > 300
        || !url
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/:.-_".contains(c))
    {
        return false;
    }
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("github.com")
        && parsed.port().is_none()
        && parsed.as_str() == url
}

/// The installer a user on `os` (std::env::consts::OS) downloads.
fn installer_name(os: &str) -> Option<&'static str> {
    match os {
        "windows" => Some("CoreTools-Windows-Setup.exe"),
        "macos" => Some("CoreTools-macOS.dmg"),
        "linux" => Some("CoreTools-Linux.AppImage"),
        _ => None,
    }
}

fn download_url_for(os: &str, assets: &[LatestAsset]) -> Option<String> {
    let name = installer_name(os)?;
    assets
        .iter()
        .find(|a| a.name == name && safe_link(&a.versioned_url, DOWNLOAD_PREFIX))
        .map(|a| a.versioned_url.clone())
}

/// An integer in `min..=max`; None when missing, of another type, or out
/// of range — an optional field must never block the update notice.
fn int_in_range(value: Option<&serde_json::Value>, min: u64, max: u64) -> Option<u64> {
    value
        .and_then(serde_json::Value::as_u64)
        .filter(|n| (min..=max).contains(n))
}

/// A notice as shown: no control characters, at most 300 characters.
fn clean_notice(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(300).collect()
}

fn validate(raw: LatestJson) -> Result<UpdateInfo, String> {
    let url_ok = safe_link(&raw.release_url, RELEASE_PREFIX);
    if !valid_version(&raw.version) || !url_ok {
        return Err("update_invalid".into());
    }
    let date_ok = raw.date.len() == 10 && raw.date.chars().all(|c| c.is_ascii_digit() || c == '-');
    let date = if date_ok { raw.date } else { String::new() };
    let notice = raw
        .notice
        .map(|text| clean_notice(&text))
        .filter(|text| !text.trim().is_empty());
    let download_url = download_url_for(std::env::consts::OS, &raw.assets);
    let rollout = int_in_range(raw.rollout.as_ref(), 1, 100).and_then(|n| u8::try_from(n).ok());
    let check_after_hours =
        int_in_range(raw.check_after_hours.as_ref(), 1, 168).and_then(|n| u32::try_from(n).ok());
    Ok(UpdateInfo {
        version: raw.version,
        date,
        release_url: raw.release_url,
        notice,
        security: raw.security,
        download_url,
        rollout,
        check_after_hours,
    })
}

/// The newest published release, as announced by the public index.
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let response = crate::cloud::http()
        .map_err(|_| "update_network".to_string())?
        .get(LATEST_URL)
        .send()
        .await
        .map_err(|e| {
            crate::diagnostics::record("updates", &crate::cloud::error_class(&e));
            "update_network".to_string()
        })?;
    if !response.status().is_success() {
        crate::diagnostics::record("updates", &format!("http {}", response.status().as_u16()));
        return Err("update_network".into());
    }
    let bytes = crate::cloud::read_capped(response, MAX_BYTES)
        .await
        .map_err(|error| match error {
            BodyError::TooLarge => "update_invalid".to_string(),
            BodyError::Network(e) => {
                crate::diagnostics::record("updates", &crate::cloud::error_class(&e));
                "update_network".to_string()
            }
        })?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "update_invalid".to_string())
        .and_then(validate)
}

// ---- in-app update ----------------------------------------------------------------

/// Whether this build carries an updater public key (release builds do).
pub struct UpdaterEnabled(pub bool);

/// The updater plugin needs a public key to verify against; without one
/// (local builds) it isn't registered at all.
pub fn updater_configured(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

/// Whether an update's download URL is a file in that version's own
/// release: `…/releases/download/coretools-v<version>/<file>`.
fn update_url_matches_version(url: &str, version: &str) -> bool {
    let prefix = format!("{DOWNLOAD_PREFIX}coretools-v{version}/");
    valid_version(version)
        && safe_link(url, &prefix)
        && url
            .get(prefix.len()..)
            .is_some_and(|file| !file.is_empty() && !file.contains('/'))
}

/// The trusted comment of a Tauri update signature (audit N1). The
/// manifest's `signature` is the base64 of the whole minisign signature
/// file, which has exactly four lines: `untrusted comment: …` (covered by
/// no signature — anyone can rewrite it), the signature, `trusted comment:
/// …` (covered by the global signature) and the global signature. Only that
/// layout is accepted, and the comment is taken from line 3 by the same
/// `minisign-verify` parser the updater checks the global signature with.
fn trusted_comment(signature: &str) -> Option<String> {
    let decoded = STANDARD.decode(signature.trim()).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let [untrusted, _, trusted, _] = lines.as_slice() else {
        return None;
    };
    if !untrusted.starts_with(UNTRUSTED_COMMENT_PREFIX)
        || !trusted.starts_with(TRUSTED_COMMENT_PREFIX)
    {
        return None;
    }
    let parsed = minisign_verify::Signature::decode(&text).ok()?;
    Some(parsed.trusted_comment().to_owned())
}

/// One `key:value` field of a trusted comment (tab-separated, e.g.
/// `timestamp:1700000000\tfile:CoreTools_1.2.7_x64-setup.exe`).
fn comment_field<'a>(comment: &'a str, key: &str) -> Option<&'a str> {
    comment.split('\t').find_map(|f| f.strip_prefix(key))
}

/// Whether the signature was made for `version`: its signed file name
/// contains `_<version>_` (the release pipeline signs
/// `CoreTools_<version>_<target>.<ext>`), or it carries a signed
/// `version:` field equal to it. A signed version that differs refuses.
fn signed_for_version(signature: &str, version: &str) -> bool {
    let Some(comment) = trusted_comment(signature) else {
        return false;
    };
    let signed_version = comment_field(&comment, "version:").map(|v| v.trim_start_matches('v'));
    if signed_version.is_some_and(|signed| signed != version) {
        return false;
    }
    let marker = format!("_{version}_");
    let versioned_file = comment_field(&comment, "file:").is_some_and(|f| f.contains(&marker));
    versioned_file || signed_version == Some(version)
}

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum InstallProgress {
    Downloading { downloaded: u64, total: Option<u64> },
    Installing,
}

/// Download, verify and install the newest release, then restart. Errors:
/// "update_unavailable" (no updater in this build), "update_none" (no signed
/// update published for this platform), "update_network", "update_canceled"
/// (the user declined the confirmation), "update_failed" (not this
/// version's file, or download, signature or install failed).
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    enabled: tauri::State<'_, UpdaterEnabled>,
    on_progress: Channel<InstallProgress>,
) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    if !enabled.0 {
        return Err("update_unavailable".into());
    }
    let updater = app.updater().map_err(|_| "update_unavailable".to_string())?;
    let update = updater.check().await.map_err(|_| {
        crate::diagnostics::record("updates", "updater check failed");
        "update_network".to_string()
    })?;
    let Some(update) = update else {
        return Err("update_none".into());
    };
    // Audit S-5: an older signed build replayed under a newer version.
    if !update_url_matches_version(update.download_url.as_str(), &update.version) {
        crate::diagnostics::record("updates", "update file is not in its version's release");
        return Err("update_failed".into());
    }
    if !signed_for_version(&update.signature, &update.version) {
        crate::diagnostics::record("updates", "update signature names another version");
        return Err("update_failed".into());
    }
    // Audit L9: installing restarts the app, so the user confirms natively.
    let question = format!("Install CoreTools {} and restart?", update.version);
    if !crate::confirm(&app, "Update CoreTools", question, "Install").await {
        return Err("update_canceled".into());
    }
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_progress.send(InstallProgress::Downloading { downloaded, total });
            },
            || {
                let _ = on_progress.send(InstallProgress::Installing);
            },
        )
        .await
        .map_err(|_| {
            crate::diagnostics::record("updates", "updater install failed");
            "update_failed".to_string()
        })?;
    // Windows never gets here: the installer closes the app to replace it.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE: &str = "https://github.com/jaychandra1/artifacts/releases/download/coretools-v";

    fn latest(version: &str, url: &str) -> LatestJson {
        LatestJson {
            version: version.into(),
            date: "2026-10-13".into(),
            release_url: url.into(),
            notice: None,
            security: false,
            assets: Vec::new(),
            rollout: None,
            check_after_hours: None,
        }
    }

    fn asset(name: &str, url: &str) -> LatestAsset {
        LatestAsset {
            name: name.into(),
            versioned_url: url.into(),
        }
    }

    const UNTRUSTED: &str = "untrusted comment: signature from tauri secret key";

    /// minisign's signature line: algorithm "ED" (pre-hashed Ed25519), key
    /// id and signature — all zero, but well-formed.
    fn sig_line() -> String {
        let mut bytes = b"ED".to_vec();
        bytes.resize(74, 0);
        STANDARD.encode(bytes)
    }

    /// The updater.json `signature` for a minisign file of these lines;
    /// "SIG" and "GLOBAL" stand for a well-formed signature line and
    /// global-signature line.
    fn sig_file(lines: &[&str]) -> String {
        let mut text = String::new();
        for line in lines {
            let line = match *line {
                "SIG" => sig_line(),
                "GLOBAL" => STANDARD.encode([0u8; 64]),
                other => other.to_string(),
            };
            text.push_str(&line);
            text.push('\n');
        }
        STANDARD.encode(text)
    }

    /// The updater.json `signature` for a minisign file with this trusted comment.
    fn signature(trusted: &str) -> String {
        let trusted = format!("trusted comment: {trusted}");
        sig_file(&[UNTRUSTED, "SIG", trusted.as_str(), "GLOBAL"])
    }

    #[test]
    fn picks_this_platforms_installer_from_the_release() {
        let base = "https://github.com/jaychandra1/artifacts/releases/download/coretools-v1.2.6/";
        let url = |name: &str| format!("{base}{name}");
        let names = [
            "CoreTools-Windows-Setup.exe",
            "CoreTools-macOS.dmg",
            "CoreTools-Linux.AppImage",
            "CoreTools-sbom.cdx.json",
        ];
        let assets: Vec<_> = names.iter().map(|&name| asset(name, &url(name))).collect();
        let pick = |os: &str| download_url_for(os, &assets);
        assert_eq!(pick("windows"), Some(url("CoreTools-Windows-Setup.exe")));
        assert_eq!(pick("macos"), Some(url("CoreTools-macOS.dmg")));
        assert_eq!(pick("linux"), Some(url("CoreTools-Linux.AppImage")));
        assert_eq!(pick("freebsd"), None);
    }

    #[test]
    fn refuses_download_links_outside_the_release_downloads() {
        let elsewhere = "https://evil.example/CoreTools-Windows-Setup.exe";
        let a_page = "https://github.com/jaychandra1/artifacts/releases/tag/x";
        let climbing = format!("{DOWNLOAD_PREFIX}../../../../evil/x/CoreTools-Linux.AppImage");
        let assets = vec![
            asset("CoreTools-Windows-Setup.exe", elsewhere),
            asset("CoreTools-macOS.dmg", a_page),
            asset("CoreTools-Linux.AppImage", &climbing),
        ];
        assert_eq!(download_url_for("windows", &assets), None);
        assert_eq!(download_url_for("macos", &assets), None);
        assert_eq!(download_url_for("linux", &assets), None);
    }

    #[test]
    fn release_links_cannot_climb_out_of_the_prefix() {
        for url in [
            "https://github.com/jaychandra1/artifacts/releases/download/../../../../evil/x/a.exe",
            "https://github.com/jaychandra1/artifacts/releases/download/./x/a.exe",
            "https://github.com/jaychandra1/artifacts/releases/download/%2e%2e/%2e%2e/evil/a.exe",
            "https://github.com/jaychandra1/artifacts/releases/download/%2E%2E/x/a.exe",
            "https://github.com/jaychandra1/artifacts/releases/download/x/../../../../../evil",
        ] {
            assert!(!safe_link(url, DOWNLOAD_PREFIX), "{url}");
        }
        let installer = format!("{DOWNLOAD_PREFIX}coretools-v1.2.7/CoreTools-Windows-Setup.exe");
        assert!(safe_link(&installer, DOWNLOAD_PREFIX));
        // Dots inside names are fine; only whole `.`/`..` segments resolve.
        let dotted = format!("{DOWNLOAD_PREFIX}coretools-v1.2.7/..file.tar.gz");
        assert!(safe_link(&dotted, DOWNLOAD_PREFIX));
    }

    #[test]
    fn enables_the_updater_only_with_a_public_key() {
        let json = serde_json::json!({ "identifier": "io.coretools.test" });
        let mut config: tauri::Config = serde_json::from_value(json).unwrap();
        assert!(!updater_configured(&config));
        let no_key = serde_json::json!({ "pubkey": "", "endpoints": [] });
        config.plugins.0.insert("updater".into(), no_key);
        assert!(!updater_configured(&config));
        let key = serde_json::json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6" });
        config.plugins.0.insert("updater".into(), key);
        assert!(updater_configured(&config));
    }

    #[test]
    fn accepts_the_published_index() {
        let json = br#"{"app":"coretools","name":"CoreTools","version":"1.1.0","date":"2026-10-13",
            "releaseUrl":"https://github.com/jaychandra1/artifacts/releases/tag/coretools-v1.1.0",
            "assets":[]}"#;
        let raw: LatestJson = serde_json::from_slice(json).unwrap();
        let info = validate(raw).unwrap();
        assert_eq!(info.version, "1.1.0");
        assert!(!info.security);
        assert_eq!(info.rollout, None);
        assert_eq!(info.check_after_hours, None);
    }

    #[test]
    fn reads_rollout_and_check_interval() {
        let parse = |extra: &str| {
            let url = "https://github.com/jaychandra1/artifacts/releases/tag/coretools-v1.3.0";
            let json = format!(r#"{{"version":"1.3.0","releaseUrl":"{url}"{extra}}}"#);
            let info = validate(serde_json::from_str(&json).unwrap()).unwrap();
            (info.rollout, info.check_after_hours)
        };
        let limits = parse(r#","rollout":25,"checkAfterHours":12"#);
        assert_eq!(limits, (Some(25), Some(12)));
        let limits = parse(r#","rollout":100,"checkAfterHours":168"#);
        assert_eq!(limits, (Some(100), Some(168)));
        let limits = parse(r#","rollout":1,"checkAfterHours":1"#);
        assert_eq!(limits, (Some(1), Some(1)));
        for extra in [
            r#","rollout":0,"checkAfterHours":0"#,
            r#","rollout":101,"checkAfterHours":169"#,
            r#","rollout":-5,"checkAfterHours":-1"#,
            r#","rollout":50.5,"checkAfterHours":2.5"#,
            r#","rollout":"50","checkAfterHours":"12""#,
            r#","rollout":null,"checkAfterHours":null"#,
            r#","rollout":[50],"checkAfterHours":{"h":1}"#,
        ] {
            assert_eq!(parse(extra), (None, None), "{extra}");
        }
    }

    #[test]
    fn serializes_update_info_in_camel_case() {
        let info = parse_info();
        let json = serde_json::to_value(info).unwrap();
        assert_eq!(json["rollout"], serde_json::json!(40));
        assert_eq!(json["checkAfterHours"], serde_json::Value::Null);
    }

    fn parse_info() -> UpdateInfo {
        let url = "https://github.com/jaychandra1/artifacts/releases/tag/coretools-v1.2.0";
        let mut raw = latest("1.2.0", url);
        raw.rollout = Some(serde_json::json!(40));
        validate(raw).unwrap()
    }

    #[test]
    fn refuses_links_outside_the_release_repository() {
        for url in [
            "https://evil.example/coretools.exe",
            "https://github.com/someone-else/artifacts/releases/x",
            "javascript:alert(1)",
            "https://github.com/jaychandra1/artifacts/releases/x?<script>",
            "https://github.com/jaychandra1/artifacts/releases/../../../evil/x",
            "https://github.com/jaychandra1/artifacts/releases/%2e%2e/x",
        ] {
            assert!(validate(latest("1.2.0", url)).is_err(), "{url}");
        }
    }

    #[test]
    fn refuses_malformed_versions() {
        let url = "https://github.com/jaychandra1/artifacts/releases/tag/coretools-v1.2.0";
        for version in ["", "1.2", "1.2.0-beta", "v1.2.0", "1..0", "1.2.0.0"] {
            assert!(validate(latest(version, url)).is_err(), "{version}");
        }
        assert!(validate(latest("10.20.30", url)).is_ok());
    }

    #[test]
    fn an_update_must_come_from_its_own_release() {
        let ok = format!("{RELEASE}1.2.7/CoreTools-Windows-Setup.exe");
        assert!(update_url_matches_version(&ok, "1.2.7"));
        for url in [
            // An older release's file announced as a newer version.
            format!("{RELEASE}1.2.5/CoreTools-Windows-Setup.exe"),
            format!("{RELEASE}1.2.7/../coretools-v1.2.5/CoreTools-Windows-Setup.exe"),
            format!("{RELEASE}1.2.7/sub/CoreTools-Windows-Setup.exe"),
            format!("{RELEASE}1.2.7/"),
            format!("{RELEASE}1.2.70/CoreTools-Windows-Setup.exe"),
            "https://evil.example/coretools-v1.2.7/x.exe".to_string(),
        ] {
            assert!(!update_url_matches_version(&url, "1.2.7"), "{url}");
        }
        let odd = format!("{RELEASE}1.2.7-x/CoreTools.exe");
        assert!(!update_url_matches_version(&odd, "1.2.7-x"));
    }

    #[test]
    fn reads_the_signed_file_name() {
        let comment = "timestamp:1700000000\tfile:CoreTools_1.2.7_x64-setup.exe";
        let read = trusted_comment(&signature(comment));
        assert_eq!(read.as_deref(), Some(comment));
        assert!(trusted_comment("not base64!").is_none());
        assert!(trusted_comment(&STANDARD.encode("no comment here")).is_none());
    }

    #[test]
    fn the_signature_must_be_made_for_this_version() {
        let windows = signature("timestamp:1\tfile:CoreTools_1.2.7_windows-x86_64-setup.exe");
        assert!(signed_for_version(&windows, "1.2.7"));
        // A replayed older build: its signature names its own version.
        assert!(!signed_for_version(&windows, "1.2.8"));
        assert!(!signed_for_version(&windows, "1.2"));
        let linux = signature("timestamp:1700000000\tfile:CoreTools_1.2.7_amd64.AppImage");
        assert!(signed_for_version(&linux, "1.2.7"));
        // Unversioned file names can't prove anything.
        let unversioned = signature("timestamp:1700000000\tfile:CoreTools.app.tar.gz");
        assert!(!signed_for_version(&unversioned, "1.2.7"));
        // ...unless the signature carries the version itself.
        let signed = signature("timestamp:1\tfile:CoreTools.app.tar.gz\tversion:1.2.7");
        assert!(signed_for_version(&signed, "1.2.7"));
        let mismatch = signature("timestamp:1\tfile:CoreTools_1.2.7_x.exe\tversion:1.2.5");
        assert!(!signed_for_version(&mismatch, "1.2.7"));
        // A version only in the untrusted comment doesn't count.
        let untrusted = "untrusted comment: file:CoreTools_1.2.7_x64-setup.exe";
        let unsigned = sig_file(&[untrusted, "SIG", "trusted comment: timestamp:1", "GLOBAL"]);
        assert!(!signed_for_version(&unsigned, "1.2.7"));
        assert!(!signed_for_version("", "1.2.7"));
    }

    #[test]
    fn a_forged_first_line_cannot_vouch_for_a_version() {
        // A genuine 1.2.5 signature whose first line — covered by no
        // signature — was rewritten to read as a trusted comment for 1.2.7
        // (audit N1).
        let genuine = "trusted comment: timestamp:1\tfile:CoreTools_1.2.5_x64-setup.exe";
        let forged = "trusted comment: timestamp:1\tfile:CoreTools_1.2.7_x64-setup.exe";
        let replayed = sig_file(&[forged, "SIG", genuine, "GLOBAL"]);
        assert!(trusted_comment(&replayed).is_none());
        assert!(!signed_for_version(&replayed, "1.2.7"));
        // Kept as an untrusted comment it is just text; line 3 decides.
        let relabeled = format!("untrusted comment: {forged}");
        let replayed = sig_file(&[relabeled.as_str(), "SIG", genuine, "GLOBAL"]);
        assert!(!signed_for_version(&replayed, "1.2.7"));
        assert!(signed_for_version(&replayed, "1.2.5"));
    }

    #[test]
    fn accepts_only_minisigns_four_line_layout() {
        let trusted = "trusted comment: timestamp:1\tfile:CoreTools_1.2.7_x64-setup.exe";
        let older = "trusted comment: timestamp:1\tfile:CoreTools_1.2.5_x64-setup.exe";
        let well_formed = sig_file(&[UNTRUSTED, "SIG", trusted, "GLOBAL"]);
        assert!(signed_for_version(&well_formed, "1.2.7"));
        for bad in [
            vec![UNTRUSTED, "SIG", trusted],
            vec![UNTRUSTED, "SIG", trusted, "GLOBAL", trusted],
            vec![UNTRUSTED, "SIG", older, trusted, "GLOBAL"],
            vec![UNTRUSTED, UNTRUSTED, "SIG", trusted, "GLOBAL"],
            vec![UNTRUSTED, "SIG", "GLOBAL", trusted],
            vec!["comment: x", "SIG", trusted, "GLOBAL"],
            vec![UNTRUSTED, "SIG", "trusted comment:", "GLOBAL"],
        ] {
            assert!(!signed_for_version(&sig_file(&bad), "1.2.7"), "{bad:?}");
        }
    }
}
