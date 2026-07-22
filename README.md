# CoreTools

A lightweight, **fully offline** desktop toolkit by **JDG Initiates**, built
with **Tauri v2 + Svelte 5 + TypeScript**.

It bundles three focused utilities:

1. **Diff-Checker** — compare two versions of a file, review each difference,
   choose which side to keep per-change, and export a merged file.
2. **YML-Validator** — validate a Kubernetes manifest, strip server-managed and
   redundant fields, and download a clean, apply-ready result.
3. **Grammar-Polisher** — check grammar (spelling, apostrophes, agreement,
   articles, and more, with every fix explained), then rewrite the corrected
   sentence as Professional, Gen Z, or Complete — with one-click copy.
   Rule-based and fully local.

The app ships with a premium dark/light theme (toggle in the header; the
choice is kept in memory only — never persisted) and self-hosted Inter
typography, so it makes zero network requests even for fonts.

Everything runs locally in memory. There are **no network calls, no telemetry,
and nothing is written to disk unless you explicitly save it.** See
[SECURITY.md](./SECURITY.md) for the full privacy & security model.

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
│       │   └── grammar.test.ts
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
│           └── SentencePolisher.svelte
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

---

## Testing

The core logic is covered by unit tests (`npm test`): the diff/merge engine and
the YAML optimizer, including validation and safe-parsing edge cases.

## License

MIT.
