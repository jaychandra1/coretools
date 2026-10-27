<script module lang="ts">
  import { WritingChecker } from "../writing/checker";

  // One checker for the app's lifetime: its engine takes a moment to load,
  // so switching tabs and back shouldn't load it again. The draft is kept in
  // memory only — it's never written to disk.
  const checker = new WritingChecker();
  let draft = "";
</script>

<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { diffWordsWithSpace } from "diff";
  import {
    applyAll,
    CATEGORY_LABELS,
    countWords,
    fixLabel,
    fixRange,
    hasSingleFix,
    ignoreKey,
    issueAt,
    messageParts,
    rebase,
    segments,
    stillValid,
    visibleIssues,
    type Fix,
    type Issue,
    type IssueCategory,
  } from "../core/writing/issues";
  import { checkEmail } from "../core/writing/email-checks";
  import { DIALECT_LABELS, isDialectId, type DialectId } from "../core/writing/dialects";
  import { rewrite, TONES, type Tone } from "../core/writing/rewrite";
  import { readSetting, writeSetting } from "../local-setting";
  import { copyText } from "../secure-clipboard";
  import { noteFailure } from "../diagnostics";

  const MAX_LENGTH = 20_000;
  const DIALECT_KEY = "coretools.writing.dialect";
  const EMAIL_KEY = "coretools.writing.email";
  const WORDS_KEY = "coretools.writing.dictionary";

  function savedWords(): string[] {
    try {
      const list: unknown = JSON.parse(readSetting(WORDS_KEY) ?? "[]");
      return Array.isArray(list) ? list.filter((w): w is string => typeof w === "string").slice(0, 2000) : [];
    } catch {
      return [];
    }
  }

  let text = $state(draft);
  let dialect = $state<DialectId>(isDialectId(readSetting(DIALECT_KEY)) ? (readSetting(DIALECT_KEY) as DialectId) : "american");
  let emailMode = $state(readSetting(EMAIL_KEY) === "on");
  let words = $state<string[]>(savedWords());
  /** Harper's issues for the text as last checked, kept in place while typing. */
  let found = $state<Issue[]>([]);
  let ignored = $state(new Set<string>());
  let status = $state<"idle" | "loading" | "checking" | "ready" | "error">("idle");
  let failure = $state("");
  let engineReady = false;
  let selectedId = $state<string | null>(null);
  let filter = $state<IssueCategory | "all">("all");
  let tone = $state<Tone | null>(null);
  let note = $state("");
  let input: HTMLTextAreaElement;
  let backdrop: HTMLDivElement;
  let list = $state<HTMLUListElement>();

  $effect(() => {
    draft = text;
  });

  const all = $derived(
    visibleIssues([...found, ...(emailMode ? checkEmail(text) : [])], ignored).filter((issue) => stillValid(text, issue)),
  );
  const shown = $derived(filter === "all" ? all : all.filter((issue) => issue.category === filter));
  const counts = $derived(
    all.reduce(
      (acc, issue) => ({ ...acc, [issue.category]: acc[issue.category] + 1 }),
      { spelling: 0, grammar: 0, style: 0, email: 0 } as Record<IssueCategory, number>,
    ),
  );
  const fixable = $derived(all.filter(hasSingleFix).length);
  const runs = $derived(segments(text, all));
  const wordCount = $derived(countWords(text));
  const rewritten = $derived(tone ? rewrite(text, tone) : null);
  const changes = $derived.by(() => {
    if (!tone || rewritten === null || rewritten === text) return null;
    try {
      return diffWordsWithSpace(text, rewritten, { timeout: 1500 }) ?? null;
    } catch {
      return null;
    }
  });
  const summary = $derived(
    status === "loading"
      ? "Loading the checker…"
      : all.length === 0
        ? text.trim() && status === "ready"
          ? "No issues found"
          : ""
        : `${all.length} suggestion${all.length === 1 ? "" : "s"}`,
  );

  /* ----------------------------- checking ----------------------------- */

  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(delay = 350) {
    clearTimeout(timer);
    timer = setTimeout(check, delay);
  }

  async function check() {
    const snapshot = text;
    if (!snapshot.trim()) {
      found = [];
      status = engineReady ? "ready" : "idle";
      return;
    }
    status = engineReady ? "checking" : "loading";
    try {
      const result = await checker.check(snapshot, dialect, words);
      if (result === null) return; // a newer check replaced this one
      engineReady = true;
      failure = "";
      // The text may have moved on while the check ran.
      found = rebase(result, snapshot, text);
      status = "ready";
      if (text !== snapshot) schedule();
    } catch (e) {
      status = "error";
      failure = "The checker couldn't start. Check that you're online the first time it loads in the browser, then try again.";
      noteFailure("writing", "checker failed", e);
    }
  }

  // Coming back to the tab: check the draft it reopened with.
  if (draft.trim()) schedule(0);
  onDestroy(() => clearTimeout(timer));

  function edited(value: string) {
    found = rebase(found, text, value);
    text = value;
    schedule();
  }

  /* ------------------------------ editing ------------------------------ */

  /**
   * Replace [start, end) with `replacement` through the browser's own
   * editing, so Ctrl+Z undoes it like typing would.
   */
  async function replaceRange(start: number, end: number, replacement: string) {
    input.focus();
    input.setSelectionRange(start, end);
    const done =
      replacement === ""
        ? start === end || document.execCommand("delete")
        : document.execCommand("insertText", false, replacement);
    if (!done) {
      edited(text.slice(0, start) + replacement + text.slice(end));
      await tick();
      input.setSelectionRange(start + replacement.length, start + replacement.length);
    }
  }

  async function apply(issue: Issue, fix: Fix) {
    if (!stillValid(text, issue)) return;
    const range = fixRange(issue, fix);
    selectedId = null;
    await replaceRange(range.start, range.end, range.text);
    schedule(0);
  }

  async function fixAll() {
    const result = applyAll(text, all);
    if (!result.applied) return;
    await replaceRange(0, text.length, result.text);
    showNote(`Fixed ${result.applied} issue${result.applied === 1 ? "" : "s"} — Ctrl+Z undoes it.`);
    schedule(0);
  }

  function ignore(issue: Issue) {
    ignored = new Set([...ignored, ignoreKey(issue)]);
    if (selectedId === issue.id) selectedId = null;
  }

  function addWord(word: string) {
    const clean = word.trim();
    if (!clean || words.includes(clean)) return;
    words = [...words, clean];
    writeSetting(WORDS_KEY, JSON.stringify(words));
    found = found.filter((issue) => !(issue.category === "spelling" && issue.problem === clean));
    schedule(0);
  }

  function clearWords() {
    words = [];
    writeSetting(WORDS_KEY, null);
    schedule(0);
  }

  function setDialect(value: string) {
    if (!isDialectId(value)) return;
    dialect = value;
    writeSetting(DIALECT_KEY, value);
    schedule(0);
  }

  function setEmailMode(on: boolean) {
    emailMode = on;
    writeSetting(EMAIL_KEY, on ? "on" : null);
  }

  /* ----------------------------- selection ----------------------------- */

  /** The caret moved: select the issue under it, if any. */
  async function caretMoved() {
    const hit = issueAt(all, input.selectionStart);
    selectedId = hit?.id ?? null;
    if (hit && filter !== "all" && hit.category !== filter) filter = "all";
    await tick();
    list?.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }

  /** A card was picked: highlight its text and scroll the editor to it. */
  async function select(issue: Issue) {
    selectedId = issue.id;
    await tick();
    const mark = backdrop.querySelector<HTMLElement>(`[data-issue="${CSS.escape(issue.id)}"]`);
    if (mark) input.scrollTop = Math.max(0, mark.offsetTop - input.clientHeight / 3);
  }

  function syncScroll() {
    backdrop.scrollTop = input.scrollTop;
    backdrop.scrollLeft = input.scrollLeft;
  }

  /* ------------------------------- misc -------------------------------- */

  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  function showNote(message: string) {
    note = message;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (note = ""), 4000);
  }

  async function copy(value: string) {
    try {
      await copyText(value);
      showNote("Copied.");
    } catch (e) {
      noteFailure("writing", "copy failed", e);
      showNote("Couldn't copy — select the text and press Ctrl+C.");
    }
  }

  async function useRewrite() {
    if (rewritten === null || rewritten === text) return;
    await replaceRange(0, text.length, rewritten);
    tone = null;
    showNote("Rewritten — Ctrl+Z undoes it.");
    schedule(0);
  }

  function location(issue: Issue): string {
    if (issue.end > issue.start) return "";
    return issue.start === 0 ? "At the start" : "At the end";
  }
