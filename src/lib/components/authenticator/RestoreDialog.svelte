<script lang="ts">
  import Modal from "./Modal.svelte";
  import { authStore, type RestoreResult } from "./store.svelte";
  import { cloudBackup, restoreSummary } from "./cloud.svelte";
  import { credentialStore } from "../credentials/credentials.svelte";
  import { accountKey } from "../../core/authenticator/backup";
  import {
    CloudBackupError,
    restoreParts,
    type CloudBackupFile,
    type CloudBackupPayload,
  } from "../../core/authenticator/cloud-backup";
  import {
    describeCloudError,
    ofKind,
    type BackupKind,
    type RemoteBackup,
  } from "../../core/authenticator/cloud-sync";

  let {
    scope,
    onclose,
    ontoast,
    preselectId = null,
    fromFile = null,
  }: {
    /** The section restoring: only its backups are listed and restored. */
    scope: BackupKind;
    onclose: () => void;
    ontoast: (message: string) => void;
    /** Version to select initially (e.g. the one behind a conflict). */
    preselectId?: string | null;
    /**
     * Restore from an exported backup file instead of Google Drive (F-24).
     * Skips sign-in and version picking; cloud bookkeeping is untouched.
     */
    fromFile?: { file: CloudBackupFile; name: string } | null;
  } = $props();

  type Step = "connect" | "pick" | "unlock" | "review" | "done";

  const accounts = $derived(scope === "authenticator");
  /** "account" / "saved credential", for counts. */
  const noun = $derived(accounts ? "account" : "saved credential");

  // svelte-ignore state_referenced_locally
  let step = $state<Step>(fromFile ? "unlock" : cloudBackup.connected ? "pick" : "connect");
  let error = $state("");
  let busy = $state(false);

  let versions = $state<RemoteBackup[]>([]);
  let selectedId = $state<string | null>(null);
  // svelte-ignore state_referenced_locally
  let file = $state<CloudBackupFile | null>(fromFile?.file ?? null);
  let payload = $state<CloudBackupPayload | null>(null);
  let password = $state("");
  /** The password that decrypted the backup (needed to create a fresh vault). */
  let usedPassword = $state<string | undefined>(undefined);
  let mode = $state<"merge" | "replace">("merge");
  let restored = $state<RestoreResult | null>(null);
  /** The restore created the vault (fresh install) with the backup's password. */
  let createdVault = $state(false);

  const fresh = $derived(!authStore.encrypted);
  const selected = $derived(
    fromFile
      ? {
          id: "file",
          name: fromFile.name,
          createdTime: fromFile.file.createdAt,
          size: 0,
          md5Checksum: "",
          deviceId: fromFile.file.device.id,
          deviceLabel: fromFile.file.device.label,
        }
      : (versions.find((v) => v.id === selectedId) ?? null),
  );
  const newestId = $derived(versions[0]?.id ?? "");
  /** What this section would restore from the decrypted file. */
  const parts = $derived(payload ? restoreParts([payload], scope) : null);
  const count = $derived(
    accounts ? (parts?.entries?.length ?? 0) : (parts?.credentials?.length ?? 0),
  );
  /** Records of this section already on the device (for the Replace warning). */
  const localCount = $derived(
    accounts ? authStore.entries.length : credentialStore.items.length,
  );

  /** How the backup's accounts relate to what's on this device. */
  const comparison = $derived.by(() => {
    if (!parts?.entries) return { fresh: 0, duplicates: 0 };
    const existing = new Set(
      authStore.entries.map((entry) =>
        accountKey({
          secret: authStore.secretOf(entry.id) ?? "",
          issuer: entry.issuer,
          account: entry.account,
        }),
      ),
    );
    const duplicates = parts.entries.filter((e) => existing.has(accountKey(e))).length;
    return { fresh: parts.entries.length - duplicates, duplicates };
  });

  function errorText(e: unknown): string {
    if (e instanceof CloudBackupError) return e.message;
    return describeCloudError(e).message;
  }

  function formatTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  // ---- steps -----------------------------------------------------------------

  async function loadVersions() {
    busy = true;
    error = "";
    try {
      versions = ofKind(await cloudBackup.listBackups(), scope);
      selectedId =
        versions.find((v) => v.id === preselectId)?.id ?? versions[0]?.id ?? null;
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  let listed = false;
  $effect(() => {
    if (step === "pick" && !listed) {
      listed = true;
      void loadVersions();
    }
  });

  async function signIn() {
    error = "";
    busy = true;
    try {
      if (await cloudBackup.signIn()) {
        step = "pick";
      } else if (cloudBackup.notice?.kind === "error") {
        error = cloudBackup.notice.text;
      }
    } finally {
      busy = false;
    }
  }

  async function chooseVersion() {
    if (!selected) return;
    busy = true;
    error = "";
    password = "";
    try {
      file = await cloudBackup.fetchBackup(selected.id);
      // The current vault key opens this device's own recent backups without
      // retyping the password — but only when Windows Hello will still gate
      // the restore (verifyUserPresence: Hello turned on for this vault).
      // Without it, the password IS the device check.
      if (authStore.helloSupported && authStore.helloEnabled) {
        try {
          payload = await cloudBackup.decryptBackup(file);
          usedPassword = undefined;
          step = "review";
          return;
        } catch (e) {
          if (!(e instanceof CloudBackupError && e.code === "wrong_password")) throw e;
        }
      }
      step = "unlock";
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  async function decrypt(event: SubmitEvent) {
    event.preventDefault();
    if (!file || !password || busy) return;
    busy = true;
    error = "";
    try {
      const opened = await cloudBackup.decryptBackup(file, password);
      // A file can be for the other section: say so instead of restoring nothing.
      const holds =
        opened.contents === "credmanager"
          ? "credmanager"
          : opened.contents === "authenticator"
            ? "authenticator"
            : opened.credentialsDigest !== "" && scope === "credmanager"
              ? "credmanager"
              : "authenticator";
      if (holds !== scope) {
        throw new Error(
          holds === "credmanager"
            ? "This is a Credential Manager backup — import it from the Credential Manager's settings."
            : "This is an Authenticator backup — import it from the Authenticator's settings.",
        );
      }
      payload = opened;
      usedPassword = password;
      step = "review";
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  async function restore() {
    if (!payload || !selected || busy) return;
    const effective = fresh ? "merge" : mode;
    if (
      effective === "replace" &&
      localCount > 0 &&
      !window.confirm(
        `Replace ALL ${noun}s on this device with this backup? Any that aren't in the backup will be deleted from this device.`,
      )
    ) {
      return;
    }
    busy = true;
    error = "";
    const wasFresh = fresh;
    try {
      if (fromFile) {
        // A file restore is local: device check, restore, no cloud bookkeeping.
        await authStore.verifyUserPresence();
        const fileParts = restoreParts([payload], scope);
        restored = await authStore.restoreFromBackup(fileParts, effective, usedPassword);
        if (wasFresh && fileParts.settings) await authStore.updateSettings({ ...fileParts.settings });
      } else {
        restored = await cloudBackup.applyRestore(
          [{ version: selected, payload, newestId }],
          effective,
          usedPassword,
          scope,
        );
      }
      password = "";
      usedPassword = undefined;
      createdVault = wasFresh;
      step = "done";
      ontoast(restoreSummary(restored).replace(/\.$/, ""));
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  function close() {
    if (cloudBackup.activity === "connecting") void cloudBackup.cancelSignIn();
    onclose();
  }
</script>

<Modal title={fromFile ? "Restore from a backup file" : "Restore from Google Drive"} onclose={close}>
  {#if step === "connect"}
    <p class="muted">
      Sign in with the Google account your backups were saved to. Your web
      browser opens for Google sign-in — come back here when it's done.
    </p>
    <p class="muted small">
      CoreTools can only see its own backup files, never the rest of your
      Drive.
    </p>
    <div class="actions">
      {#if cloudBackup.activity === "connecting"}
        <span class="waiting">Waiting for Google sign-in in your browser…</span>
        <button onclick={() => cloudBackup.cancelSignIn()}>Cancel</button>
      {:else}
        <button onclick={close}>Cancel</button>
        <button class="primary" onclick={signIn} disabled={busy}>
          Sign in with Google
        </button>
      {/if}
    </div>
  {:else if step === "pick"}
    <p class="muted">
      {accounts ? "Authenticator" : "Credential Manager"} backups in
      <strong>{cloudBackup.account}</strong>'s Google Drive, newest first. Pick
      one to restore — older versions let you roll back.
    </p>
    {#if busy && versions.length === 0}
      <p class="muted center">Looking for backups…</p>
    {:else if versions.length === 0 && !error}
      <p class="empty">
        No {accounts ? "Authenticator" : "Credential Manager"} backups found for
        this Google account.
      </p>
    {:else}
      <div class="versions" role="radiogroup" aria-label="Backup versions">
        {#each versions as version, i (version.id)}
          <label class="version" class:selected={version.id === selectedId}>
            <input
              type="radio"
              name="version"
              value={version.id}
              bind:group={selectedId}
            />
            <span class="when">{formatTime(version.createdTime)}</span>
            <span class="device">{version.deviceLabel || "Unknown device"}</span>
            {#if i === 0}<span class="tag">Latest</span>{/if}
            {#if cloudBackup.config && version.deviceId === cloudBackup.config.deviceId}
              <span class="tag subtle">This device</span>
            {/if}
          </label>
        {/each}
      </div>
    {/if}
    <div class="actions">
      <button onclick={loadVersions} disabled={busy}>Refresh</button>
      <span class="spacer"></span>
      <button onclick={close}>Cancel</button>
      <button class="primary" onclick={chooseVersion} disabled={!selected || busy}>
        {busy && versions.length > 0 ? "Downloading…" : "Continue"}
      </button>
    </div>
  {:else if step === "unlock"}
    <form onsubmit={decrypt}>
      <p class="muted">
        Enter the encryption password that was set on
        <strong>{selected?.deviceLabel || "that device"}</strong> when this
        backup was made ({selected ? formatTime(selected.createdTime) : ""}).
        It never leaves this computer.
      </p>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="password"
        bind:value={password}
        placeholder="Backup password"
        autocomplete="off"
        aria-label="Backup password"
        autofocus
      />
      <div class="actions">
        {#if fromFile}
          <button type="button" onclick={close}>Cancel</button>
        {:else}
          <button type="button" onclick={() => (step = "pick")}>Back</button>
        {/if}
        <button class="primary" type="submit" disabled={!password || busy}>
          {busy ? "Decrypting…" : "Decrypt backup"}
        </button>
      </div>
    </form>
  {:else if step === "review" && parts && selected}
    <div class="summary">
      <strong>{plural(count, noun)}</strong>
      <span class="muted">
        backed up {formatTime(selected.createdTime)} on
        {selected.deviceLabel || "another device"} · integrity verified
      </span>
    </div>
    {#if parts.entries && parts.entries.length > 0}
      <ul class="preview">
        {#each parts.entries.slice(0, 6) as entry, i (i)}
          <li>
            <span class="issuer">{entry.issuer || entry.account}</span>
            {#if entry.issuer && entry.account}<span class="muted">{entry.account}</span>{/if}
          </li>
        {/each}
        {#if parts.entries.length > 6}
          <li class="muted">…and {parts.entries.length - 6} more</li>
        {/if}
      </ul>
    {:else if parts.credentials && parts.credentials.length > 0}
      <ul class="preview">
        {#each parts.credentials.slice(0, 6) as credential, i (i)}
          <li>
            <span class="issuer">{credential.platform}</span>
            {#if credential.username}<span class="muted">{credential.username}</span>{/if}
          </li>
        {/each}
        {#if parts.credentials.length > 6}
          <li class="muted">…and {parts.credentials.length - 6} more</li>
        {/if}
      </ul>
    {/if}

    {#if fresh}
      <p class="muted small">
        {#if accounts && authStore.entries.length > 0}
          The {plural(comparison.fresh, "new account")} will be added to the
          ones already here.
        {/if}
        Your encryption password will be set to this backup's password{#if parts.settings}
          and your display settings restored{/if}.
      </p>
    {:else}
      {#if accounts}
        <p class="muted small">
          {plural(comparison.fresh, "account")} new to this device,
          {comparison.duplicates} already here (never duplicated).
        </p>
      {/if}
      <div class="modes" role="radiogroup" aria-label="Restore mode">
        <label class="mode">
          <input type="radio" name="mode" value="merge" bind:group={mode} />
          <span>
            <strong>Merge</strong> — add the {noun}s that aren't here yet, keep
            everything already here.
          </span>
        </label>
        <label class="mode">
          <input type="radio" name="mode" value="replace" bind:group={mode} />
          <span>
            <strong>Replace</strong> — make this device's {noun}s match the
            backup exactly (rollback). Any not in the backup are removed.
          </span>
        </label>
      </div>
    {/if}

    <div class="actions">
      <button onclick={() => (step = fromFile ? "unlock" : "pick")} disabled={busy}>Back</button>
      <button class="primary" onclick={restore} disabled={busy}>
        {#if busy}
          {authStore.helloSupported ? "Waiting for Windows Hello…" : "Restoring…"}
        {:else}
          {authStore.helloSupported ? "Verify with Windows Hello & restore" : "Restore"}
        {/if}
      </button>
    </div>
  {:else if step === "done" && restored}
    <p><strong>{restoreSummary(restored)}</strong></p>
    {#if createdVault}
      <p class="muted small">
        Your data is encrypted with the backup's password — use it to unlock
        from now on. Automatic backups continue from this device.
      </p>
    {/if}
    <div class="actions">
      <button class="primary" onclick={onclose}>Done</button>
    </div>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
</Modal>

<style>
  p {
    margin: 0 0 10px;
    font-size: 12.5px;
  }
  .small {
    font-size: 12px;
  }
  .center {
    text-align: center;
    padding: 16px 0;
  }
  .empty {
    text-align: center;
    padding: 18px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    color: var(--text-muted);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  input[type="password"] {
    font-family: inherit;
    font-size: 13px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
  }
  .spacer {
    flex: 1;
  }
  .waiting {
    flex: 1;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .versions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 260px;
    overflow-y: auto;
  }
  .version {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .version.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .version input {
    accent-color: var(--accent);
  }
  .when {
    font-weight: 600;
  }
  .device {
    flex: 1;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--accent);
    color: #fff;
  }
  .tag.subtle {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 10px;
    font-size: 13px;
  }
  .summary .muted {
    font-size: 12px;
  }
  .preview {
    list-style: none;
    margin: 0 0 12px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12.5px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .preview li {
    display: flex;
    gap: 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .issuer {
    font-weight: 600;
  }
  .modes {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mode {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 12.5px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
  }
  .mode input {
    margin-top: 2px;
    accent-color: var(--accent);
  }
  .error {
    color: var(--danger);
    font-size: 13px;
    margin: 12px 0 0;
  }
</style>
