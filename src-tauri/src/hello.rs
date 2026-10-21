//! Windows Hello support for the Authenticator vault.
//!
//! Uses `Windows.Security.Credentials.KeyCredentialManager`: a Hello-protected
//! key pair (TPM-backed where available) whose every signing operation is
//! gated by the OS biometric/PIN prompt. The frontend derives an AES wrapping
//! key from the (deterministic, RSA-PKCS#1) signature over a fixed random
//! challenge and uses it to wrap the vault key — see SECURITY.md §8.
//!
//! These commands never see vault secrets or passwords. They only:
//!   - report whether Hello is available,
//!   - create/replace or delete the app's named Hello key, and
//!   - request a signature over a caller-supplied challenge.
//!
//! Everything is `cfg(windows)`-gated; other platforms get honest stubs so the
//! app still builds and the feature simply reports "unavailable".
//!
//! The WinRT calls block (`.get()`) until the user answers the Windows Hello
//! prompt, so they run on a blocking-pool worker thread, never on the main
//! (UI) thread, whose window would otherwise freeze meanwhile (audit M7).
//! Those threads have no STA; windows-rs joins the MTA on first use, which
//! is where blocking on WinRT operations is allowed.

/// HRESULTs `DeleteAsync` reports for a key that doesn't exist: nothing to
/// delete, so disabling Hello is idempotent (audit L8 — matched by code, not
/// by the localized error text).
#[cfg(any(windows, test))]
const MISSING_KEY_HRESULTS: [u32; 5] = [
    0x8007_0002, // HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
    0x8007_0490, // HRESULT_FROM_WIN32(ERROR_NOT_FOUND): "Element not found."
    0x8009_000D, // NTE_NO_KEY
    0x8009_0011, // NTE_NOT_FOUND
    0x8009_0016, // NTE_BAD_KEYSET
];

#[cfg(any(windows, test))]
fn is_missing_key(hresult: i32) -> bool {
    MISSING_KEY_HRESULTS.contains(&(hresult as u32))
}

/// Name under which the Hello key pair is registered for this app.
#[cfg(windows)]
const KEY_NAME: &str = "io.coretools.authenticator";

/// Throwaway key used only to make Windows verify the user (cloud restore
/// gate). Separate from KEY_NAME so it can never disturb Hello unlock.
#[cfg(windows)]
const VERIFY_KEY_NAME: &str = "io.coretools.authenticator.verify";

#[cfg(windows)]
mod imp {
    use super::{KEY_NAME, VERIFY_KEY_NAME};
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Security::Credentials::{
        KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};

