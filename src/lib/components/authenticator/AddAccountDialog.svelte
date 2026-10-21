<script lang="ts">
  import Modal from "./Modal.svelte";
  import { decodeQrFromImage, decodeQrFromVideo } from "./qr";
  import { isValidBase32, normalizeBase32 } from "../../core/authenticator/base32";
  import { isMigrationUri, isOtpAuthUri, parseOtpAuthUri } from "../../core/authenticator/otpauth";
  import { parseMigrationUri } from "../../core/authenticator/migration";
  import { DEFAULTS, type OtpType, type ParsedAccount } from "../../core/authenticator/types";
  import { getPlatform } from "../../platform";

  let {
    onclose,
    onadd,
  }: {
    onclose: () => void;
    /** Parent filters duplicates, persists, toasts and closes. */
    onadd: (accounts: ParsedAccount[]) => Promise<void>;
  } = $props();

  type Tab = "scan" | "image" | "manual";
  let tab = $state<Tab>("scan");
  let error = $state("");
  let found = $state<ParsedAccount[] | null>(null);

  // ---- shared: turn scanned/pasted text into accounts -------------------

  function handleText(text: string): void {
    error = "";
    try {
      if (isMigrationUri(text)) {
        found = parseMigrationUri(text);
      } else if (isOtpAuthUri(text)) {
        found = [parseOtpAuthUri(text)];
      } else {
        error = "The QR code does not contain an otpauth:// URI.";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not parse the QR code";
    }
  }

  async function confirmFound() {
    if (!found) return;
    await onadd(found);
  }

  // ---- camera tab --------------------------------------------------------

  let video: HTMLVideoElement | undefined = $state();
  let cameraError = $state("");
  let stream: MediaStream | null = null;
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  const scanCanvas = document.createElement("canvas");
  // getUserMedia can resolve AFTER the dialog/tab is torn down (the whole time
  // the permission prompt is up). Each stopCamera() bumps the generation; a
  // start that awakes stale must stop the tracks it just received and bail,
  // or the camera stays live with no UI attached — a privacy bug.
  let cameraGeneration = 0;

  async function startCamera() {
    cameraError = "";
    const mine = ++cameraGeneration;
    const platform = getPlatform();
    try {
      // The desktop app grants camera access only while the scanner asks for
      // it (L1): armed for this request, disarmed as soon as it's answered.
      await platform.armCamera?.(true);
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      } finally {
        platform.armCamera?.(false).catch(() => {});
      }
      if (mine !== cameraGeneration) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = media;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }
      if (mine !== cameraGeneration) return; // torn down during play()
      scanTimer = setInterval(() => {
        if (!video || found) return;
        const text = decodeQrFromVideo(video, scanCanvas);
        if (text) {
          stopCamera();
          handleText(text);
        }
      }, 250);
    } catch {
      if (mine !== cameraGeneration) return;
      cameraError =
        "Camera unavailable (no device, or permission denied). Use the Image tab to upload a screenshot instead.";
    }
  }

  function stopCamera() {
    cameraGeneration++;
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  $effect(() => {
    if (tab === "scan" && !found) {
      startCamera();
      return stopCamera;
    }
  });

  $effect(() => () => stopCamera()); // safety net on unmount

  // ---- image tab ---------------------------------------------------------

  let dragOver = $state(false);

  async function handleImageBlob(blob: Blob) {
    error = "";
    const text = await decodeQrFromImage(blob).catch(() => null);
    if (text) {
      handleText(text);
    } else {
      error = "No QR code found in that image.";
    }
  }

  function onFileChosen(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) handleImageBlob(file);
  }

  function onPaste(event: ClipboardEvent) {
    if (tab !== "image" || found) return;
    const item = [...(event.clipboardData?.items ?? [])].find((i) =>
      i.type.startsWith("image/"),
    );
    const file = item?.getAsFile();
    if (file) {
      event.preventDefault();
      handleImageBlob(file);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragOver = false;
    const file = event.dataTransfer?.files?.[0];
    if (file?.type.startsWith("image/")) handleImageBlob(file);
  }

  // ---- manual tab ---------------------------------------------------------

  let issuer = $state("");
  let account = $state("");
  let secret = $state("");
  let type = $state<OtpType>("totp");
  let algorithm = $state<"SHA1" | "SHA256" | "SHA512">(DEFAULTS.algorithm);
  let digits = $state(DEFAULTS.digits);
  let period = $state(DEFAULTS.period);
  let counter = $state(0);

  const secretValid = $derived(secret.trim() === "" || isValidBase32(secret));
  const canSubmit = $derived(
    secret.trim() !== "" &&
      isValidBase32(secret) &&
      (issuer.trim() !== "" || account.trim() !== "") &&
      (type !== "totp" || (period >= 5 && period <= 3600)),
  );

  async function submitManual(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    await onadd([
      {
        type,
        issuer: issuer.trim(),
        account: account.trim(),
        secret: normalizeBase32(secret),
        algorithm: type === "totp" ? algorithm : "SHA1",
        digits: type === "steam" ? 5 : type === "blizzard" ? 8 : digits,
        period: type === "totp" ? period : 30,
        counter: type === "hotp" ? counter : 0,
      },
    ]);
  }
</script>

<svelte:window onpaste={onPaste} />

<Modal title="Add account" {onclose}>
  {#if found}
    <div class="preview">
      <p>
        Found <strong>{found.length}</strong>
        {found.length === 1 ? "account" : "accounts"}:
      </p>
      <ul>
        {#each found as item (item.secret + item.account)}
          <li>
            <strong>{item.issuer || "(no issuer)"}</strong>
            {#if item.account}<span class="muted"> — {item.account}</span>{/if}
            <span class="badge">{item.type}</span>
          </li>
        {/each}
      </ul>
      <div class="actions">
        <button onclick={() => (found = null)}>Back</button>
        <button class="primary" onclick={confirmFound}>
          Add {found.length === 1 ? "account" : `${found.length} accounts`}
        </button>
      </div>
    </div>
  {:else}
    <nav class="subtabs" aria-label="Add method">
      <button class:active={tab === "scan"} onclick={() => (tab = "scan")}>Scan QR</button>
      <button class:active={tab === "image"} onclick={() => (tab = "image")}>From image</button>
      <button class:active={tab === "manual"} onclick={() => (tab = "manual")}>Manual entry</button>
    </nav>

    {#if tab === "scan"}
      {#if cameraError}
        <p class="error" role="alert">{cameraError}</p>
      {:else}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} playsinline muted></video>
        <p class="hint muted">
          Point the camera at an account QR code or a Google Authenticator
          export QR. Scanning happens entirely on this device.
        </p>
      {/if}
    {:else if tab === "image"}
      <div
        class="dropzone"
        class:drag-over={dragOver}
        role="button"
        tabindex="0"
        ondragover={(e) => {
          e.preventDefault();
          dragOver = true;
        }}
        ondragleave={() => (dragOver = false)}
        ondrop={onDrop}
      >
        <p>Drop a QR screenshot here, paste an image from the clipboard,<br />or</p>
        <label class="file-btn">
          Choose image…
          <input type="file" accept="image/*" onchange={onFileChosen} />
        </label>
      </div>
    {:else}
      <form class="manual" onsubmit={submitManual}>
        <label>
          Issuer (service)
          <input bind:value={issuer} placeholder="GitHub" />
        </label>
        <label>
          Account name
          <input bind:value={account} placeholder="user@example.com" />
        </label>
        <label>
          Secret key (Base32)
          <input
            bind:value={secret}
            class:invalid={!secretValid}
            placeholder="JBSW Y3DP EHPK 3PXP"
            spellcheck="false"
            autocomplete="off"
          />
          {#if !secretValid}
            <span class="field-error">Not a valid Base32 secret</span>
          {/if}
        </label>
        <div class="row">
          <label>
            Type
            <select bind:value={type}>
              <option value="totp">TOTP (time-based)</option>
              <option value="hotp">HOTP (counter-based)</option>
              <option value="steam">Steam Guard</option>
              <option value="blizzard">Blizzard / Battle.net</option>
            </select>
          </label>
          {#if type === "totp"}
            <label>
              Algorithm
              <select bind:value={algorithm}>
                <option>SHA1</option>
                <option>SHA256</option>
                <option>SHA512</option>
              </select>
            </label>
          {/if}
        </div>
        {#if type === "totp"}
          <div class="row">
            <label>
              Digits
              <select bind:value={digits}>
                <option value={6}>6</option>
                <option value={7}>7</option>
                <option value={8}>8</option>
              </select>
            </label>
            <label>
              Period (seconds)
              <input type="number" bind:value={period} min="5" max="3600" />
            </label>
          </div>
        {:else if type === "hotp"}
          <label>
            Initial counter
            <input type="number" bind:value={counter} min="0" />
          </label>
        {:else}
          <p class="hint muted">
            {type === "steam"
              ? "Steam Guard codes are 5 characters, refreshed every 30 seconds."
              : "Battle.net codes are 8 digits, refreshed every 30 seconds."}
          </p>
        {/if}
        <div class="actions">
          <button type="button" onclick={onclose}>Cancel</button>
          <button class="primary" type="submit" disabled={!canSubmit}>Add account</button>
        </div>
      </form>
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  {/if}
</Modal>

<style>
  .subtabs {
    display: flex;
    gap: 4px;
    margin-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }
  .subtabs button {
    border: none;
    background: transparent;
    border-radius: 0;
    padding: 7px 10px;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .subtabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  video {
    width: 100%;
    border-radius: 8px;
    background: #000;
    aspect-ratio: 4 / 3;
    object-fit: cover;
  }
  .hint {
    font-size: 12px;
    margin: 10px 0 0;
  }
  .dropzone {
    border: 2px dashed var(--border);
    border-radius: 10px;
    padding: 28px 16px;
    text-align: center;
    font-size: 13px;
  }
  .dropzone.drag-over {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .dropzone p {
    margin: 0 0 12px;
  }
  .file-btn {
    display: inline-block;
    padding: 7px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    cursor: pointer;
  }
  .file-btn:hover {
    background: var(--surface-2);
  }
  .file-btn input {
    display: none;
  }
  .manual {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
    font-weight: 500;
    flex: 1;
  }
  input,
  select {
    font-family: inherit;
    font-size: 13px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  input:focus,
  select:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  input.invalid {
    border-color: var(--danger);
  }
  .field-error {
    color: var(--danger);
    font-size: 11.5px;
    font-weight: 400;
  }
  .row {
    display: flex;
    gap: 12px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .error {
    color: var(--danger);
    font-size: 13px;
    margin: 12px 0 0;
  }
  .preview ul {
    list-style: none;
    margin: 0 0 16px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 260px;
    overflow-y: auto;
  }
  .preview li {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
  }
  .badge {
    float: right;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 4px;
    padding: 2px 6px;
  }
</style>
