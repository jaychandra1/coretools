# Privacy & Security Model

CoreTools is designed to be a **trustworthy, fully offline** local tool. This
document describes the concrete measures that back that claim, so the design can
be audited rather than taken on faith.

## 1. Fully offline — no network, no telemetry

- **No network code.** The application makes no HTTP/WebSocket/fetch calls. There
  is no analytics SDK, no update pinger, no crash reporter, and no external font
  or asset loading.
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

## 2. In-memory only — nothing is persisted implicitly

- All diffing and YAML processing happens on in-memory strings in the frontend.
- **The app never writes to disk on its own.** No cache, no temp files, no logs
  of user content, no local storage, no databases.
- The **only** way data leaves the app is when *you* pick a destination in the
  native **Save** dialog. Loading a file likewise only happens through a native
  **Open** dialog that you drive.
- The Rust backend does not log file contents.

## 3. Minimal, guarded native surface

The Rust backend (`src-tauri/src/lib.rs`) exposes exactly two commands:

| Command | Purpose | Guards |
| --- | --- | --- |
| `read_text_file(path)` | Read a user-selected file | Path must originate from the native open-dialog; must be a regular file; rejected if larger than 50 MiB; read as UTF-8 only |
| `write_text_file(path, contents)` | Write to a user-selected path | Path must originate from the native save-dialog |

No business logic runs in the backend, minimising the trusted native surface. No
paths are ever constructed from untrusted/manifest content — they come only from
dialog results.

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
  fully unit-tested.
- **UI** (`src/lib/components`) renders state only.
- **Platform layer** (`src/lib/platform`) is the single I/O boundary.
- **Rust backend** is a thin, guarded I/O shell.

This layering means a reviewer can verify the security-relevant behaviour by
reading a small number of well-isolated files.

## 7. Dependency posture

- Runtime dependencies are intentionally few: `yaml` (safe parsing) and `diff`
  (line diffing), plus the Tauri API/dialog packages. Production dependencies are
  audited (`npm audit --omit=dev`) and currently report **0 vulnerabilities**.
- Build-time tooling (Vite/esbuild) never ships in the packaged application, so
  dev-server advisories do not affect the distributed binary.

## Reporting

Because the app is offline and local, the primary risk surface is the parsing/
merging logic itself. Issues can be raised against this repository.
