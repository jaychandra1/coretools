# Authenticator

A full two-factor authentication (2FA) code generator built into CoreTools,
feature-compatible with the open-source [Authenticator browser extension](https://authenticator.cc):
it generates codes entirely client-side and imports/exports the extension's
backup files, including encrypted ones.

## Feature overview

- **Code types**: TOTP (RFC 6238; SHA-1/256/512, 6/7/8 digits, custom period),
  HOTP (RFC 4226; visible counter + "next code" button), Steam Guard
  (5-character alphanumeric, Steam alphabet), Blizzard/Battle.net (8-digit TOTP).
- **Adding accounts**: camera QR scan, QR image upload / clipboard paste / drop,
  or manual entry with Base32 validation. Parses `otpauth://` URIs (all the
  messy label/issuer variants) and `otpauth-migration://` Google Authenticator
  export QRs (hand-rolled minimal protobuf decoder — no dependency).
- **Main list**: shared-timer countdown rings, click-to-copy with "Copied!"
  toast and optional 30 s clipboard auto-clear, search with the **/** shortcut,
  edit mode (rename, delete with warning, drag-and-drop reorder), pin-to-top,
  colored monogram avatars, responsive + light/dark theme.
- **Windows Hello unlock (desktop)**: optional biometric/PIN unlock via a
  TPM-backed `KeyCredentialManager` key whose deterministic signature over a
  stored random challenge derives the AES key that wraps the vault key
  (`src-tauri/src/hello.rs` + `platform.hello`). Password stays the master
  fallback; changing/removing it invalidates the Hello setup. Absent in the
  browser build.
- **Google Drive backup & restore (desktop, opt-in)**: requires the
  encryption password. Each module backs up as its own series —
  `coretools-authenticator-*.json` (accounts, secrets *and* metadata, plus
  settings) and `coretools-credmanager-*.json` (Credential Manager logins).
  Each file is one AES-256-GCM blob under the vault key, header bound as AAD,
  and uploaded automatically (debounced) after every change in that module to
  the hidden `appDataFolder`. Ten versions of each are kept for rollback,
  and each section's settings show and restore only its own series. Multi-device conflicts pause automatic
  backup until the user merges or keeps this device's data. Offline failures
  retry with back-off. Restore needs the backup's password plus a Windows
  Hello check, dedupes on merge, and is written in one IndexedDB transaction.
  OAuth/HTTP run in Rust (`src-tauri/src/cloud.rs`); the token lives in the OS
  keychain and never reaches the webview.
- **Encryption at rest**: optional password (independent of anything else) —
  PBKDF2-SHA256 (310,000 iterations) → AES-256-GCM per-secret with random
  12-byte IVs and a 16-byte per-user salt. The derived key is a
  **non-extractable** WebCrypto key held only in memory; the section locks on
  page load and after N minutes of inactivity (default 5, configurable).
  Without a password, secrets are stored unencrypted and a persistent warning
  banner is shown (same behavior as the extension).
- **Import** (with a preview step and duplicate skipping):
  extension JSON backups (unencrypted *and* encrypted), otpauth URI lists,
  Google Authenticator migration QRs, single QR/URI paste, and this app's own
  modern encrypted backups. Duplicates (same secret+issuer+account) are
  reported and skipped, never overwritten.
- **Export**: extension-compatible JSON (plaintext or encrypted with the
  extension's exact CryptoJS/OpenSSL format so it round-trips), a modern
  AES-GCM encrypted variant (clearly marked "this app only"), otpauth URI
  `.txt`, and per-account QR codes with a print-all view. All file generation
  is client-side.
- **Settings**: set/change/remove the encryption password (re-encrypts all
  secrets), auto-lock timeout, clipboard auto-clear, code grouping
  (`123 456` vs `123456`), and a typed-confirmation "wipe all data" danger zone.

## Where things live

```
src/lib/core/authenticator/     pure logic (unit-tested, framework-free)
  types.ts          shared types + defaults
  base32.ts         RFC 4648 Base32 (lenient decode for pasted secrets)
  otp.ts            HOTP / TOTP / Steam / Blizzard via WebCrypto HMAC
  otpauth.ts        otpauth:// URI parse + build
  migration.ts      otpauth-migration:// protobuf decoder
  md5.ts            MD5 (ONLY for legacy backup compatibility)
  legacy-crypto.ts  CryptoJS/OpenSSL AES-CBC (EVP_BytesToKey) decrypt+encrypt
  vault-crypto.ts   PBKDF2-SHA256 + AES-256-GCM vault primitives
  backup.ts         extension JSON / URI list / GCM backup import & export
  cloud-backup.ts   E2E-encrypted cloud backup envelope (seal / parse / open)
  cloud-sync.ts     cloud policy: naming, retention, conflicts, retry, errors
  db.ts             IndexedDB persistence (entries + vault + settings + cloud)

src/lib/components/authenticator/   Svelte 5 UI
  store.svelte.ts   reactive store: entries, vault lifecycle, shared clock
  cloud.svelte.ts   cloud backup controller: auto-backup, conflicts, restore
  RestoreDialog.svelte  sign in → pick version → decrypt → review → restore
  Authenticator.svelte  root: toolbar, search, list, banners, dialogs
  AccountCard.svelte    code display, countdown ring, copy, HOTP refresh
  LockScreen.svelte     password unlock
  AddAccountDialog.svelte  camera / image / manual tabs
  ImportDialog.svelte   format auto-detection + preview + duplicate report
  ExportDialog.svelte   4 export formats + QR grid + print
  SettingsDialog.svelte password management, behavior, danger zone
  Modal.svelte, qr.ts   shared dialog shell; jsQR/qrcode wrappers
```

## Security model

- All generation, encryption, decryption and QR encode/decode run in the
  browser. The webview's CSP still forbids network access. The only thing
  ever transmitted is the opt-in cloud backup: already encrypted, and sent by
  the Rust backend to the user's own Drive app-data folder.
- Secrets, codes and passwords never appear in URLs, logs or error messages.
- Entry metadata (issuer/account/type) is stored in the clear — the same
  model the extension uses; only secrets are encrypted.
- Password verification uses an encrypted sentinel; AES-GCM's authenticated
  decryption performs the constant-time check.
- Locking drops the CryptoKey reference and clears the decrypted-secret map.
  The key itself is non-extractable, so raw key bytes are never exposed to JS.
- The legacy CryptoJS format (MD5-based EVP_BytesToKey, AES-CBC) is implemented
  **only** for compatibility with existing extension backups; anything imported
  from it is re-encrypted with the modern AES-GCM scheme on save.

> Note: unlike the other CoreTools tabs, this feature persists data (that is
> its purpose). Everything stays in local IndexedDB under the
> `coretools-authenticator` database, plus — only if the user connects it — an
> encrypted copy in their Google Drive. See SECURITY.md §8.

## Tests

`npm test` covers: Base32 (RFC 4648 vectors + leniency), HOTP (RFC 4226
Appendix D vectors), TOTP (RFC 6238 Appendix B vectors for SHA-1/256/512),
Steam code properties, otpauth URI parsing/building round-trips, migration
payload decoding (hand-built protobuf fixtures), MD5 (reference vectors +
fuzz against node:crypto), legacy encrypted-backup decryption (validated
against an independent OpenSSL-compatible implementation), and full backup
import/export round-trips (plaintext, extension-encrypted and GCM), and the
cloud backup: envelope round-trip, wrong-password vs. corruption, header
tampering (AAD), damaged ciphertext, checksum mismatch, KDF bounds, conflict
detection, retention, upload checksum verification and error mapping.
