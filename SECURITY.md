# Privacy & Security Model

CoreTools is designed to be a **trustworthy, fully offline** local tool. This
document describes the concrete measures that back that claim, so the design can
be audited rather than taken on faith.

## 1. Fully offline — no network, no telemetry

- **No network code.** The application makes no HTTP/WebSocket/fetch calls. There
  is no analytics SDK, no update pinger, no crash reporter, and no external font
  or asset loading. This includes the Authenticator: QR codes are decoded
  (`jsqr`) and generated (`qrcode`) entirely in-page from canvas pixels and
  `data:` URLs, service icons are locally-computed monogram avatars (no
  favicon fetching), and camera frames never leave the device.
- **Content Security Policy.** The packaged app runs under a strict CSP defined
  in `src-tauri/tauri.conf.json`:
  ```
  default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost;
  object-src 'none'; base-uri 'self'; frame-src 'none'
  ```
  `connect-src` permits only the local Tauri IPC channel — **no remote origin is
  reachable**, so even an accidental network call would be blocked by the
  runtime. `object-src 'none'` and `frame-src 'none'` disable plugins/embeds.
- **No outbound capability is granted.** Tauri's capability model
  (`src-tauri/capabilities/default.json`) grants only `dialog:allow-open` and
  `dialog:allow-save`. There is no HTTP plugin, no shell plugin, and no
  filesystem-scope plugin enabled.

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

The Rust backend (`src-tauri/src/lib.rs`, `src-tauri/src/hello.rs`) exposes
exactly nine commands. **The dialog-origin rule is enforced in Rust, not by
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
| `hello_available()` | Report whether Windows Hello is set up | Read-only capability probe; Windows-only (`false` elsewhere) |
| `hello_create_key(challenge)` | Create/replace the app's Hello key and sign the enrollment challenge | OS shows the Hello verification prompt; challenge limited to 128 bytes; never sees secrets or passwords |
| `hello_sign(challenge)` | Sign the stored challenge to unlock | OS enforces a biometric/PIN verification on **every** call; challenge limited to 128 bytes |
| `hello_delete_key()` | Remove the app's Hello key | Idempotent; used when Hello unlock is disabled |

No business logic runs in the backend, minimising the trusted native surface. No
paths are ever constructed from untrusted/manifest content — they come only from
dialog results. The Hello commands (§8) handle only opaque challenge/signature
byte arrays — vault keys, secrets and passwords never cross the IPC boundary.

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
- **Platform layer** (`src/lib/platform`) is the single file-I/O boundary.
- **Rust backend** is a thin, guarded I/O shell.

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
- Build-time tooling (Vite/esbuild) never ships in the packaged application, so
  dev-server advisories do not affect the distributed binary.

## 8. Authenticator: local persistence & encryption model

The Authenticator (`src/lib/core/authenticator/`,
`src/lib/components/authenticator/`) stores 2FA accounts in a local IndexedDB
database. This section specifies exactly what that means.

### What is stored, and where

- **Database**: IndexedDB `coretools-authenticator`, local to this device
  (the WebView2 profile directory in the packaged app; per-origin browser
  storage in the web preview). It is never synced or transmitted — there is no
  backend and the CSP forbids network access.
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
  never written to `localStorage`/cookies, and never leave the device.
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
