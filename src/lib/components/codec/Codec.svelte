<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import JsonTree from "./JsonTree.svelte";
  import { codec } from "./codec-state.svelte";
  import { searchTools, TABS, toolById, toolsInTab, type TabId, type ToolId } from "../../core/codec/tools";
  import { downloadName, runTool, type CodecInput, type CodecResult } from "../../core/codec/run";
  import { charCount, formatBytes, utf8ByteLength, utf8OrNull } from "../../core/codec/bytes";
  import { detectFormat } from "../../core/codec/inspect";
  import { BCRYPT_COST, BCRYPT_MAX_BYTES } from "../../core/codec/hash";
  import { generateKeyHex, ITERATION_LIMITS } from "../../core/codec/aes";
  import { copySecret } from "../../secure-clipboard";
  import { getPlatform } from "../../platform";

  const platform = getPlatform();
  const where = platform.kind === "tauri" ? "on this device" : "in your browser";
  /** Files larger than this aren't opened (they're read into memory). */
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  /** Typed or pasted input larger than this is refused. */
  const MAX_TEXT_CHARS = 10_000_000;

  const tool = $derived(toolById(codec.tool));
  const options = codec.options;

  let result = $state<CodecResult | null>(null);
  let status = $state<{ kind: "idle" | "working" | "ok" | "error"; message: string }>({ kind: "idle", message: "" });
  /** A run-on-button tool's input or options changed since its last run. */
  let stale = $state(false);
  let flash = $state<{ message: string; error: boolean } | null>(null);
  let dragging = $state(false);
  let showSecret = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  let searchBox: HTMLInputElement | undefined = $state();

  // ---- running ------------------------------------------------------------------

  /** The input as the current tool takes it: a file's bytes, its text, or the typed text. */
  function currentInput(): CodecInput {
    const file = codec.file;
    if (!file) return { text: codec.input };
    if (tool.bytes || file.text === null) return { text: "", file: { name: file.name, bytes: file.bytes } };
    return { text: file.text };
  }

  function workingMessage(id: ToolId): string {
    if (id === "bcrypt") return options.bcryptHash.trim() ? "Checking with bcrypt…" : `Hashing with bcrypt (cost ${options.bcryptCost})…`;
    if (id === "aes-encrypt" || id === "aes-decrypt") {
      return options.aesMode === "passphrase" ? `Deriving the key (${options.iterations.toLocaleString("en")} PBKDF2 rounds)…` : "Working…";
    }
    return "Working…";
  }

  let sequence = 0;
  async function run() {
    const id = codec.tool;
    const current = ++sequence;
    const input = currentInput();
    if (!input.file && !input.text.trim() && id !== "bcrypt") {
      result = null;
      status = { kind: "idle", message: "" };
      return;
    }
    status = { kind: "working", message: workingMessage(id) };
    try {
      const output = await runTool(id, input, $state.snapshot(options));
      if (current !== sequence) return; // a newer run started meanwhile
      result = output;
      stale = false;
      status = { kind: "ok", message: output.kind === "text" ? (output.note ?? "") : "" };
      codec.noteRecent(id);
    } catch (error) {
      if (current !== sequence) return;
      result = null;
      status = { kind: "error", message: error instanceof Error ? error.message : "That didn't work." };
    }
  }

  // Live tools run as you type; the others mark their result out of date.
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const id = codec.tool;
    const text = codec.input;
    const file = codec.file;
    void $state.snapshot(options);
    if (!toolById(id).live) {
      if (untrack(() => result)) stale = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void run(), file || text.length > 1_000_000 ? 300 : 120);
    return () => clearTimeout(timer);
  });

  onDestroy(() => {
    clearTimeout(timer);
    codec.forgetSecrets();
  });

  // ---- navigation ---------------------------------------------------------------

  function selectTool(id: ToolId) {
    if (id === codec.tool) return;
    codec.select(id);
    result = null;
    stale = false;
    status = { kind: "idle", message: "" };
  }

  function selectTab(tab: TabId) {
    codec.query = "";
    selectTool(codec.lastInTab[tab] ?? toolsInTab(tab)[0].id);
    codec.tab = tab;
  }

  const searchResults = $derived(searchTools(codec.query));
  const pinnedTools = $derived(codec.pinned.map(toolById));
  // Recent: tools from other tabs (this tab's are listed anyway), not pinned.
  const recentTools = $derived(
    codec.recent.filter((id) => !codec.pinned.includes(id) && toolById(id).tab !== codec.tab).map(toolById),
  );

  /** "Looks like a JWT" — when the input fits another tool better. */
  const hint = $derived.by(() => {
    if (codec.file || !codec.input.trim() || codec.input.length > 200_000) return null;
    if (status.kind !== "error" && tool.tab !== "decode" && tool.tab !== "inspect") return null;
    return detectFormat(codec.input).find((found) => found.tool !== codec.tool) ?? null;
  });

  // ---- input --------------------------------------------------------------------

  function notify(message: string, error = false) {
    flash = { message, error };
    setTimeout(() => {
      if (flash?.message === message) flash = null;
    }, 2600);
  }

  function setText(text: string) {
    if (text.length > MAX_TEXT_CHARS) {
      notify("That's more than 10 million characters — open it as a file instead.", true);
      return;
    }
    codec.file = null;
    codec.input = text;
  }

  async function paste() {
    try {
      const text = platform.clipboard?.readText ? await platform.clipboard.readText() : await navigator.clipboard.readText();
      if (!text) {
        notify("The clipboard has no text.", true);
        return;
      }
      setText(text);
      notify("Pasted");
    } catch {
      notify("Couldn't read the clipboard — press Ctrl+V in the input instead.", true);
    }
  }

  async function openFile(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      notify(`That file is ${formatBytes(file.size)}; Codec opens files up to 50 MB.`, true);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = utf8OrNull(bytes);
    codec.file = { name: file.name, bytes, text: text !== null && text.length <= MAX_TEXT_CHARS && !text.includes("\0") ? text : null };
    codec.input = "";
    notify(`Opened ${file.name}`);
  }

  function onFilePicked(event: Event) {
    const picked = (event.currentTarget as HTMLInputElement).files?.[0];
    if (picked) void openFile(picked);
    (event.currentTarget as HTMLInputElement).value = "";
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    const dropped = event.dataTransfer?.files?.[0];
    if (dropped) void openFile(dropped);
    else {
      const text = event.dataTransfer?.getData("text/plain");
      if (text) setText(text);
    }
  }

  function clearInput() {
    codec.input = "";
    codec.file = null;
    result = null;
    status = { kind: "idle", message: "" };
  }

  function editFileAsText() {
    if (codec.file?.text != null) setText(codec.file.text);
  }

  // ---- output -------------------------------------------------------------------

  async function copy() {
    if (!result?.text) return;
    await copySecret(result.text);
    notify("Copied");
  }

  async function download() {
    if (!result) return;
    const name = downloadName(codec.tool, result);
    try {
      const saved =
        result.kind === "text" && result.binary ? await platform.saveBinaryFile(name, result.binary) : await platform.saveTextFile(name, result.text);
      notify(saved ? "Saved" : "Save cancelled", !saved);
    } catch {
      notify("Couldn't save the file.", true);
    }
  }

  /** Feed the output to the opposite tool (Encode ↔ Decode). */
  function swap() {
    const next = tool.swap;
    if (!next || !result) return;
    if (result.kind === "text" && result.params && options.aesMode === "key") options.aesIv = result.params.iv;
    if (result.kind === "text" && result.binary) {
      codec.file = { name: "decoded.bin", bytes: result.binary, text: null };
      codec.input = "";
    } else setText(result.text);
    selectTool(next);
    if (!toolById(next).live) void run();
  }

  function onKeydown(event: KeyboardEvent) {
    const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]");
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void run();
    } else if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const index = Number(event.key) - 1;
      if (index >= 0 && index < TABS.length) {
        event.preventDefault();
        selectTab(TABS[index].id);
      } else if (event.key.toLowerCase() === "s" && tool.swap) {
        event.preventDefault();
        swap();
      } else if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        void copy();
      }
    } else if (event.key === "/" && !typing) {
      event.preventDefault();
      searchBox?.focus();
    }
  }

  const inputText = $derived(codec.file ? "" : codec.input);
  const outputBytes = $derived(result?.kind === "text" && result.binary ? result.binary.length : utf8ByteLength(result?.text ?? ""));
  const actionLabel = $derived(
    codec.tool === "bcrypt" ? (options.bcryptHash.trim() ? "Check password" : "Generate hash") : codec.tool === "aes-encrypt" ? "Encrypt" : "Decrypt",
  );
  const bcryptTooLong = $derived(codec.tool === "bcrypt" && utf8ByteLength(codec.input) > BCRYPT_MAX_BYTES);
  const fmtDate = (date: Date) => date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
