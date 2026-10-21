<script lang="ts">
  import { authStore } from "../authenticator/store.svelte";
  import { cloudBackup } from "../authenticator/cloud.svelte";
  import LockScreen from "../authenticator/LockScreen.svelte";
  import Modal from "../authenticator/Modal.svelte";
  import SettingsDialog from "../authenticator/SettingsDialog.svelte";
  import RestoreDialog from "../authenticator/RestoreDialog.svelte";
  import CredentialDialog from "./CredentialDialog.svelte";
  import CredentialTable from "./CredentialTable.svelte";
  import CredentialToolbar from "./CredentialToolbar.svelte";
  import AuditLogDialog from "./AuditLogDialog.svelte";
  import ManageSpacesDialog from "./ManageSpacesDialog.svelte";
  import NewSpaceDialog from "./NewSpaceDialog.svelte";
  import PasswordPrompt from "./PasswordPrompt.svelte";
  import SpaceTabs from "./SpaceTabs.svelte";
  import Switch from "./Switch.svelte";
  import VaultSetup from "./VaultSetup.svelte";
  import Toast, { type ToastMessage } from "./Toast.svelte";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";
  import type { CloudBackupFile } from "../../core/authenticator/cloud-backup";
  import { credentialStore, type CredentialInput } from "./credentials.svelte";
  import { copySecret, copyText, clearSecretLater } from "../../secure-clipboard";
  import {
    EMPTY_FILTER,
    facets,
    filterCredentials,
    type CredentialFilter,
  } from "../../core/credentials/search";
  import { moveOnto, sortByOrder } from "../../core/credentials/order";
  import {
    inSpace,
    moveSpace,
    orderSpaces,
    spaceCounts,
    spaceNames,
  } from "../../core/credentials/spaces";
  import type { StoredCredential } from "../../core/credentials/types";
  import { getPlatform } from "../../platform";
  import { readSetting, writeSetting } from "../../local-setting";

  // ---- lifecycle ---------------------------------------------------------------

  $effect(() => {
    authStore.init();
    credentialStore.init();
    cloudBackup.init(); // credentials ride in the encrypted Drive backup
    const touch = () => authStore.touch();
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  });

  // ---- list --------------------------------------------------------------------

  let filter = $state<CredentialFilter>({ ...EMPTY_FILTER });
  let showTrash = $state(false);

  /** Minute-granular clock: date filters don't need the 500 ms tick. */
  const nowMinute = $derived(Math.floor(authStore.now / 60_000) * 60_000);
  // Spaces (tabs): "" is All. The trash isn't split by space.
  const activeSpace = $derived(credentialStore.activeSpace);
  const spaces = $derived(
    orderSpaces(
      spaceNames(credentialStore.active, [...credentialStore.pendingSpaces, activeSpace]),
      credentialStore.spaceOrder,
    ),
  );
  const spaceTotals = $derived(spaceCounts(credentialStore.active));
  const source = $derived(
    showTrash ? credentialStore.trash : inSpace(credentialStore.active, activeSpace),
  );
  // The user's own order (Reorder; A–Z until set): one list for the whole
  // vault, trash included, so a login restored from the trash keeps its place.
  const fullOrder = $derived(
    sortByOrder(credentialStore.items, credentialStore.credentialOrder).map((c) => c.id),
  );
  const rank = $derived(new Map(fullOrder.map((id, i) => [id, i])));
  const list = $derived(
    filterCredentials(source, filter, nowMinute).toSorted((a, b) =>
      showTrash
        ? (b.deletedAt ?? 0) - (a.deletedAt ?? 0)
        : (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
    ),
  );
  const options = $derived({ ...facets(credentialStore.active), spaces });
  const filtered = $derived(
    filter.query.trim() !== "" ||
      filter.category !== "" ||
      filter.owner !== "" ||
      filter.created !== "any",
  );

  // ---- your own order (Reorder) ---------------------------------------------------
  // Paused while searching or filtering, like the Authenticator: moving rows
  // between hidden ones would surprise.

  let reordering = $state(false);
  const rowsMovable = $derived(reordering && !showTrash && !filtered);

  async function saveRowOrder(ids: string[]) {
    try {
      await credentialStore.setCredentialOrder(ids);
    } catch (e) {
      failed(e, "Couldn't save the order");
    }
  }

  /** Swap with the neighbour shown above (-1) or below (+1). */
  function moveRow(id: string, delta: number) {
    const neighbour = list[list.findIndex((c) => c.id === id) + delta];
    if (neighbour) void saveRowOrder(moveOnto(fullOrder, id, neighbour.id));
  }

  async function sortAToZ() {
    await saveRowOrder([]);
    showToast("Sorted A–Z");
  }

  // ---- toast -------------------------------------------------------------------

  let toast = $state<ToastMessage | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(text: string, tone: "ok" | "bad" = "ok", undo?: () => void) {
    toast = { text, tone, undo };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), undo ? 6000 : 2400);
  }

  function failed(e: unknown, fallback: string) {
    const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    // Cancelling Windows Hello, the password prompt or a link confirmation is not an error.
    if (message === "canceled" || message === "hello_canceled") return;
    if (message === "open_rate_limited") {
      return showToast("Too many links opened in a short time — wait a moment and try again.", "bad");
    }
    showToast(message || fallback, "bad");
  }

  // ---- "confirm it's you" prompt -------------------------------------------------

  let promptResolve = $state<((value: string | null) => void) | null>(null);

  function askPassword(): Promise<string | null> {
    return new Promise((resolve) => {
      promptResolve = (value) => {
        promptResolve = null;
        resolve(value);
      };
    });
  }

  // ---- secrets -----------------------------------------------------------------

  /** Revealed passwords, by id — display only, auto-hidden, cleared on lock. */
  let revealed = $state<Record<string, string>>({});
  const hideTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function hide(id: string) {
    clearTimeout(hideTimers.get(id));
    hideTimers.delete(id);
    const { [id]: _gone, ...rest } = revealed;
    revealed = rest;
  }

  async function toggleReveal(c: StoredCredential) {
    if (revealed[c.id] !== undefined) return hide(c.id);
    try {
      const plain = await credentialStore.revealPassword(c.id, askPassword);
      revealed = { ...revealed, [c.id]: plain };
      clearTimeout(hideTimers.get(c.id));
      hideTimers.set(c.id, setTimeout(() => hide(c.id), 20_000));
    } catch (e) {
      failed(e, "Couldn't show the password");
    }
  }

  async function copyPassword(c: StoredCredential) {
    try {
      const plain = await credentialStore.passwordForCopy(c.id, askPassword);
      await copySecret(plain); // kept out of clipboard history / cloud sync (F-07)
      if (authStore.settings.clipboardClear) clearSecretLater(plain);
      showToast(
        authStore.settings.clipboardClear ? "Password copied — clears in 30 s" : "Password copied",
      );
    } catch (e) {
      failed(e, "Couldn't copy the password");
    }
  }

  async function copyPlain(text: string, what: string) {
    if (!text) return;
    await copyText(text);
    showToast(`${what} copied`);
  }

  async function openLink(url: string) {
    if (!url) return;
    try {
      await getPlatform().openExternal(url);
    } catch (e) {
      failed(e, "Couldn't open the link");
    }
  }

  // Locking hides everything that was decrypted and closes every dialog.
  $effect(() => {
    if (authStore.locked) {
      for (const id of Object.keys(revealed)) hide(id);
      reordering = false;
      dialog = null;
      editing = null;
      promptResolve?.(null);
    }
  });

  // ---- dialogs & CRUD -----------------------------------------------------------

  type Dialog = null | "add" | "edit" | "audit" | "settings" | "restore" | "new-space" | "spaces";
  let dialog = $state<Dialog>(null);
  let editing = $state<StoredCredential | null>(null);
  let restorePreselect = $state<string | null>(null);
  /** An exported backup file to restore from instead of Drive (F-24). */
  let restoreFile = $state<{ file: CloudBackupFile; name: string } | null>(null);

  function openAdd() {
    editing = null;
    dialog = "add";
  }

  function openEdit(c: StoredCredential) {
    editing = c;
    dialog = "edit";
  }

  async function save(input: CredentialInput) {
    if (editing) {
      await credentialStore.update(editing.id, input);
      showToast("Changes saved");
    } else {
      await credentialStore.add(input);
      showToast("Credential added");
    }
    hide(editing?.id ?? "");
    dialog = null;
    editing = null;
  }

  async function loadSecret(kind: "password" | "notes"): Promise<string | null> {
    if (!editing) return null;
    return kind === "password"
      ? credentialStore.revealPassword(editing.id, askPassword)
      : credentialStore.notesFor(editing.id, askPassword);
  }

  async function remove(c: StoredCredential) {
    try {
      await credentialStore.remove(c.id);
      hide(c.id);
      showToast(`“${c.platform}” moved to trash`, "ok", () => {
        toast = null;
        credentialStore.restore(c.id).catch((e) => failed(e, "Couldn't restore"));
      });
    } catch (e) {
      failed(e, "Couldn't delete");
    }
  }

  async function restore(c: StoredCredential) {
    try {
      await credentialStore.restore(c.id);
      showToast(`“${c.platform}” restored`);
    } catch (e) {
      failed(e, "Couldn't restore");
    }
  }

  let confirmPurge = $state<StoredCredential[] | null>(null);

  async function purge() {
    if (!confirmPurge) return;
    const ids = confirmPurge.map((c) => c.id);
    confirmPurge = null;
    try {
      await credentialStore.purge(ids);
      showToast(ids.length === 1 ? "Deleted permanently" : `${ids.length} credentials deleted permanently`);
    } catch (e) {
      failed(e, "Couldn't delete");
    }
  }

  // ---- spaces --------------------------------------------------------------------

  function selectSpace(name: string) {
    credentialStore.activeSpace = name;
  }

  // The All tab can be switched off once every login is filed in a space
  // (a view setting for this device, so it lives in localStorage). A login
  // without a space brings All back on its own: nothing is ever unreachable.
  const ALL_TAB_KEY = "coretools.credentials.allTab";
  let allTabWanted = $state(readSetting(ALL_TAB_KEY) !== "hidden");
  const everyLoginFiled = $derived(
    credentialStore.active.length > 0 && credentialStore.active.every((c) => c.space !== ""),
  );
  const showAllTab = $derived(allTabWanted || !everyLoginFiled);
  const tabOrder = $derived(showAllTab ? ["", ...spaces] : spaces);

  $effect(() => {
    if (!showAllTab && activeSpace === "" && spaces.length) selectSpace(spaces[0]);
  });

  function setAllTab(show: boolean) {
    allTabWanted = show;
    writeSetting(ALL_TAB_KEY, show ? null : "hidden");
  }

  /** Save the tab order (drag a tab onto another, or Move up/down in Manage spaces). */
  async function saveSpaceOrder(order: string[]) {
    try {
      await credentialStore.setSpaceOrder(order);
    } catch (e) {
      failed(e, "Couldn't save the order");
    }
  }

  function createSpace(name: string) {
    if (!spaces.includes(name)) {
      credentialStore.pendingSpaces = [...credentialStore.pendingSpaces, name];
      showToast(`Space “${name}” created — add logins or move them here`);
    }
    selectSpace(name);
    dialog = null;
  }

  // ---- cloud chip ----------------------------------------------------------------

  const cloudChip = $derived.by(() => {
    if (!cloudBackup.connected) return null;
    const s = cloudBackup.statusOf("credmanager");
    if (s === "up-to-date") return { tone: "ok", text: "Backed up to Google Drive" };
    if (s === "working" || s === "pending") return { tone: "busy", text: "Backing up…" };
    return { tone: "warn", text: "Backup needs attention" };
  });
