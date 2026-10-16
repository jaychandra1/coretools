//! Update notifications (audit F-02) and in-app updates.
//!
//! `check_for_update` asks the public release index for the newest version —
//! only when the user turned notifications on, or clicked "Check now". The
//! URL is fixed here, the response is size-capped and validated, and every
//! link must point into the public release repository, so a tampered index
//! can't send users anywhere else. The request carries no identifiers beyond
//! the app's User-Agent.
//!
//! `install_update` runs only when the user clicks "Update now": Tauri's
//! updater downloads this platform's build, verifies its minisign signature
//! against the public key compiled into the app (tauri.conf.json →
//! plugins.updater.pubkey, set by the release workflow) and installs it —
//! on Windows as an update (`/UPDATE`: the vault is kept) — then restarts.
//! Only a build signed with the release's private key installs, even if the
//! artifacts repository were compromised. Builds without a public key (local
//! builds) have no updater; the UI then downloads the installer instead.

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

const LATEST_URL: &str =
    "https://raw.githubusercontent.com/jaychandra1/artifacts/main/coretools/releases/latest.json";
const RELEASE_PREFIX: &str = "https://github.com/jaychandra1/artifacts/releases/";
/// Direct asset downloads (a subset of RELEASE_PREFIX).
const DOWNLOAD_PREFIX: &str = "https://github.com/jaychandra1/artifacts/releases/download/";
const MAX_BYTES: usize = 64 * 1024;

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
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 32
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        && version.split('.').count() == 3
}

/// A link into the public release repository with nothing but plain path characters.
fn safe_link(url: &str, prefix: &str) -> bool {
    url.starts_with(prefix)
        && url.len() <= 300
        && url.chars().all(|c| c.is_ascii_alphanumeric() || "/:.-_".contains(c))
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

fn validate(raw: LatestJson) -> Result<UpdateInfo, String> {
    let url_ok = safe_link(&raw.release_url, RELEASE_PREFIX);
    if !valid_version(&raw.version) || !url_ok {
        return Err("update_invalid".into());
    }
    let date = if raw.date.len() == 10 && raw.date.chars().all(|c| c.is_ascii_digit() || c == '-') {
        raw.date
    } else {
        String::new()
    };
    let notice = raw
        .notice
        .map(|text| text.chars().filter(|c| !c.is_control()).take(300).collect::<String>())
        .filter(|text| !text.trim().is_empty());
    let download_url = download_url_for(std::env::consts::OS, &raw.assets);
    Ok(UpdateInfo {
        version: raw.version,
        date,
        release_url: raw.release_url,
        notice,
        security: raw.security,
        download_url,
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
    let bytes = response.bytes().await.map_err(|_| "update_network".to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("update_invalid".into());
    }
    let raw: LatestJson = serde_json::from_slice(&bytes).map_err(|_| "update_invalid".to_string())?;
    validate(raw)
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

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum InstallProgress {
    Downloading { downloaded: u64, total: Option<u64> },
    Installing,
}

/// Download, verify and install the newest release, then restart. Errors:
/// "update_unavailable" (no updater in this build), "update_none" (no signed
/// update published for this platform), "update_network", "update_failed"
/// (download, signature or install failed).
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

    fn latest(version: &str, url: &str) -> LatestJson {
        LatestJson {
            version: version.into(),
            date: "2026-10-13".into(),
            release_url: url.into(),
            notice: None,
            security: false,
            assets: Vec::new(),
        }
    }

    fn asset(name: &str, url: &str) -> LatestAsset {
        LatestAsset { name: name.into(), versioned_url: url.into() }
    }

    #[test]
    fn picks_this_platforms_installer_from_the_release() {
        let base = "https://github.com/jaychandra1/artifacts/releases/download/coretools-v1.2.6/";
        let assets = vec![
            asset("CoreTools-Windows-Setup.exe", &format!("{base}CoreTools-Windows-Setup.exe")),
            asset("CoreTools-macOS.dmg", &format!("{base}CoreTools-macOS.dmg")),
            asset("CoreTools-Linux.AppImage", &format!("{base}CoreTools-Linux.AppImage")),
            asset("CoreTools-sbom.cdx.json", &format!("{base}CoreTools-sbom.cdx.json")),
        ];
        assert_eq!(download_url_for("windows", &assets), Some(format!("{base}CoreTools-Windows-Setup.exe")));
        assert_eq!(download_url_for("macos", &assets), Some(format!("{base}CoreTools-macOS.dmg")));
        assert_eq!(download_url_for("linux", &assets), Some(format!("{base}CoreTools-Linux.AppImage")));
        assert_eq!(download_url_for("freebsd", &assets), None);
    }

    #[test]
    fn refuses_download_links_outside_the_release_downloads() {
        let assets = vec![
            asset("CoreTools-Windows-Setup.exe", "https://evil.example/CoreTools-Windows-Setup.exe"),
            asset("CoreTools-macOS.dmg", "https://github.com/jaychandra1/artifacts/releases/tag/x"),
        ];
        assert_eq!(download_url_for("windows", &assets), None);
        assert_eq!(download_url_for("macos", &assets), None);
    }

    #[test]
    fn enables_the_updater_only_with_a_public_key() {
        let mut config: tauri::Config =
            serde_json::from_value(serde_json::json!({ "identifier": "io.coretools.test" })).unwrap();
        assert!(!updater_configured(&config));
        config.plugins.0.insert("updater".into(), serde_json::json!({ "pubkey": "", "endpoints": [] }));
        assert!(!updater_configured(&config));
        config.plugins.0.insert("updater".into(), serde_json::json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6" }));
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
    }

    #[test]
    fn refuses_links_outside_the_release_repository() {
        for url in [
            "https://evil.example/coretools.exe",
            "https://github.com/someone-else/artifacts/releases/x",
            "javascript:alert(1)",
            "https://github.com/jaychandra1/artifacts/releases/x?<script>",
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
}
