<script lang="ts">
  import Modal from "./Modal.svelte";
  import { decodeQrFromImage } from "./qr";
  import { getPlatform } from "../../platform";
  import type { ParsedAccount } from "../../core/authenticator/types";
  import {
    decryptBackupEntries,
    isGcmBackup,
    parseExtensionBackup,
    parseGcmBackup,
    parseUriList,
    previewImport,
    type BackupEntry,
    type ImportPreview,
  } from "../../core/authenticator/backup";
  import { isMigrationUri, isOtpAuthUri } from "../../core/authenticator/otpauth";

  let {
    existing,
    onclose,
    onimport,
  }: {
    /** Current accounts (plaintext secrets) for duplicate detection. */
    existing: Array<{ secret: string; issuer: string; account: string }>;
    onclose: () => void;
    onimport: (accounts: ParsedAccount[]) => Promise<void>;
  } = $props();

  const platform = getPlatform();

  let stage = $state<"input" | "password" | "preview">("input");
  let error = $state("");
  let busy = $state(false);
  let pasted = $state("");
  let password = $state("");

  /** Held while waiting for the backup password. */
  let pendingText = $state("");
  let pendingKind = $state<"extension" | "gcm">("extension");

  let preview = $state<ImportPreview | null>(null);

  function showPreview(accounts: ParsedAccount[]) {
    preview = previewImport(existing, accounts);
    stage = "preview";
  }

  /** Route any text (file content or paste) to the right parser. */
  function analyzeText(text: string) {
    error = "";
    const trimmed = text.trim();
    if (!trimmed) return;

    try {
      if (isGcmBackup(trimmed)) {
        pendingText = trimmed;
        pendingKind = "gcm";
        stage = "password";
        return;
      }
      if (trimmed.startsWith("{")) {
        const entries = parseExtensionBackup(trimmed);
        if (entries.some((e) => e.encrypted)) {
          pendingText = trimmed;
          pendingKind = "extension";
          stage = "password";
          return;
        }
        showPreview(entries);
        return;
      }
      if (isMigrationUri(trimmed) || isOtpAuthUri(trimmed) || trimmed.includes("otpauth://")) {
        showPreview(parseUriList(trimmed));
        return;
      }
      error =
        "Unrecognized format. Paste an Authenticator JSON backup, otpauth:// URIs, or an otpauth-migration:// URI.";
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not read this backup";
    }
  }

  async function decryptPending(event: SubmitEvent) {
    event.preventDefault();
    if (!password || busy) return;
    busy = true;
    error = "";
    try {
      let entries: BackupEntry[];
      if (pendingKind === "gcm") {
        entries = await parseGcmBackup(pendingText, password);
      } else {
        entries = await decryptBackupEntries(
          parseExtensionBackup(pendingText),
          password,
        );
      }
      password = "";
      showPreview(entries);
    } catch (e) {
      error = e instanceof Error ? e.message : "Decryption failed";
    } finally {
      busy = false;
    }
  }

  async function openFile() {
    const file = await platform.openTextFile();
    if (file) analyzeText(file.content);
  }

  async function onQrImageChosen(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    error = "";
    const text = await decodeQrFromImage(file).catch(() => null);
    if (text) {
      analyzeText(text);
    } else {
      error = "No QR code found in that image.";
    }
  }

  async function commit() {
    if (!preview || busy) return;
    busy = true;
    try {
      await onimport(preview.fresh);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="Import accounts" {onclose} wide>
  {#if stage === "input"}
    <div class="sources">
      <button onclick={openFile}>
        Open backup file
        <span class="muted">Authenticator .json or otpauth .txt</span>
      </button>
      <label class="source-btn">
        QR image
        <span class="muted">screenshot of an account or Google Authenticator export QR</span>
        <input type="file" accept="image/*" onchange={onQrImageChosen} />
      </label>
    </div>

    <p class="or muted">— or paste below —</p>

    <textarea
      bind:value={pasted}
      rows="7"
      placeholder={'{ "a1b2c3…": { "issuer": "GitHub", "secret": "…" } }\notpauth://totp/GitHub:alice?secret=…\notpauth-migration://offline?data=…'}
      spellcheck="false"
    ></textarea>
    <div class="actions">
      <button onclick={onclose}>Cancel</button>
      <button class="primary" disabled={!pasted.trim()} onclick={() => analyzeText(pasted)}>
        Continue
      </button>
    </div>
  {:else if stage === "password"}
    <p>
      This backup is <strong>encrypted</strong>. Enter the password it was
      exported with — decryption happens entirely on this device.
    </p>
    <form onsubmit={decryptPending}>
      <input
        bind:value={password}
        type="password"
        placeholder="Backup password"
        autocomplete="off"
        aria-label="Backup password"
        disabled={busy}
      />
      <div class="actions">
        <button type="button" onclick={() => (stage = "input")}>Back</button>
        <button class="primary" type="submit" disabled={!password || busy}>
          {busy ? "Decrypting…" : "Decrypt"}
        </button>
      </div>
    </form>
  {:else if preview}
    <p class="summary">
      Found <strong>{preview.fresh.length + preview.duplicates.length + preview.invalid.length}</strong>
      accounts —
      <strong>{preview.fresh.length}</strong> will be imported{#if preview.duplicates.length},
        <strong>{preview.duplicates.length}</strong>
        {preview.duplicates.length === 1 ? "duplicate" : "duplicates"} will be skipped{/if}{#if preview.invalid.length},
        <strong>{preview.invalid.length}</strong> invalid will be ignored{/if}.
    </p>

    <ul class="preview-list">
      {#each preview.fresh as item (item.secret + item.issuer + item.account)}
        <li>
          <strong>{item.issuer || "(no issuer)"}</strong>
          {#if item.account}<span class="muted"> — {item.account}</span>{/if}
          <span class="badge new">new</span>
        </li>
      {/each}
      {#each preview.duplicates as item, i (i)}
        <li class="dim">
          <strong>{item.issuer || "(no issuer)"}</strong>
          {#if item.account}<span class="muted"> — {item.account}</span>{/if}
          <span class="badge dup">duplicate — skipped</span>
        </li>
      {/each}
      {#each preview.invalid as item, i (i)}
        <li class="dim">
          <strong>{item.issuer || item.account || "(unnamed)"}</strong>
          <span class="badge invalid">invalid secret</span>
        </li>
      {/each}
    </ul>

    <div class="actions">
      <button onclick={() => (stage = "input")}>Back</button>
      <button class="primary" disabled={preview.fresh.length === 0 || busy} onclick={commit}>
        {busy
          ? "Importing…"
          : `Import ${preview.fresh.length} ${preview.fresh.length === 1 ? "account" : "accounts"}`}
      </button>
    </div>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
</Modal>

<style>
  .sources {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .sources button,
  .source-btn {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-start;
    text-align: left;
    padding: 12px 14px;
    font-weight: 600;
    font-size: 13px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    cursor: pointer;
  }
  .sources button:hover,
  .source-btn:hover {
    background: var(--surface-2);
  }
  .source-btn input {
    display: none;
  }
  .sources .muted {
    font-weight: 400;
    font-size: 11.5px;
  }
  .or {
    text-align: center;
    font-size: 12px;
    margin: 12px 0 8px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 8px;
  }
  input[type="password"] {
    font-family: inherit;
    font-size: 14px;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  input[type="password"]:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .summary {
    margin: 0 0 12px;
  }
  .preview-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 300px;
    overflow-y: auto;
  }
  .preview-list li {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
  }
  .preview-list li.dim {
    opacity: 0.6;
  }
  .badge {
    float: right;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-radius: 4px;
    padding: 2px 6px;
  }
  .badge.new {
    background: var(--added-bg);
    color: var(--added-fg);
  }
  .badge.dup {
    background: var(--surface-2);
    color: var(--text-muted);
  }
  .badge.invalid {
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
  .error {
    color: var(--danger);
    font-size: 13px;
    margin: 12px 0 0;
  }
</style>
