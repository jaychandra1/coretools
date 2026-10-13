# CoreTools

A lightweight, **offline-first** desktop toolkit by **JDG Initiates**, built
with **Tauri v2 + Svelte 5 + TypeScript**.

It bundles six focused utilities:

1. **Diff-Checker** — compare two versions of a file, review each difference,
   choose which side to keep per-change, and export a merged file.
2. **YML-Validator** — validate a Kubernetes manifest, strip server-managed and
   redundant fields, and download a clean, apply-ready result.
3. **Grammar-Polisher** — check grammar (capitalization, spelling,
   apostrophes, tense, agreement, articles — every fix explained), then
   rewrite as Professional, Gen Z, or Complete, with one-click copy. Includes
   an **email mode** that corrects greetings, sign-offs, and tone to corporate
   standards. Rule-based and fully local.
4. **Authenticator** — a full two-factor code generator compatible with the
   open-source [Authenticator browser extension](https://authenticator.cc):
   TOTP / HOTP / Steam Guard / Blizzard codes, QR scanning, and
   import/export of the extension's backup files (including encrypted ones).
   Secrets can be encrypted at rest with a password (PBKDF2 + AES-256-GCM),
   and the desktop build can optionally unlock with **Windows Hello**
   (fingerprint / face / PIN, TPM-backed) and back up to **Google Drive**,
   end-to-end encrypted, for restore after a reinstall or on a new device.
   See [SECURITY.md](./SECURITY.md) for the storage, unlock and backup model.
5. **Credential-Manager** — keep platform logins (URL, username, password,
   notes, category, owner, tags) in the same encrypted vault as the
   Authenticator. It has a table/card view, an eye toggle and one-click copy
   (gated by Windows Hello or the master password), open-login-page,
   search & filters, Trash with restore, a local activity log, and inclusion
   in the encrypted Google Drive backup.
6. **JSON-Studio** — a full JSON workbench: Monaco editor with live
   validation, tree editing, JSON Schema validation & generation, JSONPath /
   JMESPath explorers, side-by-side + semantic diff, JSON repair, OpenAPI
   linting, conversion to/from CSV / XML / YAML / Excel, code generation
   (TypeScript, C#, Java, Python, Go), an analytics dashboard, Web-Worker
   support for large files, and IndexedDB session recovery. See
   [src/lib/core/json-studio/README.md](./src/lib/core/json-studio/README.md).

The app ships with a premium dark/light theme (toggle in the header; the
choice is kept in memory only — never persisted) and self-hosted Inter
typography, so it makes zero network requests even for fonts.

Everything runs locally, and there is **no telemetry.** The only network
feature is the Authenticator's **opt-in Google Drive backup** (desktop only).
It does nothing until you connect an account, and it only ever uploads data
that was encrypted on your device first. The header badge reads **Offline**
in every tool, and **Online** only while that backup is connected or running.
The three text tools keep everything in memory and write nothing to disk unless
you explicitly save it. Two tools are deliberate exceptions with their own
local IndexedDB databases: the **Authenticator** (its purpose is to keep your
2FA accounts — encrypted with AES-256-GCM once you set a password) and
**JSON-Studio** (crash/reload session recovery for the document you're
editing). See [SECURITY.md](./SECURITY.md) for the full privacy & security
model.

---

## Architecture

```
coretools/
├── src/                        # Frontend (Svelte 5 + TypeScript)
│   ├── App.svelte              # App shell + tab navigation
│   ├── main.ts                 # Entry point
│   ├── app.css                 # Design tokens + base styles (light/dark)
│   └── lib/
│       ├── core/               # Pure, platform-agnostic logic (unit-tested)
│       │   ├── diff.ts             # line diff + two-way merge engine
│       │   ├── diff.test.ts
│       │   ├── yaml-optimizer.ts   # safe K8s parse, validate & clean
│       │   ├── yaml-optimizer.test.ts
│       │   ├── polisher.ts         # rule-based sentence rewriting
│       │   ├── polisher.test.ts
│       │   ├── grammar.ts          # offline grammar checker
│       │   ├── grammar.test.ts
│       │   ├── email.ts            # corporate email correction mode
│       │   ├── email.test.ts
│       │   ├── authenticator/      # 2FA engine (see its README.md)
│       │   │   ├── base32.ts           # RFC 4648 encode/decode
│       │   │   ├── otp.ts              # TOTP/HOTP/Steam/Blizzard (WebCrypto HMAC)
│       │   │   ├── otpauth.ts          # otpauth:// URI parse & build
│       │   │   ├── migration.ts        # Google Authenticator export decoding
│       │   │   ├── vault-crypto.ts     # PBKDF2 + AES-256-GCM vault
│       │   │   ├── legacy-crypto.ts    # extension-backup (CryptoJS) compat
│       │   │   ├── backup.ts           # import/export formats + dedupe
│       │   │   ├── db.ts               # IndexedDB persistence
│       │   │   └── *.test.ts           # RFC vectors + round-trip tests
│       │   └── json-studio/        # JSON workbench engine (see its README.md
│       │       │                     and ARCHITECTURE.md)
│       │       ├── parse.ts / tree-edit.ts / json-diff.ts / repair.ts
│       │       ├── schema-infer.ts / validate.ts / openapi.ts / query.ts
│       │       ├── stats.ts / db.ts (session recovery)
│       │       ├── convert/            # CSV / XML / YAML / XLSX
│       │       ├── codegen/            # TS / C# / Java / Python / Go
│       │       ├── worker/             # large-file Web Worker + client
│       │       └── *.test.ts           # 97 unit tests
│       ├── platform/           # Host abstraction (I/O boundary)
│       │   ├── types.ts            # Platform interface
│       │   ├── tauri.ts            # native dialogs + Rust commands
│       │   ├── browser.ts          # File API + blob download (dev/demo)
│       │   └── index.ts            # runtime detection
│       └── components/         # Reusable UI components
│           ├── FilePanel.svelte
│           ├── DiffViewer.svelte
│           ├── DiffChecker.svelte
│           ├── YamlOptimizer.svelte
│           ├── SentencePolisher.svelte
│           ├── authenticator/      # Authenticator UI (list, dialogs, lock)
│           └── json-studio/        # JSON Studio UI (Monaco, panels, store)
├── src-tauri/                  # Native shell (Rust)
│   ├── src/lib.rs              # Two minimal, guarded I/O commands
│   ├── src/main.rs
│   ├── tauri.conf.json         # Window config + strict CSP
│   ├── capabilities/default.json  # Minimal permission set
│   └── Cargo.toml
└── examples/                   # Demo files
    ├── diff/                   # nginx.original.conf / nginx.modified.conf
    └── k8s/                    # messy-deployment.yaml / multi-document.yaml
```

**Separation of concerns**

- **Core logic** (`src/lib/core`) is pure, side-effect-free TypeScript. It has no
  knowledge of the DOM, of Tauri, or of files. This makes it fast, portable, and
  fully unit-testable (`npm test`).
- **The UI** (`src/lib/components`) only renders state and calls into core logic.
- **The platform layer** (`src/lib/platform`) is the *only* code that touches
  files, and it does so exclusively through user-initiated dialogs.
- **The Rust backend** (`src-tauri`) exposes just two guarded commands
  (read/write a user-selected text file). No business logic lives there.

---

## Prerequisites

- **Node.js** ≥ 18
- **Rust** (stable) + Cargo — required only to run/build the native desktop app.
  Install via <https://rustup.rs>. See the Tauri v2 prerequisites for the
  platform-specific system dependencies (WebView2 on Windows, etc.).

> You can develop and test the entire frontend (both features + the test suite)
> **without Rust** — see "Browser preview" below.

## Getting started

```bash
npm install
```

### Run the full desktop app (requires Rust)

```bash
npm run tauri dev      # dev build with hot reload
npm run tauri build    # production bundle (installer / executable)
```

> **Icons:** `tauri build` expects the icon files listed in
> `src-tauri/tauri.conf.json`. Generate a set from any square PNG with:
> ```bash
> npm run tauri icon path/to/logo.png
> ```

### Browser preview (no Rust needed)

The UI runs in a normal browser via Vite. File loading uses the browser File
API and "save" triggers a download — behaviourally identical to the desktop
flow, and handy for quick demos.

```bash
npm run dev            # http://localhost:1420
```

### Quality checks

```bash
npm test               # run the unit test suite (Vitest)
npm run check          # type-check .ts and .svelte with svelte-check
```

---

## Using the tools

### File Difference Checker

1. Load a file into **Original (left)** and another into **Modified (right)**
   (or paste directly).
2. Click **Compare**. Each differing region becomes a numbered change.
3. For each change, choose **Keep original** or **Keep modified**. Use the bulk
   buttons to accept one side everywhere.
4. Click **Save merged file…** to export the result.

Try it with `examples/diff/nginx.original.conf` and
`examples/diff/nginx.modified.conf`.

### YML-Validator

1. Load or paste a Kubernetes manifest (single- or multi-document).
2. Click **Optimize**. The full rule set, in order:

   **Input sanitation**
   - Non-YAML noise stripped before parsing: Markdown code fences,
     shell prompts (`$ kubectl …`), and heredoc wrappers (`cat <<EOF` / `EOF`).

   **Field-name correction** (fixes `kubectl apply` strict-decoding rejections)
   - Wrong-cased field names renamed to the canonical camelCase form the API
     expects (`serviceaccount` → `serviceAccountName`, `imagepullsecrets` →
     `imagePullSecrets`, `mountpath` → `mountPath`, ~150 known fields).
   - Deprecated aliases upgraded (`serviceAccount` → `serviceAccountName`).
   - A misspelled field that duplicates an existing canonical one is dropped.
   - User-data maps are never touched: keys under `labels`, `annotations`,
     `data`, `stringData`, `binaryData`, `matchLabels`, `nodeSelector`,
     `limits`, and `requests` are data, not schema fields.

   **Mandatory-field repair** (defaults are added only when missing — existing
   values are never overwritten, and every addition is logged)
   - `apiVersion` inferred from `kind` for ~30 standard kinds
     (Deployment → `apps/v1`, Ingress → `networking.k8s.io/v1`, …).
   - `metadata.name` defaulted to `unnamed-<kind>` (rename before applying).
   - Workloads (Deployment/StatefulSet/DaemonSet/ReplicaSet):
     `spec.template` (minimal pod template with a placeholder image),
     `spec.template.metadata.labels`, and `spec.selector.matchLabels` set to
     match the template labels. StatefulSet also gets `spec.serviceName`.
   - Job: minimal `spec.template` with `restartPolicy: Never`.
   - Service: `spec.selector` (`app: <name>`) and `spec.ports`
     (port 80) defaults.

   **Cleanup**
   - **Strip annotations** (optional, checkbox next to Optimize — off by
     default): removes every `metadata.annotations` block, top-level and pod
     template. Kept by default because annotations are often functional
     (observability injection, ingress behavior, GitOps hints).
   - Server-managed fields removed (`creationTimestamp`, `resourceVersion`,
     `uid`, `selfLink`, `generation`, `managedFields`, `finalizers`).
   - Cluster-reconciled top-level `status` block removed.
   - Tooling annotations removed
     (`kubectl.kubernetes.io/last-applied-configuration`,
     `deployment.kubernetes.io/revision`).
   - `null` values and empty maps/arrays removed.

   **Schema validation** (after repair, so errors mean “could not fix”)
   - Required scaffolding: `apiVersion`, `kind`, `metadata.name`.
   - Workloads: `spec.selector` and `spec.template` present, and
     `selector.matchLabels` actually matches the template labels.
   - Service: `spec.ports` present.

   **Canonical formatting**
   - Conventional key order (`apiVersion`, `kind`, `metadata`, `spec`;
     `replicas`, `selector`, `template` inside workload specs; `metadata`
     before `spec` in pod templates), 2-space indent, no blank lines, one
     `---` separator per document.

3. Review the **Changes applied** list (every removal *and* addition is logged
   with a reason), then **Copy** the result or **Download…** it as a file.

Try it with `examples/k8s/messy-deployment.yaml` and
`examples/k8s/multi-document.yaml`.

### Grammar-Polisher

1. Choose the input type — **Sentence** or **Email** — then paste your text.
2. Pick a rewrite style (**Professional**, **Gen Z**, or **Complete**) and hit
   **Check & Polish**. Corrections appear itemized beside the output, each
   with the original text, the fix, and the reason. **Copy** grabs the result.

**Grammar rules applied** (deterministic, rule-based — no AI, fully offline):

| Category | Examples |
| --- | --- |
| Capitalization | sentence starts; standalone `i` → `I` |
| Spelling | `becuase` → `because`, `definately` → `definitely`, … |
| Apostrophes | `dont` → `don't`, `im` → `I'm`, `its a` → `it's a` |
| Tense consistency | `has went` → `has gone`, `didn't went` → `didn't go`, … |
| Subject–verb agreement | `he don't` → `he doesn't`, `we was` → `we were` |
| Modal + "of" | `should of` → `should have` |
| Articles | `a apple` → `an apple` (with `a university`-style exceptions) |
| Punctuation & spacing | end punctuation, `!!` / `..` collapse, repeated words, extra spaces |

**Email mode — corporate communication standards** (structural fixes always
follow professional conventions; the style choice applies to the body):

- **Greeting**: added if missing (`Hi [Name],`); casual openers (`hey`, `yo`)
  normalized to `Hi` with the recipient's name capitalized.
- **Sign-off**: added if missing (`Best regards,` + `[Your Name]`); casual
  closings (`cheers`, `thx`, `br`) replaced with corporate-standard ones.
- **Tone**: all-caps shouting softened (business acronyms like `EOD`, `FYI`,
  `KPI` are preserved); exclamation marks replaced with periods
  (kept in Gen Z style).
- **Structure**: greeting / body paragraphs / sign-off separated by blank
  lines; each paragraph gets the full grammar check and style rewrite.

### Authenticator

1. **Add accounts** — scan a QR code with the camera, upload/paste a QR
   screenshot, or enter the Base32 secret manually. `otpauth://` URIs and
   Google Authenticator export QRs (`otpauth-migration://`) are both
   understood.
2. **Use codes** — codes tick from a shared timer with a countdown ring;
   click a code to copy it (optional 30 s clipboard auto-clear). Press **/**
   to jump to search. **Edit** mode enables rename, delete, pin-to-top and
   drag-to-reorder.
3. **Encrypt** — set an encryption password in Settings (independent of
   anything else). Secrets are then stored AES-256-GCM-encrypted, and the
   section locks on load and after a configurable idle timeout. Without a
   password, secrets are stored unencrypted and a persistent warning is shown.
4. **Import / Export** — round-trips the Authenticator browser extension's
   JSON backups (plaintext *and* password-encrypted), otpauth URI lists, a
   modern encrypted format (this app only), and per-account QR codes with a
   print-all view. Imports show a preview and skip duplicates; exports are
   generated entirely on-device.
5. **Back up to Google Drive** (desktop) — in Settings, set an encryption
   password, then **Connect Google Account**. Every change is then backed up
   automatically, end-to-end encrypted with that password, into a hidden
   app-only folder in your Drive. The last 10 versions are kept. Settings shows
   the account, status and last backup, with **Backup now**, **Restore
   backup**, **Disconnect** and **Delete cloud backups**. After a reinstall or
   on a new device, choose **Restore from Google Drive**, sign in, and enter
   the same password; Windows Hello verifies you before anything is restored.
   If two devices back up to one account, the app asks you to merge rather
   than overwrite. Release builds need a Google OAuth client — see
   [DEPLOYMENT.md](./DEPLOYMENT.md#4-cloud-backup-google-sign-in-setup).

See [src/lib/core/authenticator/README.md](./src/lib/core/authenticator/README.md)
for the feature's full design and security notes.

### JSON-Studio

1. **Edit** — the Monaco editor validates as you type (status bar + red
   squiggles). Toolbar: **Format / Minify / Sort keys / Repair**, indent
   selection, Open/Save. Shortcuts: `Ctrl+Shift+F/M/S/R`, `Alt+1…9` to switch
   tools (full list behind the `?` button).
2. **Explore** — **Tree** for inline structural editing; **Query** for
   JSONPath and JMESPath with per-match pointers; **Analytics** for node,
   type, depth and key statistics.
3. **Verify** — **Schema** validates against JSON Schema (or generates one
   from the document); **OpenAPI** lints 3.0/3.1/Swagger 2.0 documents (JSON
   or YAML); **Diff** compares against a pasted version side-by-side plus a
   formatting-independent semantic changelist.
4. **Transform** — **Convert** to/from CSV, XML, YAML and Excel;
   **Codegen** emits TypeScript, C#, Java, Python or Go types from the
   document.

Documents ≥ 1 MB are processed in a Web Worker so the UI stays responsive,
and the session autosaves locally for crash recovery (restore/discard banner
on return). See
[src/lib/core/json-studio/README.md](./src/lib/core/json-studio/README.md)
and [ARCHITECTURE.md](./src/lib/core/json-studio/ARCHITECTURE.md).

---

## Testing

The core logic is covered by unit tests (`npm test`): the diff/merge engine,
the YAML optimizer, the grammar checker, the sentence polisher, and the email
correction mode, including validation and safe-parsing edge cases. The
Authenticator engine is tested against the official RFC 4226/6238 test
vectors, Google-migration payload fixtures, and full backup round-trips
(plaintext and encrypted). JSON Studio's engine has 97 tests covering
parsing/positioned errors, tree edits, schema inference + validation,
OpenAPI rules, JSONPath/JMESPath, semantic diff, repair, stats, all four
format conversions (including a real .xlsx zip round-trip), and all five
code generators.

## License

MIT.
