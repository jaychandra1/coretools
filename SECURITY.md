# Privacy & Security Model

CoreTools is designed to be a **trustworthy, offline-first** local tool. This
document describes the concrete measures that back that claim, so the design can
be audited rather than taken on faith.

## 1. Offline by default — two opt-in network features, no telemetry

- **No telemetry, ever.** There is no analytics SDK, no crash reporter, no
  automatic update pinger (the update check below stays off until you turn
  it on), and no external font or asset loading. QR codes are decoded
  (`jsqr`) and generated (`qrcode`) entirely in-page from canvas pixels and
  `data:` URLs, service icons are locally-computed monogram avatars (no
  favicon fetching), and camera frames never leave the device. On Windows
  the app grants WebView2's *camera* permission to its own pages itself
  (`src-tauri/src/webview_permissions.rs`) rather than showing a prompt
  attributed to `http://tauri.localhost`. No other permission kind is
  granted, no third-party origin can be loaded into the webview (CSP), and
  Windows' camera privacy setting still applies.
- **Two features use the network, and only if you turn them on** (desktop
  build only):
  - **Google Drive backup** for the Authenticator and the Credential
    Manager. Until you click *Connect Google Account*, it makes no request.
    When connected, it talks only to Google's OAuth and Drive endpoints and
    only ever uploads backups that were **end-to-end encrypted on this
    device** first. Details in [§8](#google-drive-backup-optional-desktop-only).
  - **Update notifications.** Off until you say yes (asked once). When on, the
    app reads one fixed public file — `coretools/releases/latest.json` in
    the public release repository — when the app opens and about once an
    hour while it's open. The request carries
    nothing about you or your data; the app only shows "update available"
    (a banner until you choose *Later* for that version, and a header pill).
  - **In-app updates.** Only when you click *Update now*: Tauri's updater
    fetches `updater.json` from the release repository, downloads this
    platform's file from the versioned release, and installs it only if its
    minisign signature verifies against the public key compiled into the
    app. The private key lives only in this repository's Actions secrets, so
    someone who could replace files in the public artifacts repository still
    can't get an update installed. On Windows it installs as an update
    (`/UPDATE`), which keeps the vault. Builds without the key (local builds)
    have no updater and download the installer for the user to run instead.

  Every other tool — Diff-Checker, YML-Validator, Grammar-Polisher,
  JSON-Studio — has no network path whatsoever.
- **That network code lives in Rust, not the webview.** All HTTP is made by
  `src-tauri/src/cloud.rs` (fixed Google endpoints) and
  `src-tauri/src/updates.rs` (one fixed URL, size-capped, and the release
  link it returns must point into the public release repository). The
  webview itself still cannot reach any remote origin (see the CSP below), so
  the page that holds decrypted secrets has no way to send anything off the
  device; it can only ask the backend for a fixed set of operations.
- **Content Security Policy.** The packaged app runs under a strict CSP defined
  in `src-tauri/tauri.conf.json`:
  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;
  connect-src 'self' ipc: http://ipc.localhost; object-src 'none';
  base-uri 'self'; frame-src 'none'
  ```
  `connect-src` permits only the local Tauri IPC channel — **no remote origin is
  reachable from the webview**, so even an accidental `fetch` would be blocked
  by the runtime. `object-src 'none'` and `frame-src 'none'` disable
  plugins/embeds. `'wasm-unsafe-eval'` lets the page compile WebAssembly —
  the Argon2id key derivation (§8) — and nothing else: JavaScript `eval`,
  `new Function` and inline scripts stay blocked. The web build at `/app`
  serves the same policy. Cloud backup and the update check did not relax it.
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
    for the working document only: the editor texts and active tab, restorable
    or discardable from a banner, capped at 5M characters. The copy is
    **deleted after 24 hours**, is **never written when the document looks like
    it holds a credential** (cloud keys, tokens, private keys, JWTs, password
    or token fields — any older copy is deleted too), and recovery can be
    switched off from the status bar. It isn't encrypted: it is working text
    the user is actively editing.
- **Two small preferences live in `localStorage`**: whether update
  notifications are on (and when the last check ran), and whether JSON-Studio
  recovery is on. Neither is personal data.
- **A local diagnostics log** (desktop) records error *causes* — an error
  class, an HTTP status, Google's error reason — with a timestamp, in two
  rotating files of at most 256 KiB in the app's log directory
  (`src-tauri/src/diagnostics.rs`). It never records content, secrets,
  tokens, URLs or account names, and nothing leaves the device unless the
  user copies the report from *About & diagnostics*.
- The Rust backend does not log file contents.

## 3. Minimal, guarded native surface

The Rust backend (`src-tauri/src/lib.rs` and its modules `files.rs`,
`links.rs`, `hello.rs`, `cloud.rs`, `secure_clipboard.rs`, `updates.rs`,
`diagnostics.rs`, `webview_permissions.rs`) exposes twenty-seven commands:
five for files, one to open a link, five for Windows Hello, nine for cloud
backup, two for the secure clipboard, two for updates, two for the
diagnostics log and one for the QR scanner's camera. **The dialog-origin
rule is enforced in Rust, not by frontend convention:** the file dialogs are
opened by Rust (`pick_open_path` / `pick_save_path`), and each path they
return is a grant for ONE operation of that kind — a picked file can be read
once, a save target written once. The read/write commands look the path
string up among the grants before touching the filesystem, so a compromised
webview can't read or write anything else, can't probe whether a file
exists, and can't make Windows open a UNC or device path (which would send
the user's network credentials to that server). After a grant matches, the
path must still resolve to where it pointed when the user picked it.
Writes go to a temporary file that replaces the target, so a crash never
leaves a half-written file — except in a folder that accepts no new files,
where the file is overwritten in place. On macOS and Linux the temporary
file is readable by its owner only and takes over the replaced file's
permissions, so a save never widens who can read a file. The webview holds
no dialog capability of its own (`capabilities/default.json` grants only
`core:default`).

The webview also can't leave the app: a navigation guard refuses every
navigation to another origin, the CSP forbids form submissions
(`form-action 'none'`), and links open in the system browser only through
`open_external_url` — directly only for the project's own GitHub pages
without a query string or fragment, otherwise only after the user confirms
a native dialog that shows the link (its first 200 characters), at most ten
per minute. A confirmation covers that exact link for the session, not its
site. Only one copy of the desktop app runs at a time; a second launch
focuses the first.

| Command | Purpose | Guards |
| --- | --- | --- |
| `pick_open_path()` | Native open-dialog | Runs off the main thread; the picked file becomes a grant for one read |
| `pick_save_path(defaultName)` | Native save-dialog | The suggested name is reduced to a plain file name (no folders, ≤ 120 characters, known extensions only); the target becomes a grant for one write |
| `read_text_file(path)` | Read a user-selected file | Exact match with an unused read grant before any filesystem access; still resolves to the picked file; regular files only; read capped at 50 MiB while reading; UTF-8 only |
| `write_text_file(path, contents)` | Write to a user-selected path | Unused write grant; refuses writes above 100 MiB; temporary file renamed over the target |
| `write_binary_file` (raw body, `x-path` header) | Binary counterpart (e.g. .xlsx exports) | Same grant rules; the bytes travel as the raw IPC body (as a JSON byte array only where Tauri falls back to postMessage IPC), size-checked before they are copied |
| `open_external_url(url)` | Open a saved login page or help link in the system browser | `http`/`https` with a host and no embedded credentials (≤ 2048 chars); only the project's GitHub pages without query or fragment open directly, anything else only after a native confirmation showing the link (once per exact link per session); at most 10 per minute |
| `qr_camera_armed(armed)` | The QR scanner is (not) using the camera | The camera is granted only to the app's own page and only while armed |
| `hello_available()` | Report whether Windows Hello is set up | Read-only capability probe; Windows-only (`false` elsewhere) |
| `hello_create_key(challenge)` | Create/replace the app's Hello key and sign the enrollment challenge | OS shows the Hello verification prompt; challenge limited to 128 bytes; never sees secrets or passwords |
| `hello_sign(challenge)` | Sign the stored challenge to unlock | OS enforces a biometric/PIN verification on **every** call; challenge limited to 128 bytes |
| `hello_delete_key()` | Remove the app's Hello key | Idempotent; used when Hello unlock is disabled |
| `hello_verify_user()` | Device check before a cloud restore | OS biometric/PIN prompt via a throwaway key under a separate name — never touches the unlock key |
| `cloud_available()` | Is a Google OAuth client compiled into this build? | Pure check; no I/O |
| `cloud_status()` | Connected account email + computer name | Reads the OS keychain only; no network |
| `cloud_connect()` | Google sign-in | System browser + loopback redirect + PKCE (S256) + CSRF state; 5-minute timeout; refuses if Drive access was unticked; refresh token stored in the OS keychain, never returned to the webview |
| `cloud_cancel_connect()` | Abort a waiting sign-in | Sets a flag the listener polls |
| `cloud_disconnect()` | Revoke + forget the credential | Revokes at Google first (5 s timeout), then always deletes the keychain entry; reports whether the revoke succeeded (an unreadable keychain counts as not revoked) |
| `cloud_list()` | List backup versions | App-data folder only (`drive.appdata` scope); follows result pages; each response size-capped while reading |
| `cloud_upload(name, content, deviceId, deviceLabel, records)` | Upload one encrypted backup version | Name must match `coretools-authenticator-*.json` or `coretools-credmanager-*.json` (charset-restricted); content ≤ 5 MiB; labels sanitized and byte-capped; the record count is stored with the file (shrink protection); always written to the connected account's app-data folder |
| `cloud_download(id)` | Fetch one version | Id charset-restricted; response ≤ 5 MiB; UTF-8 only |
| `cloud_delete(id)` | Delete one version | Id charset-restricted; already-gone counts as success |
| `clipboard_copy_secret(text)` | Copy a password or 2FA code | Marked so clipboard history, the Windows cloud clipboard and clipboard managers skip it (Windows `ExcludeClipboardContentFromMonitorProcessing`, macOS `org.nspasteboard.ConcealedType`, Linux `x-kde-passwordManagerHint`); ≤ 4,096 characters; never stored or logged |
| `clipboard_clear_if(expected)` | Auto-clear after 30 s | Clears only if the clipboard still holds exactly that text, so a later copy is never destroyed |
| `check_for_update()` | Opt-in update check | One fixed public URL; response ≤ 64 KiB while reading; version must be `x.y.z`; links must stay inside the public release repository (parsed, no `..` segments) |
| `install_update(onProgress)` | In-app update | Only after a native "Install and restart?" confirmation; the download must come from that version's own release, and its signature must name a file of that version — so an old signed build can't be offered as a new one |
| `diagnostics_record(source, cause)` | Record a UI-side failure cause | Control characters stripped, length-capped, at most 30 per minute; callers pass error tokens only |
| `diagnostics_report()` | Recent log lines for *Copy diagnostics* | Read-only; newest 200 lines |

Business logic stays out of the backend, keeping the trusted native surface small.
The one exception is the OAuth/HTTP plumbing in `cloud.rs`. No
paths are ever constructed from untrusted/manifest content — they come only from
dialog results. The Hello commands (§8) handle only opaque challenge/signature
byte arrays — vault keys never cross the IPC boundary. The one place a secret
does is deliberate: a password or code the user copies is handed to
`clipboard_copy_secret`, which only places it on the clipboard (the web
clipboard API can't set the history exclusions).
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

The Grammar-Polisher (`src/lib/core/writing/`, `src/lib/writing/`) checks
text with [Harper](https://github.com/Automattic/harper) (Apache-2.0), an
open-source grammar engine compiled to WebAssembly and bundled with the app:
it runs on the device, in the app's own worker script, loaded from the app's
own files under the existing Content-Security-Policy (no `blob:` workers, no
remote code). Tone rewrites and email checks are deterministic, rule-based
code: fixed word tables and regular expressions. No language-model calls, no
external service, no `eval`. The text is checked in memory and never
transmitted or written to disk; only the user's own dictionary of accepted
words (names, product terms) is kept, in the browser storage of this device.

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
- All OTP and vault cryptography uses the platform **Web Crypto API**
  (`crypto.subtle`) — HMAC, PBKDF2, AES-GCM and SHA-256 are never
  reimplemented in JS. Argon2id, which Web Crypto doesn't offer, comes from
  `hash-wasm` (MIT): the reference algorithm compiled to WebAssembly,
  checked in tests for determinism and parameter handling. The one
  hand-written primitive is MD5, required solely for compatibility with the
  Authenticator browser extension's legacy backup format (see §8).
- The Rust backend adds: `reqwest` (HTTPS via **rustls** with bundled
  Mozilla roots — no system OpenSSL), `keyring` (OS keychain: Windows
  Credential Manager, macOS Keychain, Secret Service on Linux), and
  `sha2` / `base64` / `getrandom` for PKCE — all for cloud backup — plus
  `arboard` (text only, no image support) for the secure clipboard. Backup
  encryption itself is done in the frontend with Web Crypto, like the vault.
- Build-time tooling (Vite/esbuild) never ships in the packaged application, so
  dev-server advisories do not affect the distributed binary.

### Release and deployment integrity

- **Signed checksums.** Each release's `SHA256SUMS.txt`, which pins every
  installer, is signed keylessly with **Sigstore** by the release workflow.
  The bundle `SHA256SUMS.txt.sigstore.json` ships beside it, and the release
  notes print the exact `cosign verify-blob` command. The signing
  certificate names this repository's release workflow and the tag, so
  someone holding only the artifacts-repo token can replace files but can't
  produce a signature that verifies. Every signature is also recorded in
  Sigstore's public transparency log.
- **Software bill of materials.** Each release ships `CoreTools-sbom.cdx.json`
  (CycloneDX: npm and Rust dependencies), listed in `SHA256SUMS.txt` and so
  covered by the same signature.
- **Code signing, ready when certificates are.** The release workflow signs
  Windows installers (Azure Artifact Signing) and signs and notarizes macOS
  builds (Developer ID) as soon as their credentials are configured, verifies
  the signature before upload, and refuses a half-configured platform rather
  than silently shipping it unsigned. Until then installers are unsigned and
  the release notes say so.
- **Only code on `master` ships.** A release builds only a commit that is
  already on `master`, its CHANGELOG notes must exist, and publishing runs
  in the `release` environment, which can require an approval. Nothing
  enforces review before code reaches `master` today: the source repository
  is private on GitHub Free, which offers neither branch rulesets nor
  required reviewers (accepted risks F-03/F-04 in DEPLOYMENT.md). The
  website deploys from a `production` branch that CI moves only after the
  web checks pass on `master`. CI also refuses temporary test code (such as
  a fake cloud backend) in `src/`.
- **Reproducible Rust builds.** A release refuses to build without
  `src-tauri/Cargo.lock` or when it is out of date (`cargo metadata
  --locked`), so a build can't silently resolve different dependencies from
  the reviewed set; `cargo deny` checks them against the RustSec advisory
  database. The Rust and Node toolchains are pinned (`rust-toolchain.toml`,
  `.nvmrc`).
- **The update signing key is used in one isolated step.** The platform
  builds never see it: a separate job — no npm install scripts, no build
  caches — signs version-named copies of the finished installers and checks
  each signature against the public key before anything is published. The
  app then refuses any update whose signature names another version.
- **Workflow and code scanning.** Every change runs actionlint and zizmor
  over the workflows; CodeQL and dependency review run when the source
  repository is public (they need a paid plan on a private one).
- **Rollouts and rollbacks.** A release can be offered to a share of
  installs first; rolling `coretools-latest` back republishes an earlier,
  checksum-verified release without rebuilding and withdraws the bad one,
  so a withdrawn build is never offered as an update. Published versioned
  releases are never overwritten. A scheduled canary checks every few hours
  that the published release, its downloads and the website are consistent.

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
- With an encryption password set, **everything identifying is encrypted**:
  each secret in its own **AES-256-GCM** blob, and the issuer and account
  name sealed together in a `meta` blob (the plaintext fields are stored
  empty). Each blob is **bound to its record and field** as additional
  authenticated data, so a ciphertext moved to another record or field fails
  to decrypt instead of showing one site's secret under another; records
  from before 1.3 are re-sealed this way on the next unlock. Only
  non-identifying fields stay in the clear: code type, digits, period,
  counter, display order and pinned flag. (Versions before 1.3 also stored an
  unsalted SHA-256 of each secret; it is dropped as records are rewritten.)
  Every encryption uses a fresh random 12-byte IV.
- **Several windows or tabs** can't overwrite each other: every write to the
  vault (and the settings) checks and bumps a generation counter in the same
  transaction, and the other windows are told over a BroadcastChannel and
  read the vault again — staying unlocked while the key is unchanged, locking
  after a password change or rollback elsewhere. Within a window, writes run
  one at a time, and a change prepared from a copy that has since been
  re-read is refused rather than written. The desktop app runs as a single
  instance.
- **A damaged record doesn't lock you out.** One that won't decrypt is set
  aside and reported; the rest of the vault opens, and it is kept as it is
  through password changes and merges (only a "replace" restore drops it).
- **Local snapshots.** Before a password change, password removal or restore,
  the vault is copied as stored (still encrypted) into a snapshot; the last
  five are kept and can be restored from Settings (after confirming it's
  you). Restoring one from before a password change asks for the password
  it had then and checks it before anything changes, so a rollback can't
  leave you locked out. A deleted 2FA account can be undone for a few
  seconds.
- **Settings that protect the vault** (auto-lock, clipboard clearing, the
  reveal check) are also sealed under the vault key, bound to their record.
  On unlock the sealed copy wins over the plaintext one; when it is missing,
  damaged or another record was put in its place, the stricter of the
  plaintext values and the defaults applies — values planted on disk can't
  weaken them either way. They can't be changed while the vault is locked.
  **Lowering any of them, exporting accounts, rolling back to a snapshot or
  wiping the vault asks for the master password — or Windows Hello, where
  you turned it on for the vault — every time.** Revealing saved passwords
  asks at most once a minute.
- **Unencrypted (explicit opt-out).** If no password is set, secrets and
  names are stored in plaintext and the UI shows a **persistent warning
  banner** until a password is set — mirroring the extension's behaviour.

### Key hierarchy, password policy and locking

- A random 32-byte **data key** encrypts everything (secrets, names,
  credentials, the audit log, backups). The password never encrypts data
  directly: **Argon2id** (64 MiB memory, 3 passes, 1 lane, 16-byte random
  salt) turns it into a key-encryption key that AES-GCM-wraps the data key.
  A wrong password fails at that unwrap's authentication tag; a stored
  verifier (a known sentinel under the data key) double-checks it — no
  password hash is stored or compared in JS.
- **Upgrade from 1.1 and earlier**, where the data key *was* the PBKDF2
  output (310,000 iterations): on the next password unlock, that same key is
  wrapped under a fresh Argon2id key and the PBKDF2 parameters are deleted.
  Nothing is re-encrypted and Windows Hello keeps working; names written in
  the clear by older versions are sealed in the same unlock. Earlier versions
  can't open an upgraded vault (documented as "no downgrade past 1.2").
- **Password policy.** A new master password needs at least 12 characters and
  must pass a strength estimate that discounts common words, repeats,
  sequences and keyboard walks. A weaker password from before keeps working;
  the app asks the user to change it.
- The working key is **non-extractable** and exists **only in memory**; raw
  key bytes, where they briefly exist (wrapping for Hello, the upgrade), are
  zeroed after use. Only a wrong password is reported as one: any other
  unlock failure (the key derivation running out of memory, say) shows its
  own error, so nobody wipes a vault they could have opened.
- The section is **locked on every load** and after a configurable idle
  timeout (default 5 minutes). Locking drops the key, clears the decrypted
  secrets, and blanks the decrypted names and credential metadata in memory.
- **Collections are registered at startup, explicitly** (`src/lib/vault-bootstrap.ts`),
  and an operation that re-keys the vault (password change, restore into a
  new vault) refuses to run if stored credentials exist that no registered
  collection could re-encrypt — it fails safe instead of leaving data
  undecryptable.

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

- Enabling requires the **current password** plus a Hello verification. The
  password unwraps the data key's 32 raw bytes, which are
  **AES-256-GCM-wrapped** under the Hello-derived key, stored in IndexedDB,
  and zeroed. The wrapping key is `SHA-256` of a Windows Hello **signature**
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
- **The password is required at least every 14 days.** After that, Hello
  pauses until the password is typed once — so it isn't forgotten (it's what
  restores a backup on a new device), and a stolen Hello session can't be
  used indefinitely.
- **Same-user processes (stated plainly).** The app is an unpackaged Win32
  binary, so its Hello key is identified by name, not by package identity;
  another program running as the same Windows user could ask Windows to show
  a genuine Hello prompt for it. Approving that prompt is required, and
  same-user malware can already read the app's memory while it's unlocked,
  so this doesn't add a new way in — but true per-app isolation needs MSIX
  packaging, which is the planned path. The 14-day password requirement
  bounds how long a wrapped key alone is useful.
- In the browser build the feature is absent (`hello_available` is
  Windows-desktop only); nothing is degraded.

### Google Drive backup (optional, desktop only)

Off until the user clicks *Connect Google Account* in Authenticator settings,
which requires an encryption password to be set first. Code:
`src/lib/core/authenticator/cloud-backup.ts` (envelope),
`cloud-sync.ts` (policy), `src/lib/components/authenticator/cloud.svelte.ts`
(scheduling) and `src-tauri/src/cloud.rs` (transport).

**What gets uploaded.** Each module backs up as its own series of JSON
files, one file per version (format v2 since 1.2):
- `coretools-authenticator-<time>-<device>.json` holds the 2FA accounts —
  secrets *and* issuer, account names, order, pins and counters — plus
  display settings;
- `coretools-credmanager-<time>-<device>.json` holds the Credential Manager
  logins.

Each file is serialized and encrypted as a single **AES-256-GCM** blob under
the vault's **data key**. The only cleartext fields are what restore needs
before it can decrypt: the format name, creation time, a random per-install
device id and the computer name, the Argon2id parameters and salt, the
**password-wrapped data key**, and the verifier (itself AES-GCM ciphertext).
Vaults not yet upgraded still write the 1.1 layout (PBKDF2 parameters, no
wrapped key); both layouts restore.

**Integrity, in layers.**
- The cleartext header is bound into the GCM tag as additional authenticated
  data, so a header field can't be swapped or edited without restore failing.
- The verifier distinguishes "wrong password" from "damaged file" so the user
  gets an accurate message.
- The decrypted payload names the series it holds. That name is inside the
  ciphertext, so renaming a file can't change what a restore overwrites. The
  payload also carries a record count and a SHA-256 digest of its records,
  both checked, and every record is validated before anything is written.
- Before upload, each sealed file is decrypted again locally and checked. After
  upload, Drive's MD5 of the stored bytes is compared with what was sent. A
  mismatch deletes the upload and retries; older versions are never touched.
- KDF parameters from a downloaded header are bounded (Argon2id 19–256 MiB
  memory, 1–6 passes, 1–4 lanes; PBKDF2 100k–5M iterations), so a tampered
  file can't stall a restore, exhaust memory, or downgrade to a cheap setting.
  Files are refused above 16 MiB before parsing, and every account's code
  settings are checked (5–10 digits, a 5–3,600 s period) wherever accounts
  come in — QR codes, links, files and restores.
- Every header field — including the KDF parameters and the wrapped key — is
  bound into the payload's GCM tag, so none can be swapped.

**Credentials and scope.**
- Sign-in is OAuth 2.0 with PKCE in the user's own browser, with a loopback
  redirect (RFC 8252). The app never sees the Google password.
- The only scopes requested are `openid email` (to show which account is
  connected) and `drive.appdata`: a hidden per-app folder. CoreTools cannot
  see or touch any other file in the user's Drive.
- The refresh token lives in the **OS keychain** and never crosses into the
  webview. Access tokens are held in Rust memory only.
- The keychain belongs to the OS user, not the install, so the sign-in
  outlives a plain uninstall (a reinstall shows the account as connected).
  The Windows uninstaller deletes it when "Delete the application data" is
  ticked and confirmed — the same choice that deletes the local vault — and
  never during an update (`src-tauri/installer/hooks.nsh`, tested in CI).
  That removes only the local copy; *Disconnect* also revokes the token at
  Google.
- **Updates can't erase the vault.** Installing a newer version runs the old
  uninstaller as an update (`/UPDATE /P`: app data kept, no window), so the
  "Delete the application data" choice only exists in a real uninstall from
  Windows Settings, which asks for confirmation (default *No*) before
  erasing the vault (`src-tauri/installer/installer.nsi`, generated from
  Tauri's template by `scripts/installer-template.mjs` and checked in CI).

**Versions, devices and conflicts.**
- Every backup is a new immutable version, and a change in one module uploads
  only that module's series. **Retention is time-tiered:** the newest 10,
  then one per hour for a day, one per day for a month and one per month for a
  year (at most 100). The last version before a large shrink — a mass
  deletion — is always kept, so a bad edit can't age every good copy out
  within minutes. Retention runs only after a new version has uploaded and
  verified, so an interruption at any point leaves every earlier version
  intact.
- Automatic backups are **coalesced** to at most one pass every 5 minutes, and
  retries use full random jitter (5 s up to 15 min), so a Google incident
  doesn't make every installed copy retry in lockstep against the shared
  quota.
- **Deletions are recorded** (as SHA-256 hashes of the record's identity,
  encrypted at rest and inside the backup) and honoured by merges: a merge
  never brings back something this device deleted, and removes what another
  device deleted after this device last added or changed it. A deletion and
  its record are written in one transaction.
- **A merge never brings back an older version.** When the backup holds a
  login that is also here, the newer of the two wins (last writer wins), so
  a password rotated on one device isn't reverted by merging an older
  backup; a 2FA account keeps the higher HOTP counter.
- **Shrink protection counts records.** Each backup file carries how many
  records it holds; the version before a mass deletion (fewer than half the
  records) is kept even when deletion records keep the file's size up.
  Old versions are pruned only after the provider's checksum confirms the
  new upload — without a checksum, nothing is pruned.
- **After a password change** the app offers to delete the cloud versions
  and local snapshots that still open with the old password.
- Each device remembers, per series, which remote version its data is based
  on. If another device made a newer backup of a series, automatic backups of
  that series pause instead of burying it.
  The user then merges (duplicates are never created) or explicitly keeps this
  device's data; the other version stays available as an older version.
- Failures that heal on their own (offline, Google 5xx/429) retry with
  back-off and when the OS reports the network is back. Revoked access shows
  a "reconnect" banner.
- A Google 403 is classified by its structured error reason, never by the
  status code alone. Full storage, rate limiting (retried), a Workspace
  administrator's policy, and revoked or missing permission each get their
  own message. An unrecognised 403 is reported as a failure, not as revoked
  access.

**Restore.**
- From Google Drive, or from an **exported encrypted file** (each section's
  settings → Backup file), which uses the same format and works without
  Google — the recovery path if the Google project or account were ever lost.
- Requires the password the backup was made with. On a device with Windows
  Hello, it also requires a Hello verification (`hello_verify_user`).
- Everything is decrypted and validated in memory first, then written in
  **one IndexedDB transaction** — an interrupted restore changes nothing.
- On a fresh install, the backup's password becomes the vault password, so
  the device ends up exactly as the original was.
- Each section restores only its own series: restoring in the Authenticator
  never touches saved logins, and restoring in the Credential Manager never
  touches 2FA accounts, even in *Replace* mode. Older backups that hold
  accounts (and, from v1.1.0 builds, credentials) in one file appear in the
  Authenticator, which restores only their accounts.

**Trade-offs, stated plainly.**
- Anyone who obtains a backup file (e.g. a compromised Google account) can
  attempt offline password guesses; each costs a full Argon2id run with 64 MiB
  of memory, which defeats cheap GPU parallelism. Backups made before the
  upgrade remain PBKDF2-protected until retention removes them (and they
  hold only data from then). A strong password is still the real defence.
- Google can see metadata, not content: that backups exist and for which
  module (the file names), their times and sizes (which loosely track the
  number of accounts and logins), the computer name, and the Google account
  they belong to.
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
  encrypted under the data key, and the searchable metadata (platform, URL,
  username, category, owner, tags, space) is sealed together in a `meta`
  blob. The space-tab order, which names spaces, is sealed the same way
  (the `credentialSpaceOrder` record) and re-keyed on a password change.
  Search runs over the copy decrypted into memory after unlock, which locking
  clears. The Credential Manager has no unencrypted mode: it asks for a
  master password before the first save, and the password can't be removed
  while credentials exist.
- **Decrypted on demand only.** Plaintext is produced only for the one
  credential being shown, copied or edited, and is never held in a store.
  Shown passwords auto-hide after 20 seconds and are cleared immediately on
  lock. Copying goes through the secure clipboard (kept out of clipboard
  history and sync) and honours the auto-clear setting.
- **Confirm before revealing.** Showing or copying a password requires
  Windows Hello (`hello_verify_user`) or, where Hello isn't available, the
  master password. A success is trusted for 60 seconds and ends on lock. This
  is on by default and can be turned off in settings.
- **Tamper-evident audit log.** Create, edit, password change, move to trash,
  restore, permanent delete, password view and password copy are recorded
  locally (newest 2,000 events). Each record's content is AES-GCM-sealed with
  its position bound in, links to the SHA-256 of the previous record, and a
  sealed head names the newest — so editing, reordering, splicing,
  dropping the newest or the oldest records, and planting unsealed records
  are detected and shown ("altered outside CoreTools"). A password change
  never launders a tampered log into a verified one: the new chain records
  that it was reset. A failure to write an event is shown in the log too.
  The log can be exported with its verification result and chain head. It
  never contains a secret. Limits, stated plainly: deleting the whole log,
  or rolling the log and its head back together to an older copy, can't be
  prevented on a device the attacker fully controls.
- **Password changes and restores are atomic.** Changing the master password
  re-encrypts every credential, and a cloud restore writes credentials, in
  the same IndexedDB transaction as the vault config and authenticator
  entries.
- **Access control.** This is a single-user, local application with no
  accounts or server, so there are no roles to enforce. The controls above
  (vault lock, per-reveal re-authentication, audit log) are its
  access-control model. A password reaches the Rust backend only when the
  user copies it, to be placed on the clipboard; "Open login page" passes
  only the URL, which both sides restrict to http(s).
- **Trash.** Deleting is a soft delete: items can be restored for 30 days,
  then are purged permanently.
- **Cloud backup.** Credentials, including trashed ones, back up as their own
  end-to-end encrypted series (`coretools-credmanager-*.json`), under the
  same vault key and with their own SHA-256 checksum. Restoring or rolling
  back the Authenticator never touches credentials, and the reverse holds
  too.

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

- **Security issues**: report them privately through GitHub's private
  vulnerability reporting on the public release repository,
  https://github.com/jaychandra1/artifacts/security/advisories/new (this source
  repository is private, so its Security tab isn't reachable). Reporters
  without a GitHub account can email coretools.works@gmail.com. The full
  policy is at https://coretools-chi.vercel.app/security.html and advertised
  in `/.well-known/security.txt` (RFC 9116): scope, what to include, safe
  harbor for good-faith research, no bug bounty. Reports are acknowledged
  within 3 business days and triaged within 10. Fixes ship as new releases,
  followed by a GitHub Security Advisory on `jaychandra1/artifacts` that
  credits the reporter if they wish. Severity levels and how users are told
  are in `docs/runbooks/README.md`.
- **Non-security bugs**: open a regular issue, and include the app version
  shown in the header — every release is tagged, so the version pins the exact
  code.
- Fixes are released as new tagged versions (see CHANGELOG.md). Installed
  copies with update notifications on see them within a day — a release
  marked as a security fix is flagged as such — and security-relevant
  releases are also flagged on the download page. Nothing installs itself.