    /// Bring the Windows Hello prompt to the foreground.
    ///
    /// `KeyCredentialManager` has no HWND interop (unlike, say,
    /// `UserConsentVerifierInterop`), so its dialog — hosted by
    /// CredentialUIBroker.exe in a window of class "Credential Dialog Xaml
    /// Host" — opens BEHIND desktop apps and only flashes in the taskbar.
    /// This watcher polls for that window for a few seconds and foregrounds
    /// it, which the OS allows because our process holds foreground focus at
    /// the moment the user triggers the unlock. Purely window management —
    /// no effect on the verification itself.
    fn foreground_hello_dialog() {
        std::thread::spawn(|| {
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                unsafe {
                    if let Ok(hwnd) =
                        FindWindowW(w!("Credential Dialog Xaml Host"), PCWSTR::null())
                    {
                        if !hwnd.is_invalid() {
                            let _ = SetForegroundWindow(hwnd);
                            break;
                        }
                    }
                }
            }
        });
    }

    /// Map a non-success status to a stable, frontend-matchable error token.
    fn status_error(status: KeyCredentialStatus) -> String {
        match status {
            KeyCredentialStatus::NotFound => "hello_not_found".into(),
            KeyCredentialStatus::UserCanceled => "hello_canceled".into(),
            KeyCredentialStatus::UserPrefersPassword => "hello_canceled".into(),
            KeyCredentialStatus::SecurityDeviceLocked => "hello_device_locked".into(),
            _ => "hello_failed".into(),
        }
    }

    pub fn available() -> Result<bool, String> {
        let op = KeyCredentialManager::IsSupportedAsync().map_err(|e| e.to_string())?;
        op.get().map_err(|e| e.to_string())
    }

    fn sign_with(
        credential: &windows::Security::Credentials::KeyCredential,
        challenge: &[u8],
    ) -> Result<Vec<u8>, String> {
        let buffer =
            CryptographicBuffer::CreateFromByteArray(challenge).map_err(|e| e.to_string())?;
        foreground_hello_dialog(); // the sign prompt opens in the background otherwise
        let result = credential
            .RequestSignAsync(&buffer)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;

        let status = result.Status().map_err(|e| e.to_string())?;
        if status != KeyCredentialStatus::Success {
            return Err(status_error(status));
        }

        let signature = result.Result().map_err(|e| e.to_string())?;
        let mut bytes = windows::core::Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(&signature, &mut bytes)
            .map_err(|e| e.to_string())?;
        Ok(bytes.to_vec())
    }

    /// Create (or replace) the app's Hello key and sign `challenge` with it.
    /// Shows the Windows Hello enrollment/verification prompt.
    pub fn create_and_sign(challenge: &[u8]) -> Result<Vec<u8>, String> {
        foreground_hello_dialog(); // the enrollment prompt opens in the background otherwise
        let result = KeyCredentialManager::RequestCreateAsync(
            &HSTRING::from(KEY_NAME),
            KeyCredentialCreationOption::ReplaceExisting,
        )
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

        let status = result.Status().map_err(|e| e.to_string())?;
        if status != KeyCredentialStatus::Success {
            return Err(status_error(status));
        }
        let credential = result.Credential().map_err(|e| e.to_string())?;
        sign_with(&credential, challenge)
    }

    /// Open the existing Hello key and sign `challenge`.
    /// Shows the Windows Hello verification prompt on every call.
    pub fn open_and_sign(challenge: &[u8]) -> Result<Vec<u8>, String> {
        let result = KeyCredentialManager::OpenAsync(&HSTRING::from(KEY_NAME))
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;

        let status = result.Status().map_err(|e| e.to_string())?;
        if status != KeyCredentialStatus::Success {
            return Err(status_error(status));
        }
        let credential = result.Credential().map_err(|e| e.to_string())?;
        sign_with(&credential, challenge)
    }

    /// Make Windows verify the user (biometric/PIN) by creating a throwaway
    /// Hello key, then delete it. Creating a key credential always requires
    /// a successful Hello verification, and this reuses the exact API the
    /// unlock path already relies on — without touching the unlock key.
    pub fn verify_user() -> Result<(), String> {
        foreground_hello_dialog(); // the prompt opens in the background otherwise
        let result = KeyCredentialManager::RequestCreateAsync(
            &HSTRING::from(VERIFY_KEY_NAME),
            KeyCredentialCreationOption::ReplaceExisting,
        )
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
        let status = result.Status().map_err(|e| e.to_string())?;

        // Best effort cleanup either way; a leftover throwaway key is inert
        // and is replaced on the next verification.
        if let Ok(op) = KeyCredentialManager::DeleteAsync(&HSTRING::from(VERIFY_KEY_NAME)) {
            let _ = op.get();
        }

        if status != KeyCredentialStatus::Success {
            return Err(status_error(status));
        }
        Ok(())
    }

    pub fn delete() -> Result<(), String> {
        // Deleting a key that no longer exists is fine — disabling is idempotent.
        match KeyCredentialManager::DeleteAsync(&HSTRING::from(KEY_NAME)) {
            Ok(op) => match op.get() {
                Ok(()) => Ok(()),
                Err(e) if super::is_missing_key(e.code().0) => Ok(()),
                Err(e) => Err(e.to_string()),
            },
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Run a blocking Hello call on the blocking pool (see the module docs).
#[cfg(windows)]
async fn off_main_thread<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "hello_failed".to_string())?
}

/// Whether Windows Hello (biometrics or PIN) is set up on this device.
#[tauri::command]
pub async fn hello_available() -> Result<bool, String> {
    #[cfg(windows)]
    {
        off_main_thread(imp::available).await
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// Enable-time: create/replace the Hello key and sign the enrollment challenge.
#[tauri::command]
pub async fn hello_create_key(challenge: Vec<u8>) -> Result<Vec<u8>, String> {
    if challenge.is_empty() || challenge.len() > 128 {
        return Err("Invalid challenge".into());
    }
    #[cfg(windows)]
    {
        off_main_thread(move || imp::create_and_sign(&challenge)).await
    }
    #[cfg(not(windows))]
    {
        Err("hello_unsupported".into())
    }
}

/// Unlock-time: sign the stored challenge (OS shows the Hello prompt).
#[tauri::command]
pub async fn hello_sign(challenge: Vec<u8>) -> Result<Vec<u8>, String> {
    if challenge.is_empty() || challenge.len() > 128 {
        return Err("Invalid challenge".into());
    }
    #[cfg(windows)]
    {
        off_main_thread(move || imp::open_and_sign(&challenge)).await
    }
    #[cfg(not(windows))]
    {
        Err("hello_unsupported".into())
    }
}

/// Cloud-restore gate: Windows verifies the user (biometric/PIN prompt).
/// Never touches the unlock key; rejects unless verification succeeds.
#[tauri::command]
pub async fn hello_verify_user() -> Result<(), String> {
    #[cfg(windows)]
    {
        off_main_thread(imp::verify_user).await
    }
    #[cfg(not(windows))]
    {
        Err("hello_unsupported".into())
    }
}

/// Disable-time: remove the app's Hello key. Idempotent.
#[tauri::command]
pub async fn hello_delete_key() -> Result<(), String> {
    #[cfg(windows)]
    {
        off_main_thread(imp::delete).await
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_missing_key_errors_by_code() {
        // HRESULTs are negative as i32; compare through their bit pattern.
        assert!(is_missing_key(0x8007_0490_u32 as i32));
        assert!(is_missing_key(0x8009_0016_u32 as i32));
        assert!(!is_missing_key(0x8007_0005_u32 as i32)); // E_ACCESSDENIED
        assert!(!is_missing_key(0x8000_4005_u32 as i32)); // E_FAIL
        assert!(!is_missing_key(0));
    }
}
