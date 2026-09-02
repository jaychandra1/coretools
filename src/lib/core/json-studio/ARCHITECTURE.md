# JSON Studio — Architecture

## Layering

JSON Studio follows the CoreTools house rule: **pure logic in
`src/lib/core/json-studio` (framework-free, unit-tested), UI in
`src/lib/components/json-studio` (Svelte 5 runes), I/O only at named
boundaries.** A reviewer can audit the security-relevant behaviour by reading
the two boundary files (`db.ts`, `worker/`) plus the platform layer.

```
src/lib/core/json-studio/           pure TypeScript (no DOM, no I/O)
├── types.ts            JsonValue, Result<T>, pointers, shared shapes
├── parse.ts            JSON.parse wrapper with positioned errors; format/minify/sort
├── tree-edit.ts        immutable path-based edits (get/set/delete/rename/insert)
├── schema-infer.ts     example document → JSON Schema draft 2020-12
├── validate.ts         schema validation (@cfworker/json-schema interpreter)
├── openapi.ts          rule-based OpenAPI 3.0/3.1 + Swagger 2.0 linter
├── query.ts            JSONPath (safe eval) + JMESPath wrappers
├── json-diff.ts        structural diff → DiffEntry[] with JSON Pointers
├── repair.ts           jsonrepair wrapper; output re-parsed before accepting
├── stats.ts            single-pass analytics (iterative — no recursion limits)
├── convert/
│   ├── csv.ts          RFC 4180 parser + flattening exporter (no deps)
│   ├── xml.ts          fast-xml-parser round-trip
│   ├── yaml.ts         yaml package, core schema, alias cap
│   └── xlsx.ts         hand-rolled OOXML on fflate (zip) + fast-xml-parser
├── codegen/
│   ├── model.ts        example → language-neutral type model (merge/union)
│   └── emitters.ts     TS / C# / Java / Python / Go renderers
├── db.ts               ⚠ storage boundary: IndexedDB session recovery
└── worker/
    ├── json.worker.ts  ⚠ thread boundary: parse/format/minify/stats/infer
    └── client.ts       promise client, ≥1MB threshold, main-thread fallback

src/lib/components/json-studio/     Svelte 5 UI
├── studio-store.svelte.ts  document/schema/right texts, syntax status,
│                           memoized parse, autosave, session restore
├── monaco-setup.ts         Monaco bootstrap: bundled workers, token themes
├── MonacoEditor.svelte     reusable editor (bindable value, markers, reveal)
├── JsonStudio.svelte       root: tool tabs, actions, shortcuts, status bar
├── TreePanel/TreeNode      recursive tree editor
├── DiffPanel               Monaco diff editor + semantic diff list
├── QueryPanel / SchemaPanel / OpenApiPanel / ConvertPanel / CodegenPanel
└── AnalyticsPanel          stat tiles + single-hue bar charts
```

## Data flow

One source of truth: `studioStore.docText` (a string). Everything derives
from it:

```
docText ──(debounce 250ms)──▶ checkSyntax (worker if ≥1MB) ──▶ status bar + Monaco markers
        ──(memoized parse)──▶ parsedValue() ──▶ Tree / Query / Codegen / OpenAPI / Convert
        ──(debounce 800ms)──▶ IndexedDB session autosave
        ──(explicit action)─▶ format/minify/sort/repair ──▶ setDocText (undo lives in Monaco)
```

The parse is memoized on the exact text, so switching panels never re-parses,
and tree edits go value → `JSON.stringify` → `docText`, keeping the string
authoritative. `schemaText` and `rightText` (diff comparison) are secondary
texts with the same autosave.

## Worker strategy

Only dependency-free operations run in the worker (parse/format/minify/
stats/schema-infer) — they cover the operations that scale with document size.
Query/validation libraries stay on the main thread to avoid double-bundling
them; their cost scales with *result* size, which interactive use keeps small.
`worker/client.ts` owns: lazy worker creation, promise correlation, crash
recovery (fail in-flight calls, retry inline, stop using the worker), and the
`typeof Worker === "undefined"` fallback that makes the same code run in
vitest/node.

The worker `parse` op deliberately returns only validity + error coordinates —
structured-cloning a 50 MB tree back to the main thread would defeat the
purpose.

## Security posture

- **No eval anywhere**: schema validation is interpreted
  (`@cfworker/json-schema`), JSONPath filters run `jsonpath-plus`'s jsep-based
  safe evaluator, Monaco ships no `unsafe-eval` requirement. The Tauri CSP is
  unchanged.
- **No network**: all libraries are bundled; the OpenAPI linter skips external
  `$refs` instead of fetching them; QR-free zone — nothing here talks to
  anything.
- **Input limits**: session autosave caps at 5M chars; the Rust binary-write
  command (used by .xlsx export) caps at 100 MiB; YAML parsing caps alias
  expansion; stats/tree use iterative traversal so hostile deep documents
  can't blow the stack.
- **Untrusted content stays data**: documents are never interpreted as
  HTML/markup anywhere in the panel UIs (text nodes only), and repair output
  must re-parse before it replaces the document.
- **Storage boundary**: exactly one (`db.ts`, IndexedDB
  `coretools-json-studio`), documented in SECURITY.md alongside the
  Authenticator's.

## Testing

`npm test` — 97 JSON Studio tests among the suite:

- `parse.test` — positioned errors across V8 message formats, format/minify/
  sort, UTF-8 sizing, escaping
- `tree-edit.test` — every edit op, immutability, structural sharing, error
  cases (duplicate keys, bad paths)
- `schema-infer.test` — formats, required-key merging, unions, and a
  round-trip proof (inferred schema validates its source; wrong data fails)
- `validate.test` — 2020-12 + draft-07, pointer paths, `$ref`, wrong input
- `openapi.test` — valid documents pass; each rule has a failing fixture
- `query.test` — wildcards, filters (safe eval), recursive descent, JMESPath
  projections/functions, error surfaces
- `json-diff.test` — pointer escaping, type changes, arrays, 0/false/null
  distinctions
- `repair.test` — six breakage classes + data preservation
- `stats.test` — counts, rankings, 20k-wide and 5k-deep documents
- `convert.test` — CSV RFC 4180 edge cases + round-trip + precision guard;
  XML attribute round-trip; YAML round-trip + billion-laughs cap; **XLSX
  round-trip through a real zip container**
- `codegen.test` — model merging/naming plus per-language emission assertions

UI behaviour (Monaco mounting, worker bundling, tree editing, session
restore) is verified in the running app; the core logic the UI calls is what
the unit suite pins down.