</script>

<section class="writer">
  <p class="intro muted">
    Spelling, grammar and style suggestions as you type — and, if you like, a
    rewrite in another tone. It all runs on this device; nothing you type is
    sent anywhere.
  </p>

  <div class="layout">
    <div class="main">
      <div class="toolbar">
        <label class="inline">
          <span class="sr-only">Language</span>
          <select value={dialect} onchange={(e) => setDialect(e.currentTarget.value)} aria-label="English dialect">
            {#each Object.entries(DIALECT_LABELS) as [id, label] (id)}
              <option value={id}>{label}</option>
            {/each}
          </select>
        </label>
        <label class="inline check">
          <input type="checkbox" checked={emailMode} onchange={(e) => setEmailMode(e.currentTarget.checked)} />
          It's an email
        </label>
        <span class="spacer"></span>
        <span class="muted count">
          {wordCount.toLocaleString()} word{wordCount === 1 ? "" : "s"} · {text.length.toLocaleString()}{text.length > MAX_LENGTH * 0.9 ? ` / ${MAX_LENGTH.toLocaleString()}` : ""} characters
        </span>
        <button onclick={() => copy(text)} disabled={!text}>Copy</button>
      </div>

      <div class="editor">
        <!-- Must reproduce the text exactly (white-space: pre-wrap): keep this on one line. -->
        <div class="backdrop" bind:this={backdrop} aria-hidden="true">{#each runs as run, i (i)}{#if run.issue}<mark data-issue={run.issue.id} class:active={run.issue.id === selectedId} style="--c: var(--c-{run.issue.category})">{run.text}</mark>{:else}{run.text}{/if}{/each}{text.endsWith("\n") ? " " : ""}</div>
        <textarea
          bind:this={input}
          value={text}
          oninput={(e) => edited(e.currentTarget.value)}
          onscroll={syncScroll}
          onclick={caretMoved}
          onkeyup={(e) => (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") && caretMoved()}
          maxlength={MAX_LENGTH}
          spellcheck="false"
          autocomplete="off"
          aria-label="Your text"
          aria-describedby="writing-summary"
          placeholder="Type or paste your text here — e.g. “The the report is due tommorow and we recieve feedback alot.”"
        ></textarea>
      </div>

      <div class="rewrite">
        <span class="label">Rewrite tone</span>
        <div class="tones" role="radiogroup" aria-label="Rewrite tone">
          {#each Object.entries(TONES) as [id, t] (id)}
            <button
              type="button"
              role="radio"
              aria-checked={tone === id}
              class:active={tone === id}
              title={t.hint}
              disabled={!text.trim()}
              onclick={() => (tone = tone === id ? null : (id as Tone))}
            >
              {t.label}
            </button>
          {/each}
        </div>
      </div>

      {#if tone}
        <div class="rewritten">
          <div class="head">
            <span class="label">{TONES[tone].label}</span>
            <span class="muted hint">{TONES[tone].hint}</span>
          </div>
          {#if rewritten === null || rewritten === text}
            <p class="muted">Nothing to change for this tone — your text already reads that way.</p>
          {:else}
            <!-- white-space: pre-wrap: keep this on one line. -->
            <p class="preview">{#if changes}{#each changes as part, i (i)}{#if part.added}<ins>{part.value}</ins>{:else if part.removed}<del>{part.value}</del>{:else}{part.value}{/if}{/each}{:else}{rewritten}{/if}</p>
            <div class="actions">
              <button class="primary" onclick={useRewrite}>Use this version</button>
              <button onclick={() => copy(rewritten ?? "")}>Copy</button>
              <button onclick={() => (tone = null)}>Close</button>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <aside class="panel" aria-label="Suggestions">
      <div class="panel-head">
        <span id="writing-summary" class="summary" aria-live="polite">{summary}</span>
        {#if status === "checking"}<span class="muted small">Checking…</span>{/if}
        {#if fixable > 1}
          <button class="small-btn" onclick={fixAll} title="Applies every suggestion that has exactly one fix">
            Fix {fixable}
          </button>
        {/if}
      </div>

      {#if status === "loading"}
        <p class="muted small">Loading the checker — the first time takes a few seconds.</p>
      {:else if status === "error"}
        <p class="error small">{failure}</p>
        <button onclick={() => schedule(0)}>Try again</button>
      {/if}

      {#if all.length}
        <div class="filters" role="group" aria-label="Show">
          <button class:active={filter === "all"} onclick={() => (filter = "all")}>All {all.length}</button>
          {#each Object.entries(CATEGORY_LABELS) as [id, label] (id)}
            {#if counts[id as IssueCategory]}
              <button
                class:active={filter === id}
                style="--c: var(--c-{id})"
                onclick={() => (filter = id as IssueCategory)}
              >
                <span class="dot" aria-hidden="true"></span>{label} {counts[id as IssueCategory]}
              </button>
            {/if}
          {/each}
        </div>

        <ul class="issues" bind:this={list}>
          {#each shown as issue (issue.id)}
            <li class="card" class:selected={issue.id === selectedId} style="--c: var(--c-{issue.category})">
              <button class="card-head" onclick={() => select(issue)}>
                <span class="dot" aria-hidden="true"></span>
                <span class="title">{issue.title}</span>
                {#if issue.problem.trim()}
                  <span class="problem">{issue.problem}</span>
                {:else if location(issue)}
                  <span class="muted small">{location(issue)}</span>
                {/if}
              </button>
              <p class="message">
                {#each messageParts(issue.message) as part, i (i)}{#if part.code}<code>{part.text}</code>{:else}{part.text}{/if}{/each}
              </p>
              <div class="fixes">
                {#each issue.fixes as fix, i (i)}
                  <button class="fix" onclick={() => apply(issue, fix)}>{fixLabel(fix)}</button>
                {/each}
                <button class="link" onclick={() => ignore(issue)}>Ignore</button>
                {#if issue.category === "spelling" && issue.problem.trim()}
                  <button class="link" onclick={() => addWord(issue.problem)}>Add to dictionary</button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else if status === "ready" && text.trim()}
        <p class="clean">✓ No issues found.</p>
      {:else if !text.trim()}
        <p class="muted small">Suggestions appear here as you type.</p>
      {/if}

      {#if words.length}
        <details class="dictionary">
          <summary class="muted small">Your dictionary: {words.length} word{words.length === 1 ? "" : "s"}</summary>
          <p class="muted small">
            Words you added are never marked as misspelled. They're kept on this device only.
          </p>
          <p class="words">{words.join(", ")}</p>
          <button class="link" onclick={clearWords}>Clear the dictionary</button>
        </details>
      {/if}
    </aside>
  </div>

  {#if note}<p class="note" role="status">{note}</p>{/if}
</section>

<style>
  .writer {
    --c-spelling: #c0392b;
    --c-grammar: #2563eb;
    --c-style: #b45309;
    --c-email: var(--accent);
  }
  :global(:root[data-theme="dark"]) .writer {
    --c-spelling: #ff6b5e;
    --c-grammar: #60a5fa;
    --c-style: #fbbf24;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"])) .writer {
      --c-spelling: #ff6b5e;
      --c-grammar: #60a5fa;
      --c-style: #fbbf24;
    }
  }
  .intro {
    margin: 0 0 14px;
    max-width: 75ch;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(260px, 1fr);
    gap: 16px;
    align-items: start;
  }
  @media (max-width: 860px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .main {
    min-width: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .toolbar .spacer {
    flex: 1;
  }
  .inline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .check input {
    accent-color: var(--accent);
  }
  select {
    font: inherit;
    font-size: 13px;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  .count {
    font-size: 12px;
  }

  /* The editor: a transparent textarea over a layer that draws the underlines.
     Both must lay text out identically, so they share every metric. */
  .editor {
    position: relative;
    background: var(--surface);
    border-radius: var(--radius);
  }
  .backdrop,
  .editor textarea {
    box-sizing: border-box;
    margin: 0;
    padding: 12px 14px;
    border: 1px solid transparent;
    border-radius: var(--radius);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.65;
    letter-spacing: normal;
    tab-size: 4;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
    scrollbar-gutter: stable;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    overflow: hidden;
    color: transparent;
    pointer-events: none;
  }
  .editor textarea {
    position: relative;
    display: block;
    width: 100%;
    min-height: 300px;
    overflow-y: auto;
    resize: vertical;
    background: transparent;
    color: var(--text);
    border-color: var(--border);
  }
  mark {
    background: transparent;
    color: transparent;
    text-decoration: underline wavy var(--c);
    text-decoration-thickness: 1.5px;
    text-underline-offset: 4px;
    text-decoration-skip-ink: none;
    border-radius: 2px;
  }
  mark.active {
    background: color-mix(in srgb, var(--c) 18%, transparent);
  }

  .label {
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .rewrite {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  .tones,
  .filters {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tones {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px;
  }
  .tones button {
    border: none;
    background: transparent;
    border-radius: 999px;
    padding: 5px 14px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .tones button:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--text);
  }
  .tones button.active {
    background: var(--accent);
    color: #fff;
  }
  .rewritten {
    margin-top: 12px;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    padding: 12px 14px;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .rewritten .head {
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .hint,
  .small {
    font-size: 12px;
  }
  .preview {
    margin: 10px 0;
    font-size: 15px;
    line-height: 1.65;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  ins {
    text-decoration: none;
    background: var(--added-bg);
    color: var(--added-fg);
    border-radius: 3px;
  }
  del {
    background: var(--removed-bg);
    color: var(--removed-fg);
    border-radius: 3px;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .panel {
    position: sticky;
    top: 8px;
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    max-height: calc(100vh - 120px);
    overflow: auto;
  }
  @media (max-width: 860px) {
    .panel {
      position: static;
      max-height: none;
    }
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    min-height: 28px;
  }
  .summary {
    font-weight: 600;
    font-size: 13.5px;
    flex: 1;
  }
  .small-btn {
    font-size: 12px;
    padding: 4px 10px;
  }
  .filters {
    margin-bottom: 10px;
  }
  .filters button {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .filters button.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c, var(--text-muted));
    flex: none;
  }
  .issues {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .card {
    border: 1px solid var(--border);
    border-left: 3px solid var(--c);
    border-radius: 6px;
    padding: 8px 10px;
  }
  .card.selected {
    border-color: var(--c);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 25%, transparent);
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    border: none;
    background: transparent;
    padding: 0;
    text-align: left;
    font-size: 13px;
  }
  .title {
    font-weight: 600;
  }
  .problem {
    font-family: var(--mono);
    font-size: 12px;
    background: color-mix(in srgb, var(--c) 12%, transparent);
    border-radius: 4px;
    padding: 0 5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .message {
    margin: 6px 0;
    font-size: 12.5px;
    line-height: 1.5;
  }
  .message code {
    font-family: var(--mono);
    font-size: 11.5px;
    background: var(--surface-2);
    padding: 0 4px;
    border-radius: 4px;
  }
  .fixes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .fix {
    font-size: 12.5px;
    padding: 3px 10px;
    border-color: var(--c);
    color: var(--text);
    font-weight: 600;
  }
  .link {
    border: none;
    background: transparent;
    padding: 2px 4px;
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: underline;
  }
  .link:hover:not(:disabled) {
    color: var(--text);
  }
  .clean {
    color: var(--added-fg);
    font-size: 13.5px;
    margin: 4px 0;
  }
  .error {
    color: var(--danger);
  }
  .dictionary {
    margin-top: 12px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .dictionary summary {
    cursor: pointer;
  }
  .words {
    font-size: 12.5px;
    overflow-wrap: anywhere;
    margin: 6px 0;
  }
  .note {
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--text);
    color: var(--bg);
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 13px;
    z-index: 20;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