</script>

<svelte:window onkeydown={onKeydown} />

<section class="codec">
  <header class="intro">
    <p class="muted">
      Encode, decode, transform, inspect, and protect data securely. All operations run locally {where}.
    </p>
    <p class="privacy" role="note">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      All Codec operations run locally {where}. Your data never leaves your device.
    </p>
  </header>

  <div class="nav">
    <div class="tabs" role="tablist" aria-label="Codec categories">
      {#each TABS as tabDef, index (tabDef.id)}
        <button
          role="tab"
          aria-selected={!codec.query && codec.tab === tabDef.id}
          class:active={!codec.query && codec.tab === tabDef.id}
          title="Alt+{index + 1}"
          onclick={() => selectTab(tabDef.id)}>{tabDef.label}</button
        >
      {/each}
    </div>
    <input
      class="search"
      type="search"
      bind:this={searchBox}
      bind:value={codec.query}
      placeholder="Search tools (press /)"
      aria-label="Search Codec tools"
      onkeydown={(event) => {
        if (event.key === "Escape") codec.query = "";
        if (event.key === "Enter" && searchResults[0]) {
          selectTool(searchResults[0].id);
          codec.query = "";
        }
      }}
    />
  </div>

  <div class="layout">
    <nav class="toollist" aria-label="Tools">
      {#snippet item(id: ToolId)}
        {@const def = toolById(id)}
        <button class="tool" class:current={codec.tool === id} aria-current={codec.tool === id ? "true" : undefined} onclick={() => selectTool(id)}>
          <span>{def.name}</span>
          {#if codec.pinned.includes(id)}<span class="star" aria-label="pinned">★</span>{/if}
        </button>
      {/snippet}
      {#if codec.query}
        <h3>Results</h3>
        {#each searchResults as def (def.id)}{@render item(def.id)}{:else}<p class="muted none">No tool matches.</p>{/each}
      {:else}
        {#if pinnedTools.length}
          <h3>Pinned</h3>
          {#each pinnedTools as def (def.id)}{@render item(def.id)}{/each}
        {/if}
        <h3>{TABS.find((tabDef) => tabDef.id === codec.tab)?.label}</h3>
        {#each toolsInTab(codec.tab) as def (def.id)}{@render item(def.id)}{/each}
        {#if recentTools.length}
          <h3>Recent</h3>
          {#each recentTools as def (def.id)}{@render item(def.id)}{/each}
        {/if}
      {/if}
    </nav>

    <div class="workspace">
      <div class="tool-head">
        <div>
          <h2>{tool.name}</h2>
          <p class="muted">{tool.summary}</p>
        </div>
        <button
          class="pin"
          aria-pressed={codec.pinned.includes(tool.id)}
          title={codec.pinned.includes(tool.id) ? "Unpin" : "Pin to the top of the list"}
          onclick={() => codec.togglePin(tool.id)}>{codec.pinned.includes(tool.id) ? "★ Pinned" : "☆ Pin"}</button
        >
      </div>

      <div class="options">
        {#if codec.tool === "base64-encode"}
          <label class="check"><input type="checkbox" bind:checked={options.base64UrlSafe} onchange={() => (options.base64Padding = !options.base64UrlSafe)} /> URL-safe</label>
          <label class="check"><input type="checkbox" bind:checked={options.base64Padding} /> Padding (=)</label>
        {:else if codec.tool === "url-encode"}
          <label>Encode <select bind:value={options.urlMode}>
              <option value="component">a component (query value, path segment)</option>
              <option value="uri">a whole URL (keeps : / ? # &amp;)</option>
              <option value="form">form data (spaces as +)</option>
            </select></label>
        {:else if codec.tool === "url-decode"}
          <label class="check"><input type="checkbox" bind:checked={options.urlPlusAsSpace} /> Read + as a space (form data)</label>
        {:else if codec.tool === "hex-encode"}
          <label>Case <select bind:value={options.hexUpper}><option value={false}>lower</option><option value={true}>UPPER</option></select></label>
          <label>Between bytes <select bind:value={options.hexSeparator}><option value="">nothing</option><option value=" ">space</option><option value=":">colon</option></select></label>
        {:else if codec.tool === "unicode-encode"}
          <label>Style <select bind:value={options.unicodeStyle}>
              <option value="js">\uXXXX (JavaScript, JSON)</option>
              <option value="es6">\u&#123;XXXX&#125; (ES6)</option>
              <option value="html">&amp;#xXXXX; (HTML)</option>
            </select></label>
          <label class="check"><input type="checkbox" bind:checked={options.unicodeAll} /> Escape ASCII too</label>
        {:else if codec.tool === "json-format"}
          <label>Indent <select bind:value={options.jsonIndent}><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">tab</option></select></label>
        {:else if codec.tool === "sha256" || codec.tool === "sha512" || codec.tool === "md5"}
          <label>Output <select bind:value={options.digestEncoding}><option value="hex">hex</option><option value="HEX">HEX</option><option value="base64">Base64</option></select></label>
          {#if codec.tool === "md5"}<span class="badge warn">Not for security — use SHA-256</span>{/if}
        {:else if codec.tool === "bcrypt"}
          <label>Cost <select bind:value={options.bcryptCost} disabled={!!options.bcryptHash.trim()}>
              {#each Array.from({ length: BCRYPT_COST.max - BCRYPT_COST.min + 1 }, (_, i) => BCRYPT_COST.min + i) as cost (cost)}
                <option value={cost}>{cost}{cost === BCRYPT_COST.default ? " (recommended)" : ""}</option>
              {/each}
            </select></label>
          <label class="grow">Check against <input class="mono" bind:value={options.bcryptHash} placeholder="a bcrypt hash ($2b$…) — leave empty to make a new hash" spellcheck="false" autocomplete="off" /></label>
        {:else if codec.tool === "aes-encrypt" || codec.tool === "aes-decrypt"}
          <div class="segmented" role="radiogroup" aria-label="Key">
            <button role="radio" aria-checked={options.aesMode === "passphrase"} class:active={options.aesMode === "passphrase"} onclick={() => (options.aesMode = "passphrase")}>Passphrase</button>
            <button role="radio" aria-checked={options.aesMode === "key"} class:active={options.aesMode === "key"} onclick={() => (options.aesMode = "key")}>Raw key</button>
          </div>
          {#if options.aesMode === "passphrase"}
            <label class="grow">Passphrase
              <span class="secret">
                <input type={showSecret ? "text" : "password"} bind:value={options.passphrase} autocomplete="off" spellcheck="false" placeholder="A long, unique passphrase" />
                <button class="ghost" onclick={() => (showSecret = !showSecret)} aria-label={showSecret ? "Hide passphrase" : "Show passphrase"}>{showSecret ? "Hide" : "Show"}</button>
              </span>
            </label>
            {#if codec.tool === "aes-encrypt"}
              <label>PBKDF2 rounds <input class="narrow" type="number" bind:value={options.iterations} min={ITERATION_LIMITS.min} max={ITERATION_LIMITS.max} step="100000" /></label>
            {/if}
          {:else}
            <label>Cipher <select bind:value={options.aesCipher}><option value="gcm">AES-256-GCM</option><option value="cbc">AES-256-CBC</option></select></label>
            <label class="grow">Key (hex)
              <span class="secret">
                <input class="mono" type={showSecret ? "text" : "password"} bind:value={options.aesKey} autocomplete="off" spellcheck="false" placeholder="64 hex digits" />
                <button class="ghost" onclick={() => (showSecret = !showSecret)} aria-label={showSecret ? "Hide key" : "Show key"}>{showSecret ? "Hide" : "Show"}</button>
                {#if codec.tool === "aes-encrypt"}<button class="ghost" onclick={() => ((options.aesKey = generateKeyHex()), (showSecret = true))}>Generate</button>{/if}
              </span>
            </label>
            <label>IV (hex) <input class="mono iv" bind:value={options.aesIv} spellcheck="false" placeholder={codec.tool === "aes-encrypt" ? "random" : options.aesCipher === "gcm" ? "24 hex digits" : "32 hex digits"} /></label>
            <label>{codec.tool === "aes-encrypt" ? "Output" : "Input"} <select bind:value={options.aesEncoding}><option value="base64">Base64</option><option value="hex">hex</option></select></label>
          {/if}
        {:else if codec.tool === "jwt"}
          <span class="badge warn">Decodes only — the signature is not verified</span>
        {/if}
        {#if !tool.live}
          <span class="run">
            <button class="primary" onclick={() => void run()} disabled={status.kind === "working"}>{actionLabel}</button>
            <kbd>Ctrl+Enter</kbd>
          </span>
        {/if}
      </div>

      {#if hint}
        <p class="hint">
          Looks like <strong>{hint.label}</strong>.
          <button class="link" onclick={() => selectTool(hint.tool as ToolId)}>Open in {toolById(hint.tool as ToolId).name}</button>
        </p>
      {/if}

      <div class="panes">
        <div
          class="pane"
          class:dragging
          role="group"
          aria-label="Input"
          ondragover={(event) => {
            event.preventDefault();
            dragging = true;
          }}
          ondragleave={() => (dragging = false)}
          ondrop={onDrop}
        >
          <div class="pane-head">
            <span class="label">Input</span>
            <span class="actions">
              <button class="small" onclick={paste}>Paste</button>
              <button class="small" onclick={() => fileInput?.click()}>Open file…</button>
              <button class="small" onclick={clearInput} disabled={!codec.input && !codec.file}>Clear</button>
              <input type="file" hidden bind:this={fileInput} onchange={onFilePicked} />
            </span>
          </div>
          {#if codec.file}
            <div class="file">
              <strong>{codec.file.name}</strong>
              <span class="muted">{formatBytes(codec.file.bytes.length)} · {codec.file.text === null ? "binary" : "text"}{tool.bytes ? " · using its exact bytes" : ""}</span>
              <span class="actions">
                {#if codec.file.text !== null}<button class="small" onclick={editFileAsText}>Edit as text</button>{/if}
                <button class="small" onclick={clearInput}>Remove</button>
              </span>
            </div>
          {:else}
            <textarea
              class="mono"
              bind:value={codec.input}
              spellcheck="false"
              autocomplete="off"
              aria-label="Input text"
              placeholder="Type or paste here, or drop a file"
            ></textarea>
          {/if}
          <div class="pane-foot muted">
            {#if codec.file}{formatBytes(codec.file.bytes.length)}{:else}{charCount(inputText).toLocaleString()} characters · {formatBytes(utf8ByteLength(inputText))}{/if}
            {#if bcryptTooLong}<span class="error"> · over bcrypt's 72-byte limit</span>{/if}
          </div>
        </div>

        <div class="pane" role="group" aria-label="Output">
          <div class="pane-head">
            <span class="label">Output</span>
            <span class="actions">
              {#if tool.swap}
                <button class="small" onclick={swap} disabled={!result} title="Alt+S — use the output as input of {toolById(tool.swap).name}">⇄ Swap</button>
              {/if}
              <button class="small" onclick={copy} disabled={!result?.text} title="Alt+C">Copy</button>
              <button class="small" onclick={download} disabled={!result?.text}>Download</button>
            </span>
          </div>

          <div class="out" class:dim={stale || status.kind === "working"} aria-busy={status.kind === "working"}>
            {#if !result}
              <p class="empty muted">
                {#if status.kind === "error"}Fix the input to see a result.{:else if tool.live}The result appears here as you type.{:else}Press {actionLabel} (Ctrl+Enter).{/if}
              </p>
            {:else if result.kind === "text"}
              {#if result.match !== undefined}
                <p class="verdict" class:yes={result.match}>{result.match ? "✓" : "✗"} {result.text}</p>
              {:else if result.binary}
                <pre class="mono dump">{result.text}</pre>
              {:else}
                <textarea class="mono" readonly value={result.text} aria-label="Output text"></textarea>
              {/if}
            {:else if result.kind === "jwt"}
              {@const jwt = result.jwt}
              <div class="report">
                <p class="badges">
                  {#if jwt.encrypted}<span class="badge">Encrypted (JWE): only the header is readable</span>
                  {:else}
                    <span class="badge {jwt.status}">{jwt.status === "active" ? "Not expired" : jwt.status === "expired" ? "Expired" : jwt.status === "not-yet-valid" ? "Not valid yet" : "No expiry"}</span>
                  {/if}
                  {#if jwt.alg}<span class="badge">alg: {jwt.alg}</span>{/if}
                  {#if !jwt.encrypted}<span class="badge">signature: {jwt.signatureBytes} bytes, not verified</span>{/if}
                </p>
                {#each jwt.warnings as warning (warning)}<p class="error">{warning}</p>{/each}
                {#if jwt.times.length}
                  <table class="kv">
                    <tbody>
                      {#each jwt.times as time (time.claim)}
                        <tr><th>{time.label} ({time.claim})</th><td>{fmtDate(time.date)} <span class="muted">— {time.relative}</span></td></tr>
                      {/each}
                    </tbody>
                  </table>
                {/if}
                <h4>Header</h4>
                <pre class="mono">{jwt.header}</pre>
                {#if jwt.payload !== null}
                  <h4>Payload</h4>
                  <pre class="mono">{jwt.payload}</pre>
                {/if}
              </div>
            {:else if result.kind === "tree"}
              <div class="report">
                <p class="muted stats">
                  {result.stats.objects} objects · {result.stats.arrays} arrays · {result.stats.values} values · depth {result.stats.depth}
                </p>
                <JsonTree node={result.tree} />
              </div>
            {:else}
              {@const report = result.report}
              <div class="report">
                <table class="kv">
                  <tbody>
                    <tr><th>Content</th><td><strong>{report.kind}</strong></td></tr>
                    <tr><th>Alphabet</th><td>{report.variant === "either" ? "Standard or URL-safe (no + / - _ used)" : report.variant}</td></tr>
                    <tr><th>Padding</th><td class:error={report.padding === "missing"}>{report.padding}</td></tr>
                    <tr><th>Line breaks</th><td>{report.wrapped ? "Yes (MIME-style wrapping)" : "No"}</td></tr>
                    <tr><th>Size</th><td>{report.chars.toLocaleString()} characters → {formatBytes(report.bytes)}</td></tr>
                  </tbody>
                </table>
                <h4>{report.text !== null ? "Decoded text" : "First bytes"}</h4>
                <pre class="mono">{report.text ?? report.preview}</pre>
              </div>
            {/if}
          </div>

          <div class="pane-foot">
            {#if status.kind === "working"}
              <span class="working"><span class="spinner" aria-hidden="true"></span>{status.message}</span>
            {:else if status.kind === "error"}
              <span class="error" role="alert">{status.message}</span>
            {:else if stale}
              <span class="muted">The input changed — press {actionLabel} again.</span>
            {:else if result}
              <span class="muted">
                {#if result.kind === "text" && result.binary}{formatBytes(outputBytes)} decoded{:else}{charCount(result.text).toLocaleString()} characters · {formatBytes(outputBytes)}{/if}
                {#if status.message}<br />{status.message}{/if}
              </span>
            {/if}
          </div>
        </div>
      </div>

      {#if result?.kind === "text" && result.params}
        {@const params = result.params}
        <div class="params">
          <h4>Encryption parameters</h4>
          <table class="kv">
            <tbody>
              <tr><th>Cipher</th><td>{params.cipher}</td></tr>
              <tr><th>Key</th><td>{params.keySource}</td></tr>
              {#if params.iterations}<tr><th>Iterations</th><td>{params.iterations.toLocaleString("en")}</td></tr>{/if}
              {#if params.salt}<tr><th>Salt</th><td class="mono">{params.salt}</td></tr>{/if}
              <tr><th>IV</th><td class="mono">{params.iv}{#if codec.tool === "aes-encrypt" && options.aesMode === "key"} <span class="muted">— keep it: decryption needs it</span>{/if}</td></tr>
              <tr><th>Integrity</th><td>{params.integrity}</td></tr>
              <tr><th>Ciphertext</th><td>{formatBytes(params.ciphertextBytes)}</td></tr>
            </tbody>
          </table>
        </div>
      {/if}

      <p class="shortcuts muted">
        <kbd>Ctrl+Enter</kbd> run · <kbd>Alt+1–5</kbd> categories · <kbd>Alt+S</kbd> swap · <kbd>Alt+C</kbd> copy output · <kbd>/</kbd> search
      </p>
    </div>
  </div>

  {#if flash}
    <div class="flash" class:error={flash.error} role="status">{flash.message}</div>
  {/if}
</section>

<style>
  .codec {
    position: relative;
  }
  .intro {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 20px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .intro p {
    margin: 0;
    max-width: 70ch;
  }
  .privacy {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    font-size: 12.5px;
    font-weight: 600;
  }
  .nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .tabs {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 9px;
    overflow-x: auto;
    max-width: 100%;
  }
  .tabs button {
    border: none;
    background: transparent;
    border-radius: 6px;
    padding: 6px 16px;
    color: var(--text-muted);
    font-weight: 500;
    white-space: nowrap;
  }
  .tabs button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }
  .search {
    width: min(280px, 100%);
    padding: 7px 12px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }
  .layout {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 18px;
    align-items: start;
  }
  .toollist {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: 8px;
  }
  .toollist h3 {
    margin: 10px 0 4px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .toollist h3:first-child {
    margin-top: 0;
  }
  .tool {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    text-align: left;
    border: 1px solid transparent;
    background: transparent;
    padding: 6px 10px;
  }
  .tool.current {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 25%, transparent);
    font-weight: 600;
  }
  .star {
    color: #d97706;
    font-size: 11px;
  }
  .none {
    margin: 4px 10px;
    font-size: 12.5px;
  }
  .workspace {
    min-width: 0;
  }
  .tool-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .tool-head h2 {
    margin: 0;
    font-size: 17px;
  }
  .tool-head p {
    margin: 3px 0 0;
    font-size: 13px;
  }
  .pin {
    flex: none;
    font-size: 12px;
    padding: 5px 10px;
  }
  .pin[aria-pressed="true"] {
    color: #d97706;
  }
  .options {
    display: flex;
    align-items: center;
    gap: 10px 16px;
    flex-wrap: wrap;
    margin: 14px 0 10px;
    padding: 10px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
  }
  .options label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--text-muted);
  }
  .options label.grow {
    flex: 1 1 260px;
  }
  .options label.grow > :global(input),
  .options .secret {
    flex: 1;
  }
  .options select,
  .options input:not([type="checkbox"]) {
    font: inherit;
    font-size: 13px;
    padding: 5px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    min-width: 0;
  }
  .options .mono,
  .mono {
    font-family: var(--mono);
  }
  .options .narrow {
    width: 110px;
  }
  .options .iv {
    width: 200px;
  }
  .check input {
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
    margin: 0;
  }
  .secret {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .secret input {
    flex: 1;
  }
  .segmented {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 7px;
    overflow: hidden;
  }
  .segmented button {
    border: none;
    border-radius: 0;
    padding: 5px 12px;
  }
  .segmented button.active {
    background: var(--accent);
    color: #fff;
  }
  button.ghost,
  button.small {
    padding: 4px 10px;
    font-size: 12px;
  }
  .run {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  kbd {
    font-family: var(--mono);
    font-size: 11px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text-muted);
  }
  .badge {
    display: inline-block;
    font-size: 11.5px;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .badge.warn,
  .badge.expired,
  .badge.not-yet-valid {
    background: var(--removed-bg);
    color: var(--removed-fg);
    border-color: transparent;
  }
  .badge.active {
    background: var(--added-bg);
    color: var(--added-fg);
    border-color: transparent;
  }
  .hint {
    margin: 0 0 10px;
    font-size: 13px;
  }
  button.link {
    border: none;
    background: none;
    padding: 0 0 0 4px;
    color: var(--accent);
    text-decoration: underline;
    font-weight: 600;
  }
  .panes {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 14px;
  }
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .pane.dragging {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    flex-wrap: wrap;
  }
  .label {
    font-weight: 600;
    font-size: 13px;
  }
  .actions {
    display: inline-flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pane textarea {
    flex: 1;
    width: 100%;
    min-height: 340px;
    resize: vertical;
    border: none;
    outline: none;
    padding: 12px;
    background: transparent;
    color: var(--text);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .out {
    flex: 1;
    min-height: 340px;
    display: flex;
    flex-direction: column;
    transition: opacity 0.15s ease;
  }
  .out.dim {
    opacity: 0.55;
  }
  .out textarea {
    min-height: 340px;
  }
  .empty {
    margin: auto;
    padding: 24px;
    text-align: center;
    font-size: 13px;
  }
  .dump,
  .report pre {
    margin: 0;
    padding: 12px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre;
    overflow: auto;
  }
  .dump {
    flex: 1;
    max-height: 60vh;
  }
  .report {
    padding: 12px;
    overflow: auto;
    max-height: 60vh;
  }
  .report pre {
    background: var(--surface-2);
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .report h4,
  .params h4 {
    margin: 12px 0 6px;
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin: 0 0 8px;
  }
  .stats {
    margin: 0 0 8px;
    font-size: 12px;
  }
  .verdict {
    margin: auto;
    padding: 20px;
    font-size: 15px;
    font-weight: 600;
    color: var(--removed-fg);
    text-align: center;
  }
  .verdict.yes {
    color: var(--added-fg);
  }
  .file {
    flex: 1;
    min-height: 340px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 20px;
    text-align: center;
    word-break: break-all;
  }
  .pane-foot {
    padding: 7px 12px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    min-height: 32px;
  }
  .error {
    color: var(--danger);
  }
  .working {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
  }
  .spinner {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .kv {
    border-collapse: collapse;
    width: 100%;
    font-size: 12.5px;
  }
  .kv th {
    text-align: left;
    font-weight: 600;
    color: var(--text-muted);
    padding: 5px 12px 5px 0;
    white-space: nowrap;
    vertical-align: top;
    width: 1%;
  }
  .kv td {
    padding: 5px 0;
    word-break: break-all;
  }
  .kv tr + tr th,
  .kv tr + tr td {
    border-top: 1px solid var(--border);
  }
  .params {
    margin-top: 14px;
    padding: 4px 14px 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .shortcuts {
    margin: 14px 0 0;
    font-size: 11.5px;
  }
  .flash {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    padding: 8px 16px;
    border-radius: 999px;
    background: var(--text);
    color: var(--bg);
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    z-index: 20;
  }
  .flash.error {
    background: var(--danger);
    color: #fff;
  }
  @media (max-width: 1000px) {
    .panes {
      grid-template-columns: minmax(0, 1fr);
    }
    .pane textarea,
    .out,
    .out textarea,
    .file {
      min-height: 200px;
    }
  }
  @media (max-width: 760px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .toollist {
      position: static;
      flex-direction: row;
      overflow-x: auto;
      gap: 6px;
      padding-bottom: 4px;
    }
    .toollist h3 {
      display: none;
    }
    .tool {
      flex: none;
      border-color: var(--border);
    }
    .run {
      margin-left: 0;
    }
  }
</style>
