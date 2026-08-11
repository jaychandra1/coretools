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

/// Name under which the Hello key pair is registered for this app.
#[cfg(windows)]
const KEY_NAME: &str = "io.coretools.authenticator";

#[cfg(windows)]
mod imp {
    use super::KEY_NAME;
    use windows::core::HSTRING;
    use windows::Security::Credentials::{
        KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Cryptography::CryptographicBuffer;

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

    pub fn delete() -> Result<(), String> {
        // Deleting a key that no longer exists is fine — disabling is idempotent.
        match KeyCredentialManager::DeleteAsync(&HSTRING::from(KEY_NAME)) {
            Ok(op) => match op.get() {
                Ok(()) => Ok(()),
                Err(e) => {
                    let message = e.to_string();
                    if message.contains("not found") || message.contains("NotFound") {
                        Ok(())
                    } else {
                        Err(message)
                    }
                }
            },
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Whether Windows Hello (biometrics or PIN) is set up on this device.
#[tauri::command]
pub fn hello_available() -> Result<bool, String> {
    #[cfg(windows)]
    {
        imp::available()
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// Enable-time: create/replace the Hello key and sign the enrollment challenge.
#[tauri::command]
pub fn hello_create_key(challenge: Vec<u8>) -> Result<Vec<u8>, String> {
    if challenge.is_empty() || challenge.len() > 128 {
        return Err("Invalid challenge".into());
    }
    #[cfg(windows)]
    {
        imp::create_and_sign(&challenge)
    }
    #[cfg(not(windows))]
    {
        Err("hello_unsupported".into())
    }
}

/// Unlock-time: sign the stored challenge (OS shows the Hello prompt).
#[tauri::command]
pub fn hello_sign(challenge: Vec<u8>) -> Result<Vec<u8>, String> {
    if challenge.is_empty() || challenge.len() > 128 {
        return Err("Invalid challenge".into());
    }
    #[cfg(windows)]
    {
        imp::open_and_sign(&challenge)
    }
    #[cfg(not(windows))]
    {
        Err("hello_unsupported".into())
    }
}

/// Disable-time: remove the app's Hello key. Idempotent.
#[tauri::command]
pub fn hello_delete_key() -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::delete()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}
