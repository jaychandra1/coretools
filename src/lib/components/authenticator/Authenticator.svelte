<script lang="ts">
  import { authStore } from "./store.svelte";
  import AccountCard from "./AccountCard.svelte";
  import LockScreen from "./LockScreen.svelte";
  import Modal from "./Modal.svelte";
  import AddAccountDialog from "./AddAccountDialog.svelte";
  import ImportDialog from "./ImportDialog.svelte";
  import ExportDialog from "./ExportDialog.svelte";
  import SettingsDialog from "./SettingsDialog.svelte";
  import { previewImport } from "../../core/authenticator/backup";
  import type { ParsedAccount } from "../../core/authenticator/types";
  import type { StoredEntry } from "../../core/authenticator/db";

  // ---- lifecycle: init, shared clock, activity tracking -------------------

  $effect(() => {
    authStore.init();
    const timer = setInterval(() => authStore.tick(), 500);
    const touch = () => authStore.touch();
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  });

  // ---- search + "/" shortcut ----------------------------------------------

  let search = $state("");
  let searchInput: HTMLInputElement | undefined = $state();

  function onGlobalKeydown(event: KeyboardEvent) {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    searchInput?.focus();
  }

  const visibleEntries = $derived.by(() => {
    const query = search.trim().toLowerCase();
    return authStore.entries
      .filter(
        (entry) =>
          !query ||
          entry.issuer.toLowerCase().includes(query) ||
          entry.account.toLowerCase().includes(query),
      )
      .toSorted(
        (a, b) => Number(b.pinned) - Number(a.pinned) || a.index - b.index,
      );
  });

  // ---- toast + clipboard --------------------------------------------------

  let toast = $state("");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let clipboardTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(message: string) {
    toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 2200);
  }

  function onCopied(code: string) {
    showToast("Copied!");
    if (authStore.settings.clipboardClear) {
      clearTimeout(clipboardTimer);
      clipboardTimer = setTimeout(() => {
        // Only clear if the clipboard still holds the code we put there.
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text === code) return navigator.clipboard.writeText("");
          })
          .catch(() => navigator.clipboard.writeText("").catch(() => {}));
      }, 30_000);
    }
  }

  // ---- dialogs --------------------------------------------------------------

  type Dialog = null | "add" | "import" | "export" | "settings";
  let dialog = $state<Dialog>(null);
  let editMode = $state(false);
  let renaming = $state<StoredEntry | null>(null);
  let deleting = $state<StoredEntry | null>(null);
  let renameIssuer = $state("");
  let renameAccount = $state("");

  function existingForDupCheck() {
    return authStore.entries.map((entry) => ({
      secret: authStore.secretOf(entry.id) ?? "",
      issuer: entry.issuer,
      account: entry.account,
    }));
  }

  async function handleAdd(accounts: ParsedAccount[]) {
    const preview = previewImport(existingForDupCheck(), accounts);
    await authStore.addAccounts(preview.fresh);
    const added = preview.fresh.length;
    const skipped = preview.duplicates.length;
    showToast(
      skipped > 0
        ? `Added ${added}, skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}`
        : added === 1
          ? "Account added"
          : `Added ${added} accounts`,
    );
    dialog = null;
  }

  async function handleImport(accounts: ParsedAccount[]) {
    await authStore.addAccounts(accounts);
    showToast(`Imported ${accounts.length} account${accounts.length === 1 ? "" : "s"}`);
    dialog = null;
  }

  function startRename(entry: StoredEntry) {
    renaming = entry;
    renameIssuer = entry.issuer;
    renameAccount = entry.account;
  }

  async function applyRename(event: SubmitEvent) {
    event.preventDefault();
    if (!renaming) return;
    await authStore.rename(renaming.id, renameIssuer, renameAccount);
    renaming = null;
    showToast("Renamed");
  }

  async function applyDelete() {
    if (!deleting) return;
    await authStore.remove(deleting.id);
    deleting = null;
    showToast("Account deleted");
  }

  // ---- drag & drop reordering -----------------------------------------------

  let draggedId: string | null = null;

  // ---- banners ----------------------------------------------------------------

  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const showEncryptBanner = $derived(
    authStore.ready && !authStore.locked && !authStore.encrypted && authStore.entries.length > 0,
  );
  const showBackupBanner = $derived(
    authStore.ready &&
      !authStore.locked &&
      authStore.entries.length > 0 &&
      authStore.now - authStore.settings.backupReminderDismissedAt > THIRTY_DAYS,
  );
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<div class="authenticator">
  {#if !authStore.ready}
    <p class="muted center">Loading…</p>
  {:else if authStore.locked}
    <LockScreen />
  {:else}
    <div class="toolbar">
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          bind:this={searchInput}
          bind:value={search}
          placeholder="Search accounts (press / to focus)"
          aria-label="Search accounts"
        />
        {#if search}
          <button class="clear" onclick={() => (search = "")} aria-label="Clear search">✕</button>
        {/if}
      </div>

      <div class="toolbar-actions">
        <button class="primary" onclick={() => (dialog = "add")}>+ Add</button>
        <button onclick={() => (dialog = "import")}>Import</button>
        <button
          onclick={() => (dialog = "export")}
          disabled={authStore.entries.length === 0}
        >
          Export
        </button>
        <button
          class:active-toggle={editMode}
          onclick={() => (editMode = !editMode)}
          disabled={authStore.entries.length === 0}
        >
          {editMode ? "Done" : "Edit"}
        </button>
        <button onclick={() => (dialog = "settings")} title="Settings" aria-label="Settings">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
          </svg>
        </button>
        {#if authStore.encrypted}
          <button onclick={() => authStore.lock()} title="Lock now" aria-label="Lock now">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <rect x="4" y="10" width="16" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
          </button>
        {/if}
      </div>
    </div>

    {#if showEncryptBanner}
      <div class="banner warn" role="status">
        <span>
          Your secrets are stored <strong>unencrypted</strong> on this device.
          Set an encryption password to protect them at rest.
        </span>
        <button onclick={() => (dialog = "settings")}>Set password</button>
      </div>
    {/if}

    {#if showBackupBanner}
      <div class="banner info" role="status">
        <span>
          Reminder: keep a backup of your secrets in a safe place — if this
          device's data is lost, so are your codes.
        </span>
        <button onclick={() => (dialog = "export")}>Export backup</button>
        <button
          class="dismiss"
          aria-label="Dismiss backup reminder"
          onclick={() =>
            authStore.updateSettings({ backupReminderDismissedAt: Date.now() })}
        >
          ✕
        </button>
      </div>
    {/if}

    {#if authStore.entries.length === 0}
      <div class="empty">
        <p><strong>No accounts yet.</strong></p>
        <p class="muted">
          Add your first two-factor account by scanning a QR code, uploading a
          QR screenshot, entering the secret manually — or import an existing
          Authenticator extension backup.
        </p>
        <div class="empty-actions">
          <button class="primary" onclick={() => (dialog = "add")}>Add account</button>
          <button onclick={() => (dialog = "import")}>Import backup</button>
        </div>
      </div>
    {:else if visibleEntries.length === 0}
      <p class="muted center">No accounts match “{search}”.</p>
    {:else}
      <div class="list" role="list">
        {#each visibleEntries as entry (entry.id)}
          <AccountCard
            {entry}
            editMode={editMode && !search}
            oncopied={onCopied}
            onrename={startRename}
            ondelete={(e) => (deleting = e)}
            ondragstartcard={(id) => (draggedId = id)}
            ondropcard={(targetId) => {
              if (draggedId && draggedId !== targetId) {
                authStore.reorder(draggedId, targetId);
              }
              draggedId = null;
            }}
          />
        {/each}
      </div>
      {#if editMode && search}
        <p class="muted center small">Clear the search to reorder entries.</p>
      {/if}
    {/if}
  {/if}

  {#if toast}
    <div class="toast" role="status">{toast}</div>
  {/if}
</div>

{#if dialog === "add"}
  <AddAccountDialog onclose={() => (dialog = null)} onadd={handleAdd} />
{:else if dialog === "import"}
  <ImportDialog
    existing={existingForDupCheck()}
    onclose={() => (dialog = null)}
    onimport={handleImport}
  />
{:else if dialog === "export"}
  <ExportDialog
    entries={authStore.exportables()}
    onclose={() => (dialog = null)}
    ontoast={showToast}
  />
{:else if dialog === "settings"}
  <SettingsDialog onclose={() => (dialog = null)} ontoast={showToast} />
{/if}

{#if renaming}
  <Modal title="Rename account" onclose={() => (renaming = null)}>
    <form class="rename-form" onsubmit={applyRename}>
      <label>
        Issuer (service)
        <input bind:value={renameIssuer} placeholder="GitHub" />
      </label>
      <label>
        Account name
        <input bind:value={renameAccount} placeholder="user@example.com" />
      </label>
      <div class="modal-actions">
        <button type="button" onclick={() => (renaming = null)}>Cancel</button>
        <button
          class="primary"
          type="submit"
          disabled={!renameIssuer.trim() && !renameAccount.trim()}
        >
          Save
        </button>
      </div>
    </form>
  </Modal>
{/if}

{#if deleting}
  <Modal title="Delete account?" onclose={() => (deleting = null)}>
    <p>
      Delete <strong>{deleting.issuer || deleting.account}</strong>
      {#if deleting.issuer && deleting.account}({deleting.account}){/if}?
    </p>
    <p class="warn-text">
      This cannot be undone. If two-factor authentication is still enabled on
      that service, you may be locked out — make sure you have another way to
      sign in first.
    </p>
    <div class="modal-actions">
      <button onclick={() => (deleting = null)}>Cancel</button>
      <button class="danger-btn" onclick={applyDelete}>Delete permanently</button>
    </div>
  </Modal>
{/if}

<style>
  .authenticator {
    max-width: 720px;
    margin: 0 auto;
  }
  .center {
    text-align: center;
    padding: 40px 0;
  }
  .small {
    font-size: 12px;
    padding: 10px 0;
  }
  .toolbar {
    display: flex;
    gap: 10px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .search-wrap {
    flex: 1;
    min-width: 220px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-muted);
  }
  .search-wrap:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .search-wrap input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    padding: 8px 0;
  }
  .search-wrap .clear {
    border: none;
    background: transparent;
    padding: 2px 4px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .toolbar-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .toolbar-actions .active-toggle {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 12.5px;
    margin-bottom: 12px;
  }
  .banner span {
    flex: 1;
  }
  .banner.warn {
    background: var(--removed-bg);
    color: var(--removed-fg);
    border: 1px solid color-mix(in srgb, var(--removed-fg) 30%, transparent);
  }
  .banner.info {
    background: var(--accent-soft);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .banner button {
    flex: none;
    font-size: 12px;
    padding: 5px 10px;
  }
  .banner .dismiss {
    border: none;
    background: transparent;
    color: inherit;
    padding: 2px 6px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .empty {
    text-align: center;
    padding: 56px 24px;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .empty p {
    margin: 0 0 8px;
  }
  .empty .muted {
    max-width: 420px;
    margin: 0 auto 18px;
    font-size: 13px;
  }
  .empty-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  .toast {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--text);
    color: var(--bg);
    padding: 8px 18px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    z-index: 60;
    animation: toast-in 0.18s ease;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
  .rename-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .rename-form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
    font-weight: 500;
  }
  .rename-form input {
    font-family: inherit;
    font-size: 13px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  .rename-form input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .warn-text {
    color: var(--danger);
    font-size: 12.5px;
  }
  .danger-btn {
    border-color: var(--danger);
    color: var(--danger);
    font-weight: 600;
  }
  .danger-btn:hover:not(:disabled) {
    background: var(--removed-bg);
  }
  @media (max-width: 560px) {
    .toolbar {
      flex-direction: column;
    }
    .toolbar-actions {
      justify-content: flex-end;
    }
  }
</style>
