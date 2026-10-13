//! Opt-in update check (audit F-02).
//!
//! Installed copies had no way to learn about a fix. This asks the public
//! release index for the newest version — only when the user turned the
//! check on, or clicked "Check now" — and the UI then offers the download
//! page. It never downloads or installs anything: installers stay a
//! deliberate user action, verifiable with the published Sigstore-signed
//! checksums. (Automatic installs wait for OS code signing, F-01.)
//!
//! The URL is fixed here, the response is size-capped and validated, and the
//! release link must point into the public release repository, so a
//! tampered index can't send users anywhere else. The request carries no
//! identifiers beyond the app's User-Agent.

use serde::{Deserialize, Serialize};

const LATEST_URL: &str =
    "https://raw.githubusercontent.com/jaychandra1/artifacts/main/coretools/releases/latest.json";
const RELEASE_PREFIX: &str = "https://github.com/jaychandra1/artifacts/releases/";
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
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    date: String,
    release_url: String,
    notice: Option<String>,
    security: bool,
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 32
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        && version.split('.').count() == 3
}

fn validate(raw: LatestJson) -> Result<UpdateInfo, String> {
    let url_ok = raw.release_url.starts_with(RELEASE_PREFIX)
        && raw.release_url.len() <= 300
        && raw
            .release_url
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/:.-_".contains(c));
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
    Ok(UpdateInfo {
        version: raw.version,
        date,
        release_url: raw.release_url,
        notice,
        security: raw.security,
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
        }
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
