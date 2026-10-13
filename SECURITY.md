# Privacy & Security Model

CoreTools is designed to be a **trustworthy, offline-first** local tool. This
document describes the concrete measures that back that claim, so the design can
be audited rather than taken on faith.

## 1. Offline by default — one opt-in network feature, no telemetry

- **No telemetry, ever.** There is no analytics SDK, no update pinger, no crash
  reporter, and no external font or asset loading. QR codes are decoded
  (`jsqr`) and generated (`qrcode`) entirely in-page from canvas pixels and
  `data:` URLs, service icons are locally-computed monogram avatars (no
  favicon fetching), and camera frames never leave the device.
- **Exactly one feature uses the network, and only if you turn it on:** the
  Authenticator's **Google Drive backup** (desktop build only). Until you
  click *Connect Google Account*, the app makes no network request at all.
  When connected, it talks only to Google's OAuth and Drive endpoints, and
  only ever uploads a backup that was **end-to-end encrypted on this device**
  first. Every other tool — Diff-Checker, YML-Validator, Grammar-Polisher,
  JSON-Studio — has no network path whatsoever. Details in
  [§8](#google-drive-backup-optional-desktop-only).
- **That network code lives in Rust, not the webview.** All HTTP is made by
  `src-tauri/src/cloud.rs` to fixed Google endpoints. The webview itself
  still cannot reach any remote origin (see the CSP below), so the page that
  holds decrypted secrets has no way to send anything off the device; it can
  only ask the backend for a fixed set of backup operations.
- **Content Security Policy.** The packaged app runs under a strict CSP defined
  in `src-tauri/tauri.conf.json`:
  ```
  default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost;
  object-src 'none'; base-uri 'self'; frame-src 'none'
  ```
  `connect-src` permits only the local Tauri IPC channel — **no remote origin is
  reachable from the webview**, so even an accidental `fetch` would be blocked
  by the runtime. `object-src 'none'` and `frame-src 'none'` disable
  plugins/embeds. Cloud backup did not relax this policy.
- **No outbound capability is granted to the webview.** Tauri's capability
  model (`src-tauri/capabilities/default.json`) grants only `core:default`.
  There is no HTTP plugin, no shell plugin, and no filesystem-scope plugin.
- **The header badge tells the truth per section.** It reads **Offline** in
  every tool, and **Online** only on the Authenticator tab while Google Drive
  backup is connected — or, on any tab, while a backup or sign-in is actually
  in flight. The badge only observes state; it never triggers a request.

## 2. In-memory by default — persistence only where it *is* the feature

- All diffing, YAML and text processing happens on in-memory strings in the
  frontend. For these tools **the app never writes to disk on its own** — no
  cache, no temp files, no logs of user content, no local storage, no
  databases. The only way their data leaves the app is when *you* pick a
  destination in the native **Save** dialog; loading likewise only happens
  through a native **Open** dialog that you drive.
- **Two tools are deliberate, documented exceptions**, each with its own
  isolated IndexedDB database and nothing else:
  - the **Authenticator** (`coretools-authenticator`) — its purpose is to keep
    2FA accounts across restarts; storage and encryption are specified in
    [§8](#8-authenticator-local-persistence--encryption-model);
  - **JSON Studio** (`coretools-json-studio`) — crash/reload session recovery
    for the working document only: the editor texts and active tab, autosaved
    locally, restorable or discardable from a banner, capped at 5M characters.
    No encryption is applied (it is working-document text the user is actively
    editing, not credential material); "wipe" is discarding the session.
- The Rust backend does not log file contents.

## 3. Minimal, guarded native surface

The Rust backend (`src-tauri/src/lib.rs`, `src-tauri/src/hello.rs`,
`src-tauri/src/cloud.rs`) exposes exactly twenty-one commands: five for
files, one to open a saved login page, five for Windows Hello, ten for cloud
backup. **The dialog-origin rule is enforced in Rust, not by
frontend convention:** the file dialogs are opened by Rust
(`pick_open_path` / `pick_save_path`), every path they issue is canonicalized
and stored in managed state, and each read/write command accepts only a
stored path — consuming it on use. A compromised webview therefore cannot
read or write any path the user did not just pick in a native dialog. The
webview holds no dialog capability of its own
(`capabilities/default.json` grants only `core:default`).

| Command | Purpose | Guards |
| --- | --- | --- |
| `pick_open_path()` | Native open-dialog | Runs off the main thread; canonicalizes and authorizes the picked file for one read |
| `pick_save_path(defaultName)` | Native save-dialog | Canonicalizes against the (existing) parent directory; authorizes for one write |
| `read_text_file(path)` | Read a user-selected file | Path must match a dialog-issued authorization (single use); must be a regular file; rejected if larger than 50 MiB; read as UTF-8 only |
| `write_text_file(path, contents)` | Write to a user-selected path | Dialog-issued authorization (single use); refuses writes above 100 MiB |
| `write_binary_file(path, contents)` | Binary counterpart (e.g. .xlsx exports) | Same single-use authorization; refuses writes above 100 MiB |
| `open_external_url(url)` | Credential Manager "Open login page" in the system browser | Absolute `http`/`https` URLs with a host only (≤ 2048 chars), re-serialized by the URL parser — no `file:`, custom-protocol or shell handlers |
| `hello_available()` | Report whether Windows Hello is set up | Read-only capability probe; Windows-only (`false` elsewhere) |
| `hello_create_key(challenge)` | Create/replace the app's Hello key and sign the enrollment challenge | OS shows the Hello verification prompt; challenge limited to 128 bytes; never sees secrets or passwords |
| `hello_sign(challenge)` | Sign the stored challenge to unlock | OS enforces a biometric/PIN verification on **every** call; challenge limited to 128 bytes |
| `hello_delete_key()` | Remove the app's Hello key | Idempotent; used when Hello unlock is disabled |
| `hello_verify_user()` | Device check before a cloud restore | OS biometric/PIN prompt via a throwaway key under a separate name — never touches the unlock key |
| `cloud_available()` | Is a Google OAuth client compiled into this build? | Pure check; no I/O |
| `cloud_status()` | Connected account email + computer name | Reads the OS keychain only; no network |
| `cloud_connect()` | Google sign-in | System browser + loopback redirect + PKCE (S256) + CSRF state; 5-minute timeout; refuses if Drive access was unticked; refresh token stored in the OS keychain, never returned to the webview |
| `cloud_cancel_connect()` | Abort a waiting sign-in | Sets a flag the listener polls |
| `cloud_disconnect()` | Forget + revoke the credential | Deletes the keychain entry first, then revokes at Google (best effort) |
| `cloud_list()` | List backup versions | App-data folder only (`drive.appdata` scope) |
| `cloud_upload(name, content, deviceId, deviceLabel)` | Upload one encrypted backup version | Name must match `coretools-authenticator-*.json` (charset-restricted); content ≤ 5 MiB; labels sanitized and byte-capped; always written to the connected account's app-data folder |
| `cloud_download(id)` | Fetch one version | Id charset-restricted; response ≤ 5 MiB; UTF-8 only |
| `cloud_delete(id)` | Delete one version | Id charset-restricted; already-gone counts as success |
| `cloud_open_drive_settings()` | Open Google Drive settings (Manage apps → CoreTools) | The URL is a constant in Rust; takes no input, so it can't open anything else |

Business logic stays out of the backend, keeping the trusted native surface small.
The one exception is the OAuth/HTTP plumbing in `cloud.rs`. No
paths are ever constructed from untrusted/manifest content — they come only from
dialog results. The Hello commands (§8) handle only opaque challenge/signature
byte arrays — vault keys, secrets and passwords never cross the IPC boundary.
The cloud commands accept only already-encrypted backup text and file
metadata. They never accept a token **from** the webview, so a compromised
page cannot point uploads at another Google account.

## 4. Safe, sandboxed YAML parsing

The Kubernetes optimizer (`src/lib/core/yaml-optimizer.ts`) parses with the
`yaml` library in a deliberately locked-down mode:

- **Data-only `core` schema.** No custom/JS tags (`!!js/function`, etc.) are
  enabled, so parsing can only ever produce plain data — it can never instantiate
  arbitrary objects or execute code. There is no `eval` and no dynamic code path
  anywhere in the codebase.
- **Alias-expansion limit.** `maxAliasCount` (100) caps YAML anchor/alias
  expansion, defusing "billion laughs" style resource-exhaustion attacks.
- **Strict parsing.** Parse and document errors are surfaced to the user rather
  than silently ignored.
- **Schema validation.** Each document is validated for the required Kubernetes
  scaffolding (`apiVersion`, `kind`, `metadata.name`/`generateName`) before it is
  accepted. Validation problems are reported, not swallowed.

### Grammar checking & rewriting are equally sandboxed

The Grammar-Polisher (`src/lib/core/grammar.ts`, `src/lib/core/polisher.ts`,
`src/lib/core/email.ts`) is a **deterministic, rule-based engine**: fixed word
tables and regular expressions, no language-model calls, no external service,
no `eval`, no dynamic code. This includes the email correction mode — emails
are analyzed and rewritten entirely in memory and discarded; nothing typed is
transmitted or stored anywhere.

### JSON Studio is interpreter-only

All JSON Studio processing is `JSON.parse` plus pure interpreters: schema
validation walks the schema (no compiled validators), JSONPath filter
expressions run in `jsonpath-plus`'s safe evaluator, YAML conversion reuses
the same locked-down `yaml` configuration as the optimizer (core schema,
alias cap), and documents are only ever rendered as text — never as markup.
Repaired JSON must re-parse successfully before it replaces the document.
Large-file work runs in a same-origin Web Worker bundled at build time — no
`blob:` workers, no CSP relaxation.

### Theme preference is never persisted

The dark/light toggle keeps its state **in memory only**. It defaults to the
OS preference on every launch and writes nothing to disk or local storage —
consistent with the app-wide no-storage rule. The bundled Inter font ships
inside the app, so even typography triggers no network request.

## 5. Safe file handling

- Files are read as **UTF-8 text only**; there is no binary execution path.
- A **50 MiB** read limit protects against exhausting memory with an oversized or
  accidental input.
- Save operations write plain text to a path the user explicitly confirms.

## 6. Clear frontend / backend separation

- **Core logic** (`src/lib/core`) is pure and I/O-free — trivial to review and
  fully unit-tested. The single exception is
  `src/lib/core/authenticator/db.ts`, the Authenticator's isolated IndexedDB
  boundary (§8); all crypto and parsing modules beside it remain pure.
- **UI** (`src/lib/components`) renders state only.
- **Platform layer** (`src/lib/platform`) is the single file-I/O and
  cloud-transport boundary.
- **Rust backend** is a thin, guarded I/O shell, plus the cloud backup
  transport (`cloud.rs`).

This layering means a reviewer can verify the security-relevant behaviour by
reading a small number of well-isolated files.

## 7. Dependency posture

- Runtime dependencies are intentionally few: `yaml` (safe parsing), `diff`
  (line diffing), `jsqr`/`qrcode` (QR decode/encode), and for JSON Studio:
  `monaco-editor` (the VS Code editor, bundled locally with same-origin
  workers), `@cfworker/json-schema` (an **interpreting** schema validator —
  chosen over AJV precisely because AJV compiles schemas with `new Function`,
  which the CSP forbids), `jsonpath-plus` (run exclusively in `eval: "safe"`
  mode — filter expressions go through its jsep interpreter, never `eval`),
  `jmespath`, `jsonrepair`, `fast-xml-parser` and `fflate` — all pure
  computation, no network APIs. Excel support is hand-rolled on `fflate`
  rather than SheetJS, whose npm build carries unfixed advisories, and
  `monaco-editor` is pinned to `~0.53` because newer releases bundle a
  `dompurify` with open advisories. Production dependencies are audited
  (`npm audit --omit=dev`) and currently report **0 vulnerabilities**.
- All OTP cryptography uses the platform **Web Crypto API** (`crypto.subtle`)
  — HMAC, PBKDF2, AES-GCM and SHA-256 are never reimplemented in JS. The one
  hand-written primitive is MD5, required solely for compatibility with the
  Authenticator browser extension's legacy backup format (see §8).
- The Rust backend adds, for cloud backup only: `reqwest` (HTTPS via
  **rustls** with bundled Mozilla roots — no system OpenSSL), `keyring` (OS
  keychain: Windows Credential Manager, macOS Keychain, Secret Service on
  Linux), and `sha2` / `base64` / `getrandom` for PKCE. Backup encryption
  itself is done in the frontend with Web Crypto, like the vault.
- Build-time tooling (Vite/esbuild) never ships in the packaged application, so
  dev-server advisories do not affect the distributed binary.

## 8. Authenticator: local persistence & encryption model

The Authenticator (`src/lib/core/authenticator/`,
`src/lib/components/authenticator/`) stores 2FA accounts in a local IndexedDB
database. This section specifies exactly what that means.

### What is stored, and where

- **Database**: IndexedDB `coretools-authenticator`, local to this device
  (the WebView2 profile directory in the packaged app; per-origin browser
  storage in the web preview). It is never transmitted as-is. The only copy
  that ever leaves the device is the optional, end-to-end encrypted Google
  Drive backup described below.
- **Entry metadata** (issuer, account name, code type, digits, period,
  counter, ordering, pinned flag) is stored **in the clear** — the same model
  the Authenticator browser extension uses.
- **Secrets** are stored in one of two states:
  - **Encrypted (recommended).** When the user sets an encryption password
    (independent of any other credential), each secret is encrypted with
    **AES-256-GCM** under a key derived via **PBKDF2-SHA256 with 310,000
    iterations** and a random 16-byte per-user salt; every encryption uses a
    fresh random 12-byte IV.
  - **Unencrypted (explicit opt-out).** If no password is set, secrets are
    stored in plaintext and the UI shows a **persistent warning banner** until
    a password is set — mirroring the extension's behaviour.

### Key handling & locking

- The derived AES key is created **non-extractable**, so its raw bytes are
  never exposed to JavaScript, and it exists **only in memory**.
- The section is **locked on every load** and after a configurable idle
  timeout (default 5 minutes). Locking drops the key reference and clears the
  decrypted-secret cache.
- Password verification decrypts a stored sentinel value; AES-GCM's
  authenticated decryption provides the constant-time check (no password hash
  is stored or compared in JS).

### What never happens

- Secrets, generated codes and passwords are never logged (there are no
  `console.*` calls in `src/lib`), never placed in URLs or query strings,
  never written to `localStorage`/cookies, and never leave the device
  unencrypted. The cloud backup carries them only inside its encrypted
  payload.
- QR scanning (camera or image) and QR generation for export run entirely
  in-page; exports are produced client-side and written only through the
  user-driven Save dialog.
- Imports never overwrite silently: duplicates are detected
  (same secret + issuer + account), reported, and skipped; deletions require
  an explicit confirmation with a data-loss warning.

### Windows Hello unlock (optional, desktop only)

The desktop build can optionally unlock the vault with Windows Hello
(fingerprint / face / PIN) instead of the password:

- Enabling requires the **current password** plus a Hello verification. A
  transient extractable copy of the vault key is derived, its 32 raw bytes are
  **AES-256-GCM-wrapped** and stored in IndexedDB, and the plaintext copy is
  zeroed. The wrapping key is `SHA-256` of a Windows Hello **signature**
  (RSA-PKCS#1, deterministic) over a fixed random 32-byte challenge.
- The signing key is created via `KeyCredentialManager` — **TPM-backed where
  available** — and the OS requires a successful biometric/PIN verification
  for *every* signing operation. The signature, and therefore the unwrapping
  key, never exists on disk.
- **Trade-off, stated plainly:** with Hello enabled, a wrapped copy of the
  vault key exists at rest (protected by the Hello/TPM key). Password-only
  mode keeps zero key material on disk. Users who don't enable the toggle are
  entirely unaffected.
- When enabled, Hello is the **first** unlock method offered: the OS prompt
  opens automatically whenever the user *arrives* at the locked section —
  app start, switching to the Authenticator tab, or the window regaining
  focus after an idle auto-lock. It never auto-opens after a deliberate
  manual lock, never while the app window is unfocused (an idle lock firing
  in the background defers the prompt until the user returns), and never
  re-prompts in a loop after the user cancels the dialog. The password form
  stays visible as the fallback in every case. The unlock
  completes only after the OS reports a successful verification **and** the
  resulting signature both unwraps the vault key (AES-GCM authentication)
  and decrypts the stored verifier — a dismissed or failed prompt leaves the
  vault locked. Note that Windows validates an *enrolled* fingerprint already
  resting on the sensor instantly; that is a genuine OS-level match, not a
  bypass — unenrolled fingers fail.
- The password remains the master fallback: changing or removing it, wiping
  data, or a Windows-side Hello reset (e.g. biometric re-enrollment) all
  invalidate and remove the Hello configuration; re-enabling always requires
  the password again.
- In the browser build the feature is absent (`hello_available` is
  Windows-desktop only); nothing is degraded.

### Google Drive backup (optional, desktop only)

Off until the user clicks *Connect Google Account* in Authenticator settings,
which requires an encryption password to be set first. Code:
`src/lib/core/authenticator/cloud-backup.ts` (envelope),
`cloud-sync.ts` (policy), `src/lib/components/authenticator/cloud.svelte.ts`
(scheduling) and `src-tauri/src/cloud.rs` (transport).

**What gets uploaded.** One JSON file per backup version. The **entire vault**
— secrets *and* issuer, account names, order, pins, counters and display
settings — is serialized and encrypted as a single **AES-256-GCM** blob under
the **vault key** (PBKDF2-SHA256 of the encryption password, 310,000
iterations). The only cleartext fields are what restore needs before it can
decrypt: the format name, creation time, a random per-install device id and
the computer name, the KDF salt and iteration count, and the vault's password
verifier (itself AES-GCM ciphertext).

**Integrity, in layers.**
- The cleartext header is bound into the GCM tag as additional authenticated
  data, so a header field can't be swapped or edited without restore failing.
- The verifier distinguishes "wrong password" from "damaged file" so the user
  gets an accurate message.
- The decrypted payload carries an entry count and a SHA-256 digest of the
  entry list, both checked, and every record is validated before anything is
  written.
- Before upload, each sealed file is decrypted again locally and checked. After
  upload, Drive's MD5 of the stored bytes is compared with what was sent. A
  mismatch deletes the upload and retries; older versions are never touched.
- KDF parameters from a downloaded header are bounded (100k–5M iterations),
  so a tampered file can't stall a restore.

**Credentials and scope.**
- Sign-in is OAuth 2.0 with PKCE in the user's own browser, with a loopback
  redirect (RFC 8252). The app never sees the Google password.
- The only scopes requested are `openid email` (to show which account is
  connected) and `drive.appdata`: a hidden per-app folder. CoreTools cannot
  see or touch any other file in the user's Drive.
- The refresh token lives in the **OS keychain** and never crosses into the
  webview. Access tokens are held in Rust memory only.

**Versions, devices and conflicts.**
- Every backup is a new immutable version; the newest **10** are kept for
  rollback. Retention runs only after a new version has uploaded and
  verified, so an interruption at any point leaves every earlier version
  intact.
- Each device remembers which remote version its data is based on. If another
  device made a newer backup, automatic backups pause instead of burying it.
  The user then merges (duplicates are never created) or explicitly keeps this
  device's data; the other version stays available as an older version.
- Failures that heal on their own (offline, Google 5xx/429) retry with
  back-off and when the OS reports the network is back. Revoked access shows
  a "reconnect" banner.

**Restore.**
- Requires the password the backup was made with. On a device with Windows
  Hello, it also requires a Hello verification (`hello_verify_user`).
- Everything is decrypted and validated in memory first, then written in
  **one IndexedDB transaction** — an interrupted restore changes nothing.
- On a fresh install, the backup's password becomes the vault password, so
  the device ends up exactly as the original was.

**Trade-offs, stated plainly.**
- Anyone who obtains the backup file (e.g. a compromised Google account) can
  attempt an offline password guess against PBKDF2 at 310,000 iterations,
  exactly as with an exported encrypted backup. Use a strong encryption
  password.
- Google can see metadata, not content: that backups exist, their times and
  sizes (which loosely track the number of accounts), the computer name, and
  the Google account they belong to.
- After a password change, new backups use the new password; older versions
  keep the password they were made with.
- *Wipe all data* disconnects this device but leaves the Drive backups in
  place. *Delete cloud backups* removes every version.

### Credential Manager (same vault)

Saved platform logins live in the same IndexedDB database (`credentials`
and `audit` stores) and the **same vault** as the Authenticator. One master
password, plus optional Windows Hello, unlocks both, and auto-lock covers
both.

- **Encrypted at rest, no exceptions.** Every password and note is AES-256-GCM
  encrypted under the vault key. The Credential Manager has no unencrypted
  mode: it asks for a master password before the first save, and the
  password can't be removed while credentials exist. Metadata (platform,
  URL, username, category, owner, tags) is stored in the clear for search,
  like authenticator issuers.
- **Decrypted on demand only.** Plaintext is produced only for the one
  credential being shown, copied or edited, and is never held in a store.
  Shown passwords auto-hide after 20 seconds and are cleared immediately on
  lock. Copying honours the clipboard auto-clear setting.
- **Confirm before revealing.** Showing or copying a password requires
  Windows Hello (`hello_verify_user`) or, where Hello isn't available, the
  master password. A success is trusted for 60 seconds and ends on lock. This
  is on by default and can be turned off in settings.
- **Audit log.** Create, edit, password change, move to trash, restore,
  permanent delete, password view and password copy are recorded locally
  (newest 2,000 events) with time and platform name. The log never contains a
  secret.
- **Password changes and restores are atomic.** Changing the master password
  re-encrypts every credential, and a cloud restore writes credentials, in
  the same IndexedDB transaction as the vault config and authenticator
  entries.
- **Access control.** This is a single-user, local application with no
  accounts or server, so there are no roles to enforce. The controls above
  (vault lock, per-reveal re-authentication, audit log) are its
  access-control model. Passwords never cross the IPC boundary into the
  Rust backend; "Open login page" passes only the URL, which both sides
  restrict to http(s).
- **Trash.** Deleting is a soft delete: items can be restored for 30 days,
  then are purged permanently.
- **Cloud backup.** Credentials, including trashed ones, travel inside the
  same end-to-end encrypted payload as the Authenticator, with their own
  SHA-256 checksum. A rollback to a backup made before the Credential
  Manager existed leaves current credentials untouched.

### Legacy-format compatibility (deliberate, contained weakness)

To import and export backups compatible with the Authenticator browser
extension, the app implements that format's original encryption:
OpenSSL/CryptoJS `AES-256-CBC` with `EVP_BytesToKey`-MD5 key derivation. This
scheme is **weak by modern standards** and is used **only** to decrypt
existing extension backups and to produce extension-importable exports at the
user's explicit request. Anything imported through it is immediately
re-encrypted with the AES-GCM vault; the app's own at-rest storage never uses
the legacy scheme.

## Reporting a vulnerability

Because the app is offline and local, the primary risk surface is the parsing/
merging logic, the Authenticator's storage model (§8), and the native IPC
boundary (§3).

- **Security issues**: please use GitHub's **private vulnerability reporting**
  on this repository (Security tab → "Report a vulnerability") rather than a
  public issue, so a fix can ship before details are public. Expect an initial
  response within 7 days.
- **Non-security bugs**: open a regular issue, and include the app version
  shown in the header — every release is tagged, so the version pins the exact
  code.
- Fixes are released as new tagged versions (see CHANGELOG.md). There is no
  auto-update channel by design, so security-relevant releases are flagged
  prominently on the download page.
