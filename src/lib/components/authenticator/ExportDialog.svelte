<script lang="ts">
  import Modal from "./Modal.svelte";
  import { qrDataUrl } from "./qr";
  import { getPlatform } from "../../platform";
  import {
    buildExtensionBackup,
    buildGcmBackup,
    buildUriList,
    type ExportableEntry,
  } from "../../core/authenticator/backup";
  import { buildOtpAuthUri } from "../../core/authenticator/otpauth";

  let {
    entries,
    onclose,
    ontoast,
  }: {
    entries: ExportableEntry[];
    onclose: () => void;
    ontoast: (message: string) => void;
  } = $props();

  const platform = getPlatform();

  type Format = "ext-json" | "ext-json-enc" | "gcm-json" | "uris" | "qr";
  let format = $state<Format>("ext-json");
  let password = $state("");
  let confirm = $state("");
  let error = $state("");
  let busy = $state(false);

  const needsPassword = $derived(format === "ext-json-enc" || format === "gcm-json");
  const passwordOk = $derived(
    !needsPassword || (password.length > 0 && password === confirm),
  );

  function stamp(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async function download() {
    if (busy || !passwordOk) return;
    busy = true;
    error = "";
    try {
      let content: string;
      let name: string;

      if (format === "ext-json") {
        content = JSON.stringify(await buildExtensionBackup(entries), null, 2);
        name = `authenticator-backup-${stamp()}.json`;
      } else if (format === "ext-json-enc") {
        content = JSON.stringify(
          await buildExtensionBackup(entries, password),
          null,
          2,
        );
        name = `authenticator-backup-encrypted-${stamp()}.json`;
      } else if (format === "gcm-json") {
        content = JSON.stringify(await buildGcmBackup(entries, password), null, 2);
        name = `coretools-authenticator-backup-${stamp()}.json`;
      } else {
        content = buildUriList(entries);
        name = `authenticator-uris-${stamp()}.txt`;
      }

      const saved = await platform.saveTextFile(name, content);
      if (saved) {
        ontoast("Backup exported");
        onclose();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Export failed";
    } finally {
      busy = false;
    }
  }

  // ---- per-account QR codes ------------------------------------------------

  interface QrItem {
    label: string;
    sub: string;
    url: string;
  }
  let qrItems = $state<QrItem[] | null>(null);

  $effect(() => {
    if (format !== "qr") {
      qrItems = null;
      return;
    }
    Promise.all(
      [...entries]
        .sort((a, b) => a.index - b.index)
        .map(async (entry) => ({
          label: entry.issuer || entry.account || "Unnamed",
          sub: entry.issuer ? entry.account : "",
          url: await qrDataUrl(buildOtpAuthUri(entry)),
        })),
    )
      .then((items) => (qrItems = items))
      .catch(() => (error = "QR generation failed"));
  });

  function printAll() {
    document.body.classList.add("print-qr");
    const cleanup = () => {
      document.body.classList.remove("print-qr");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  }
</script>

<Modal title="Export backup" {onclose} wide>
  <p class="reminder muted">
    Everything is generated on this device — nothing is uploaded. Keep backups
    somewhere safe: anyone with this file (and its password, if set) can
    generate your codes.
  </p>

  <div class="formats" role="radiogroup" aria-label="Export format">
    <label>
      <input type="radio" bind:group={format} value="ext-json" />
      <span>
        <strong>JSON backup (extension-compatible)</strong>
        <span class="muted">plaintext secrets — importable by the Authenticator browser extension and this app</span>
      </span>
    </label>
    <label>
      <input type="radio" bind:group={format} value="ext-json-enc" />
      <span>
        <strong>Encrypted JSON (extension-compatible)</strong>
        <span class="muted">CryptoJS/OpenSSL format the browser extension can decrypt</span>
      </span>
    </label>
    <label>
      <input type="radio" bind:group={format} value="gcm-json" />
      <span>
        <strong>Encrypted JSON (modern, this app only)</strong>
        <span class="muted">PBKDF2 + AES-256-GCM — not readable by the extension</span>
      </span>
    </label>
    <label>
      <input type="radio" bind:group={format} value="uris" />
      <span>
        <strong>otpauth URI list (.txt)</strong>
        <span class="muted">one URI per line, importable almost anywhere</span>
      </span>
    </label>
    <label>
      <input type="radio" bind:group={format} value="qr" />
      <span>
        <strong>Per-account QR codes</strong>
        <span class="muted">scan into any phone app, or print all</span>
      </span>
    </label>
  </div>

  {#if needsPassword}
    <div class="password-row">
      <input
        type="password"
        bind:value={password}
        placeholder="Backup password"
        autocomplete="new-password"
        aria-label="Backup password"
      />
      <input
        type="password"
        bind:value={confirm}
        placeholder="Confirm password"
        autocomplete="new-password"
        aria-label="Confirm backup password"
      />
    </div>
    {#if password && confirm && password !== confirm}
      <p class="error">Passwords do not match.</p>
    {/if}
  {/if}

  {#if format === "qr"}
    {#if qrItems === null}
      <p class="muted">Generating QR codes…</p>
    {:else}
      <div class="qr-grid">
        {#each qrItems as item (item.label + item.sub)}
          <figure>
            <img src={item.url} alt="QR code for {item.label}" />
            <figcaption>
              <strong>{item.label}</strong>
              {#if item.sub}<span class="muted">{item.sub}</span>{/if}
            </figcaption>
          </figure>
        {/each}
      </div>
      <div class="actions">
        <button onclick={onclose}>Close</button>
        <button class="primary" onclick={printAll}>Print all</button>
      </div>
    {/if}
  {:else}
    <div class="actions">
      <button onclick={onclose}>Cancel</button>
      <button class="primary" disabled={!passwordOk || busy} onclick={download}>
        {busy ? "Exporting…" : "Download"}
      </button>
    </div>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
</Modal>

<style>
  .reminder {
    font-size: 12px;
    margin: 0 0 14px;
  }
  .formats {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .formats label {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
  }
  .formats label:has(input:checked) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .formats input {
    margin-top: 3px;
    accent-color: var(--accent);
  }
  .formats span span.muted {
    display: block;
    font-size: 11.5px;
    font-weight: 400;
  }
  .password-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 12px;
  }
  .password-row input {
    font-family: inherit;
    font-size: 13px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  .password-row input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .error {
    color: var(--danger);
    font-size: 13px;
    margin: 10px 0 0;
  }

  .qr-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 14px;
    margin-top: 14px;
    max-height: 340px;
    overflow-y: auto;
  }
  figure {
    margin: 0;
    text-align: center;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    background: #fff; /* QR quiet zone must stay white in dark theme too */
  }
  figure img {
    width: 100%;
    max-width: 180px;
  }
  figcaption {
    font-size: 12px;
    color: #1c2530;
  }
  figcaption .muted {
    display: block;
    color: #66707c;
  }

  /* Print: hide the app, show only the QR grid. */
  @media print {
    :global(body.print-qr #app > *) {
      visibility: hidden;
    }
    :global(body.print-qr) .qr-grid,
    :global(body.print-qr) .qr-grid * {
      visibility: visible;
    }
    :global(body.print-qr) .qr-grid {
      position: fixed;
      inset: 0;
      max-height: none;
      overflow: visible;
      background: #fff;
      padding: 24px;
    }
  }
</style>