</script>

<div class="cm">
  {#if authStore.loadError}
    <div class="load-error" role="alert">
      <p>{authStore.loadError}</p>
      <button onclick={() => authStore.retryInit()}>Try again</button>
    </div>
  {:else if !authStore.ready || !credentialStore.ready}
    <p class="muted center">Loading…</p>
  {:else if !authStore.encrypted}
    <VaultSetup ondone={(message) => showToast(message)} />
  {:else if authStore.locked}
    <LockScreen title="Credential Manager locked" />
  {:else}
    <!-- ------------------------------------ header ------------------------------------ -->
    <header class="head">
      <div class="title-block">
        <h2>Credential Manager</h2>
        <p class="muted">
          {credentialStore.active.length} saved {credentialStore.active.length === 1 ? "login" : "logins"} · encrypted with your master password
        </p>
      </div>
      <div class="head-actions">
        {#if cloudChip}
          <span class="cloud-chip tone-{cloudChip.tone}" title="Credentials are included in your end-to-end encrypted Google Drive backup">
            <Icon name="cloud" /> {cloudChip.text}
          </span>
        {/if}
        <IconButton icon="activity" tip="Activity log" onclick={() => (dialog = "audit")} outlined />
        <IconButton icon="gear" tip="Settings" onclick={() => (dialog = "settings")} outlined />
        <IconButton icon="lock" tip="Lock now" onclick={() => authStore.lock()} outlined />
      </div>
    </header>

    {#if credentialStore.unreadable > 0}
      <p class="weak-password" role="status">
        {credentialStore.unreadable === 1 ? "One saved login" : `${credentialStore.unreadable} saved logins`}
        couldn't be decrypted and {credentialStore.unreadable === 1 ? "is" : "are"} hidden; the
        rest are fine. Restore {credentialStore.unreadable === 1 ? "it" : "them"} from a backup or a
        local snapshot —
        <button class="link" onclick={() => (dialog = "settings")}>open Settings</button>.
      </p>
    {/if}

    {#if credentialStore.autoPurged > 0}
      <p class="weak-password" role="status">
        {credentialStore.autoPurged === 1 ? "One login" : `${credentialStore.autoPurged} logins`}
        in the trash for more than 30 days {credentialStore.autoPurged === 1 ? "was" : "were"} deleted
        permanently.
        <button class="link" onclick={() => (credentialStore.autoPurged = 0)}>Dismiss</button>
      </p>
    {/if}

    {#if getPlatform().kind === "browser" && authStore.storagePersisted === false}
      <p class="weak-password" role="status">
        This browser may clear its stored data when space runs low or after a
        while without visits. Export an encrypted backup file regularly —
        <button class="link" onclick={() => (dialog = "settings")}>open Settings</button>.
      </p>
    {/if}

    {#if authStore.weakPassword}
      <p class="weak-password" role="status">
        Your master password is weaker than CoreTools now requires (12+
        characters, not easily guessed). It protects every saved login and
        your backups —
        <button class="link" onclick={() => (dialog = "settings")}>change it in Settings</button>.
      </p>
    {/if}

    <CredentialToolbar
      bind:filter
      bind:trash={showTrash}
      categories={options.categories}
      owners={options.owners}
      trashCount={credentialStore.trash.length}
      onadd={openAdd}
    />

    {#if showTrash}
      <div class="trash-banner">
        <span>Trash — items are deleted permanently 30 days after you delete them.</span>
        {#if credentialStore.trash.length}
          <button class="ghost danger" onclick={() => (confirmPurge = [...credentialStore.trash])}>Empty trash</button>
        {/if}
        <button class="ghost" onclick={() => (showTrash = false)}>Back to credentials</button>
      </div>
    {/if}

    <!-- ------------------------------------ spaces ------------------------------------ -->
    {#if !showTrash && (credentialStore.active.length > 0 || spaces.length > 0)}
      <div class="spaces">
        <SpaceTabs
          tabs={tabOrder}
          active={activeSpace}
          count={(s) => (s ? (spaceTotals.get(s) ?? 0) : credentialStore.active.length)}
          onselect={selectSpace}
          onmove={(dragged, target) => void saveSpaceOrder(moveSpace(spaces, dragged, spaces.indexOf(target)))}
        />
        <button class="space-new" onclick={() => (dialog = "new-space")}>+ New space</button>
        <div class="spaces-end">
          <button
            class="ghost reorder-toggle"
            class:active={reordering}
            aria-pressed={reordering}
            onclick={() => (reordering = !reordering)}
            disabled={credentialStore.active.length < 2}
            title="Put your logins in your own order"
          >
            <Icon name="grip" /> Reorder
          </button>
          {#if everyLoginFiled}
            <Switch
              label="Show All"
              checked={allTabWanted}
              onchange={setAllTab}
              title="Every login is in a space, so the All tab is optional"
            />
          {/if}
          {#if spaces.length}
            <IconButton icon="more" tip="Manage spaces" onclick={() => (dialog = "spaces")} />
          {/if}
        </div>
      </div>
    {/if}

    {#if reordering && !showTrash}
      <div class="reorder-bar" role="status">
        <span>
          {#if filtered}
            Clear the search and filters to reorder.
          {:else}
            Drag logins by the handle, or use the arrows, to put them in your
            order. It's kept on this computer.
          {/if}
        </span>
        <button class="ghost" onclick={sortAToZ} disabled={credentialStore.credentialOrder.length === 0}>
          Sort A–Z
        </button>
        <button class="primary" onclick={() => (reordering = false)}>Done</button>
      </div>
    {/if}

    <!-- ------------------------------------- list -------------------------------------- -->
    {#if source.length === 0}
      <div class="empty">
        {#if showTrash}
          <p><strong>Trash is empty.</strong></p>
        {:else if activeSpace}
          <span class="hero-icon"><Icon name="key" /></span>
          <p><strong>No logins in “{activeSpace}” yet.</strong></p>
          <p class="muted">
            Add one here, or move an existing login by editing it and choosing
            this space. A space is kept once a login is in it.
          </p>
          <button class="primary" onclick={openAdd}>+ Add credential</button>
        {:else}
          <span class="hero-icon"><Icon name="key" /></span>
          <p><strong>No credentials yet.</strong></p>
          <p class="muted">
            Save logins for every platform in one encrypted place — copy
            usernames and passwords in one click, open login pages directly,
            and back everything up end-to-end encrypted to Google Drive.
          </p>
          <button class="primary" onclick={openAdd}>+ Add your first credential</button>
        {/if}
      </div>
    {:else if list.length === 0}
      <div class="empty">
        <p><strong>No credentials match.</strong></p>
        {#if filtered}
          <button class="ghost" onclick={() => (filter = { ...EMPTY_FILTER })}>Clear search & filters</button>
        {/if}
      </div>
    {:else}
      <CredentialTable
        rows={list}
        trash={showTrash}
        showSpace={showTrash || !activeSpace}
        {revealed}
        movable={rowsMovable}
        onmove={(dragged, target) => void saveRowOrder(moveOnto(fullOrder, dragged, target))}
        onstep={moveRow}
        onreveal={toggleReveal}
        oncopypassword={copyPassword}
        oncopy={copyPlain}
        onopen={openLink}
        onedit={openEdit}
        onremove={remove}
        onrestore={restore}
        onpurge={(c) => (confirmPurge = [c])}
      />
    {/if}
  {/if}

  {#if toast}<Toast {toast} />{/if}
</div>

{#if !authStore.locked}
  {#if dialog === "add" || dialog === "edit"}
    <CredentialDialog
      credential={dialog === "edit" ? editing : null}
      defaultSpace={activeSpace}
      suggestions={options}
      {loadSecret}
      onsave={save}
      onclose={() => { dialog = null; editing = null; }}
    />
  {:else if dialog === "new-space"}
    <NewSpaceDialog {spaces} oncreate={createSpace} onclose={() => (dialog = null)} />
  {:else if dialog === "spaces"}
    <ManageSpacesDialog
      {spaces}
      totals={spaceTotals}
      active={activeSpace}
      onselect={selectSpace}
      onmove={(s, delta) => void saveSpaceOrder(moveSpace(spaces, s, spaces.indexOf(s) + delta))}
      ontoast={(m) => showToast(m)}
      onfail={failed}
      onclose={() => (dialog = null)}
    />
  {:else if dialog === "audit"}
    <AuditLogDialog onclose={() => (dialog = null)} />
  {:else if dialog === "settings"}
    <SettingsDialog
      scope="credmanager"
      title="Credential Manager settings"
      onclose={() => (dialog = null)}
      ontoast={(m) => showToast(m)}
      onrestore={(id) => { restorePreselect = id ?? null; restoreFile = null; dialog = "restore"; }}
      onimportfile={(source) => { restoreFile = source; dialog = "restore"; }}
    />
  {:else if dialog === "restore"}
    <RestoreDialog
      scope="credmanager"
      preselectId={restorePreselect}
      fromFile={restoreFile}
      onclose={() => (dialog = null)}
      ontoast={(m) => showToast(m)}
    />
  {/if}

  {#if confirmPurge}
    <Modal title="Delete permanently?" onclose={() => (confirmPurge = null)}>
      <p>
        {#if confirmPurge.length === 1}
          Permanently delete <strong>{confirmPurge[0].platform}</strong>?
        {:else}
          Permanently delete all <strong>{confirmPurge.length}</strong> credentials in the trash?
        {/if}
      </p>
      <p class="warn-text">This can't be undone on this device. Older cloud backups may still contain it until they're replaced.</p>
      <div class="modal-actions">
        <button onclick={() => (confirmPurge = null)}>Cancel</button>
        <button class="danger-solid" onclick={purge}>Delete permanently</button>
      </div>
    </Modal>
  {/if}
{/if}

{#if promptResolve}
  <PasswordPrompt
    onsubmit={(pw) => promptResolve?.(pw)}
    oncancel={() => promptResolve?.(null)}
  />
{/if}

<style>
  .cm {
    max-width: 1120px;
    margin: 0 auto;
  }
  .load-error {
    margin: 40px auto;
    max-width: 460px;
    padding: 14px 16px;
    border-radius: 10px;
    background: var(--removed-bg);
    color: var(--removed-fg);
    font-size: 13px;
    line-height: 1.5;
  }
  .load-error p {
    margin: 0 0 10px;
  }
  .weak-password {
    margin: 0 0 10px;
    padding: 9px 12px;
    border-radius: 9px;
    font-size: 12.5px;
    background: color-mix(in srgb, #f6ad55 12%, transparent);
    border: 1px solid color-mix(in srgb, #f6ad55 35%, transparent);
  }
  .weak-password .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .center {
    text-align: center;
    padding: 40px 0;
  }
  .hero-icon {
    display: inline-grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .hero-icon :global(svg) {
    width: 22px;
    height: 22px;
  }

  /* ---- header ---- */
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .title-block h2 {
    margin: 0;
    font-size: 18px;
    letter-spacing: -0.01em;
  }
  .title-block p {
    margin: 2px 0 0;
    font-size: 12.5px;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cloud-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    margin-right: 4px;
  }
  .cloud-chip :global(svg) {
    width: 13px;
    height: 13px;
  }
  .cloud-chip.tone-ok { background: var(--added-bg); color: var(--added-fg); }
  .cloud-chip.tone-busy { background: var(--accent-soft); color: var(--accent); }
  .cloud-chip.tone-warn { background: var(--removed-bg); color: var(--removed-fg); }

  .ghost {
    background: transparent;
  }
  .ghost.active {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .ghost.danger {
    color: var(--danger);
  }
  .trash-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    margin-bottom: 12px;
    border-radius: 10px;
    font-size: 12.5px;
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
  .trash-banner span {
    flex: 1;
  }
  .trash-banner button {
    font-size: 12px;
    padding: 5px 10px;
    border-radius: 7px;
  }

  /* ---- spaces bar ---- */
  .spaces {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .space-new {
    flex: none;
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 12.5px;
    font-weight: 600;
    padding: 6px 8px;
    white-space: nowrap;
  }
  .space-new:hover {
    text-decoration: underline;
  }
  .spaces-end {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
    margin-left: auto;
  }
  /* ---- your own order ---- */
  .reorder-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font-size: 12.5px;
    padding: 5px 10px;
    border-radius: 8px;
  }
  .reorder-toggle :global(svg) {
    width: 13px;
    height: 13px;
  }
  .reorder-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 14px;
    margin-bottom: 12px;
    border-radius: 10px;
    font-size: 12.5px;
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .reorder-bar span {
    flex: 1;
  }
  .reorder-bar button {
    font-size: 12px;
    padding: 5px 12px;
    border-radius: 7px;
  }

  /* ---- empty states ---- */
  .empty {
    text-align: center;
    padding: 52px 24px;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .empty p {
    margin: 10px auto;
    max-width: 440px;
    font-size: 13px;
  }

  /* ---- delete-permanently dialog ---- */
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
  .danger-solid {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
    font-weight: 600;
  }

  @media (max-width: 760px) {
    .head-actions .cloud-chip {
      display: none;
    }
  }
</style>
