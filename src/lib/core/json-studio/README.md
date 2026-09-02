# JSON Studio

A production-grade JSON workbench built into CoreTools — validation, tree
editing, schema tooling, queries, diffing, repair, OpenAPI linting, format
conversion, code generation and document analytics, all fully offline.

## Tools

| Tab | What it does |
| --- | --- |
| **Editor** | Monaco (the VS Code editor) with JSON syntax highlighting, find/replace, undo/redo, bracket matching, and live syntax markers. Format / minify / sort-keys / repair actions with a configurable indent (2/4/tabs). |
| **Tree** | Expandable tree view of the parsed document with inline editing: double-click values or keys, add children to objects/arrays, delete nodes. Typed input rules: valid JSON is taken as typed (`42`, `true`, `{…}`), anything else becomes a string. |
| **Diff** | Monaco's side-by-side diff editor (left: the working document, pretty-printed; right: an editable comparison version) plus a **semantic diff** that ignores formatting and lists added/removed/changed paths as JSON Pointers, with a summary and swap. |
| **Query** | JSONPath explorer (`jsonpath-plus` in `eval: "safe"` mode — filter expressions run through an interpreter, never `eval`) with per-match JSON Pointers, and a JMESPath explorer for projections/reshaping. One-click copy of results. |
| **Schema** | JSON Schema validation (drafts 4, 7, 2019-09, 2020-12 — auto-detected from `$schema`) with live re-validation and pointer-addressed violations, plus **schema generation** from the current document (formats detected, shared keys required, array items merged). |
| **OpenAPI** | Structural linting for OpenAPI 3.0/3.1 and Swagger 2.0 (JSON *or* YAML): required objects, path-template ↔ parameter cross-checks, operation/response shape, `operationId` uniqueness, local `$ref` resolution. |
| **Convert** | JSON ⇄ CSV (RFC 4180, nested structures flattened to `a.b[0]` paths), XML (attribute-preserving), YAML (safe core schema), and Excel `.xlsx` (real zip container, first worksheet ⇄ array of objects). |
| **Codegen** | TypeScript interfaces, C# classes (`System.Text.Json`), Java classes (Jackson), Python dataclasses, and Go structs — inferred from the document, with optional-field detection across array elements and original JSON keys preserved via serialization attributes. |
| **Analytics** | Node/type/depth/key statistics with stat tiles and bar charts; byte size, array/string/number breakdowns. |

## Cross-cutting behavior

- **Large-file support**: parsing, formatting, minifying, stats and schema
  inference for documents ≥ 1 MB run in a **Web Worker**
  (`worker/json.worker.ts`), so the UI never freezes; smaller documents run
  inline (the overhead isn't worth it). The worker is bundled same-origin by
  Vite — no CSP changes. If Workers are unavailable, everything transparently
  falls back to the main thread.
- **Session recovery**: the working texts autosave (debounced 800 ms) to a
  local IndexedDB database (`coretools-json-studio`); after a reload or crash
  a banner offers restore/discard. Sessions above 5M characters are not
  persisted. Nothing ever leaves the device.
- **Keyboard shortcuts**: `Ctrl+Shift+F` format, `Ctrl+Shift+M` minify,
  `Ctrl+Shift+R` repair, `Ctrl+Shift+S` sort keys, `Alt+1…9` switch tools,
  plus Monaco's own `Ctrl+F` / `Ctrl+Z` / `Ctrl+Y` inside the editor. The `?`
  toolbar button lists them.
- **Repair**: `jsonrepair` fixes single quotes, unquoted keys, trailing
  commas, comments, Python literals and truncated documents; the output is
  re-parsed before it replaces anything — a repair that doesn't produce valid
  JSON is rejected.
- **Theming/responsive**: Monaco themes are derived from the app's design
  tokens and follow the light/dark toggle live; below 900 px the side-by-side
  layout stacks.

## Deliberate substitutions (and why)

- **`@cfworker/json-schema` instead of AJV.** AJV compiles schemas with
  `new Function()` — that requires `unsafe-eval`, which the app's CSP forbids
  and SECURITY.md explicitly rules out. The interpreting validator has the
  same standard-keyword semantics at a speed cost that is irrelevant at
  interactive sizes.
- **Hand-rolled `.xlsx` on `fflate` instead of SheetJS.** The npm `xlsx`
  package lags the vendor's own releases and carries unfixed advisories,
  which would break the project's "0 production vulnerabilities" audit gate.
- **monaco-editor pinned to `~0.53`.** Newer releases bundle a `dompurify`
  version with open advisories (same audit gate).
- **Rule-based OpenAPI linting instead of the official meta-schemas.** The
  meta-schemas pull remote `$refs` and draft-04 edge cases; the linter
  encodes the checks that break real tooling and runs 100% offline. External
  `$refs` are skipped, never fetched.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map, data flow and
testing strategy.
