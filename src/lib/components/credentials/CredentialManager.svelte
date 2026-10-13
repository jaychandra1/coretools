<script lang="ts">
  import { authStore } from "../authenticator/store.svelte";
  import { cloudBackup } from "../authenticator/cloud.svelte";
  import LockScreen from "../authenticator/LockScreen.svelte";
  import Modal from "../authenticator/Modal.svelte";
  import SettingsDialog from "../authenticator/SettingsDialog.svelte";
  import RestoreDialog from "../authenticator/RestoreDialog.svelte";
  import CredentialDialog from "./CredentialDialog.svelte";
  import AuditLogDialog from "./AuditLogDialog.svelte";
  import PasswordPrompt from "./PasswordPrompt.svelte";
  import { credentialStore, type CredentialInput } from "./credentials.svelte";
  import { copyText, clearClipboardLater } from "./clipboard";
  import {
    CREATED_RANGES,
    EMPTY_FILTER,
    facets,
    filterCredentials,
    type CredentialFilter,
  } from "../../core/credentials/search";
  import { displayUrl } from "../../core/credentials/url";
  import { TRASH_RETENTION_MS, type StoredCredential } from "../../core/credentials/types";
  import { getPlatform } from "../../platform";

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
  let searchInput: HTMLInputElement | undefined = $state();

  /** Minute-granular clock: date filters don't need the 500 ms tick. */
  const nowMinute = $derived(Math.floor(authStore.now / 60_000) * 60_000);
  const source = $derived(showTrash ? credentialStore.trash : credentialStore.active);
  const list = $derived(
    filterCredentials(source, filter, nowMinute).toSorted((a, b) =>
      showTrash
        ? (b.deletedAt ?? 0) - (a.deletedAt ?? 0)
        : a.platform.localeCompare(b.platform, undefined, { sensitivity: "base" }),
    ),
  );
  const options = $derived(facets(credentialStore.active));
  const filtered = $derived(
    filter.query.trim() !== "" ||
      filter.category !== "" ||
      filter.owner !== "" ||
      filter.created !== "any",
  );

  function onGlobalKeydown(event: KeyboardEvent) {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
    event.preventDefault();
    searchInput?.focus();
  }

  function hue(name: string): number {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % 360;
  }

  // ---- toast -------------------------------------------------------------------

  let toast = $state<{ text: string; tone: "ok" | "bad"; undo?: () => void } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(text: string, tone: "ok" | "bad" = "ok", undo?: () => void) {
    toast = { text, tone, undo };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), undo ? 6000 : 2400);
  }

  function failed(e: unknown, fallback: string) {
    const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    // Cancelling Windows Hello or the password prompt is not an error.
    if (message === "canceled" || message === "hello_canceled") return;
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
      await copyText(plain);
      if (authStore.settings.clipboardClear) clearClipboardLater(plain);
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
      dialog = null;
      editing = null;
      promptResolve?.(null);
    }
  });

  // ---- dialogs & CRUD -----------------------------------------------------------

  type Dialog = null | "add" | "edit" | "audit" | "settings" | "restore";
  let dialog = $state<Dialog>(null);
  let editing = $state<StoredCredential | null>(null);
  let restorePreselect = $state<string | null>(null);

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
        void credentialStore.restore(c.id);
        toast = null;
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

  function daysLeft(c: StoredCredential): number {
    // Exact clock here: the minute-floored one would read "31 days" right after deleting.
    return Math.max(0, Math.ceil(((c.deletedAt ?? 0) + TRASH_RETENTION_MS - authStore.now) / 86_400_000));
  }

  // ---- master password onboarding ------------------------------------------------

  let newPw = $state("");
  let confirmPw = $state("");
  let onboardError = $state("");
  let onboardBusy = $state(false);

  async function createVault(event: SubmitEvent) {
    event.preventDefault();
    if (newPw.length < 8 || newPw !== confirmPw || onboardBusy) return;
    onboardBusy = true;
    onboardError = "";
    try {
      await authStore.setPassword(newPw);
      newPw = confirmPw = "";
      showToast("Master password set — your vault is encrypted");
    } catch (e) {
      onboardError = e instanceof Error ? e.message : "Couldn't set the password";
    } finally {
      onboardBusy = false;
    }
  }

  // ---- cloud chip ----------------------------------------------------------------

  const cloudChip = $derived.by(() => {
    if (!cloudBackup.connected) return null;
    const s = cloudBackup.status;
    if (s === "up-to-date") return { tone: "ok", text: "Backed up to Google Drive" };
    if (s === "working" || s === "pending") return { tone: "busy", text: "Backing up…" };
    return { tone: "warn", text: "Backup needs attention" };
  });
</script>

<svelte:window onkeydown={onGlobalKeydown} />

{#snippet icon(name: string)}
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if name === "eye"}
      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" /><circle cx="12" cy="12" r="3" />
    {:else if name === "eye-off"}
      <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.7 9.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 7 9.5 7a9.4 9.4 0 0 0 5.4-1.6" />
    {:else if name === "user"}
      <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
    {:else if name === "key"}
      <circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7M16 6l3 3M14 8l2 2" />
    {:else if name === "link"}
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    {:else if name === "open"}
      <path d="M14 4h6v6M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    {:else if name === "edit"}
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" />
    {:else if name === "trash"}
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    {:else if name === "restore"}
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
    {:else if name === "search"}
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    {:else if name === "lock"}
      <rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />
    {:else if name === "activity"}
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    {:else if name === "gear"}
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    {:else if name === "cloud"}
      <path d="M17.5 19H8a5 5 0 1 1 1.6-9.7A6 6 0 0 1 21 12.5 4.5 4.5 0 0 1 17.5 19z" />
    {/if}
  </svg>
{/snippet}

{#snippet iconButton(name: string, tip: string, run: () => void, extra = "", disabled = false)}
  <button class="icon-btn {extra}" onclick={run} data-tip={tip} aria-label={tip} {disabled}>
    {@render icon(name)}
  </button>
{/snippet}

<div class="cm">
  {#if !authStore.ready || !credentialStore.ready}
    <p class="muted center">Loading…</p>
  {:else if !authStore.encrypted}
    <!-- ------------------------- onboarding: master password ------------------------- -->
    <div class="onboard">
      <span class="hero-icon">{@render icon("lock")}</span>
      <h2>Set a master password</h2>
      <p class="muted">
        The Credential Manager keeps every password encrypted with AES-256-GCM
        under a key derived from your master password. It's the same vault
        password as the Authenticator, so one password (or Windows Hello)
        unlocks both{authStore.entries.length > 0 ? " — and setting it also encrypts your Authenticator accounts" : ""}.
      </p>
      <form onsubmit={createVault}>
        <input type="password" bind:value={newPw} placeholder="Master password (min. 8 characters)" autocomplete="new-password" aria-label="Master password" />
        <input type="password" bind:value={confirmPw} placeholder="Confirm master password" autocomplete="new-password" aria-label="Confirm master password" />
        {#if newPw && confirmPw && newPw !== confirmPw}
          <span class="field-error">Passwords don't match.</span>
        {:else if newPw && newPw.length < 8}
          <span class="field-error">Use at least 8 characters.</span>
        {/if}
        <button class="primary" type="submit" disabled={newPw.length < 8 || newPw !== confirmPw || onboardBusy}>
          {onboardBusy ? "Encrypting…" : "Create encrypted vault"}
        </button>
        {#if onboardError}<span class="field-error" role="alert">{onboardError}</span>{/if}
      </form>
      <p class="muted small">There's no way to recover a forgotten master password — store it somewhere safe.</p>
    </div>
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
            {@render icon("cloud")} {cloudChip.text}
          </span>
        {/if}
        {@render iconButton("activity", "Activity log", () => (dialog = "audit"))}
        {@render iconButton("gear", "Vault & security settings", () => (dialog = "settings"))}
        {@render iconButton("lock", "Lock now", () => authStore.lock())}
      </div>
    </header>

    <!-- ------------------------------------ toolbar ------------------------------------ -->
    <div class="toolbar">
      <div class="search">
        {@render icon("search")}
        <input
          bind:this={searchInput}
          bind:value={filter.query}
          placeholder="Search platform, URL, username or #tag  (press /)"
          aria-label="Search credentials"
        />
        {#if filter.query}
          <button class="clear" onclick={() => (filter.query = "")} aria-label="Clear search">✕</button>
        {/if}
      </div>
      <select bind:value={filter.category} aria-label="Filter by category">
        <option value="">All categories</option>
        {#each options.categories as c (c)}<option value={c}>{c}</option>{/each}
      </select>
      <select bind:value={filter.owner} aria-label="Filter by owner">
        <option value="">All owners</option>
        {#each options.owners as o (o)}<option value={o}>{o}</option>{/each}
      </select>
      <select bind:value={filter.created} aria-label="Filter by creation date">
        {#each CREATED_RANGES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}
      </select>
      <button class="ghost" class:active={showTrash} onclick={() => (showTrash = !showTrash)}>
        {@render icon("trash")} Trash{credentialStore.trash.length ? ` (${credentialStore.trash.length})` : ""}
      </button>
      {#if !showTrash}
        <button class="primary" onclick={() => { editing = null; dialog = "add"; }}>+ Add credential</button>
      {/if}
    </div>

    {#if showTrash}
      <div class="trash-banner">
        <span>Trash — items are deleted permanently 30 days after you delete them.</span>
        {#if credentialStore.trash.length}
          <button class="ghost danger" onclick={() => (confirmPurge = [...credentialStore.trash])}>Empty trash</button>
        {/if}
        <button class="ghost" onclick={() => (showTrash = false)}>Back to credentials</button>
      </div>
    {/if}

    <!-- ------------------------------------- list -------------------------------------- -->
    {#if source.length === 0}
      <div class="empty">
        {#if showTrash}
          <p><strong>Trash is empty.</strong></p>
        {:else}
          <span class="hero-icon">{@render icon("key")}</span>
          <p><strong>No credentials yet.</strong></p>
          <p class="muted">
            Save logins for every platform in one encrypted place — copy
            usernames and passwords in one click, open login pages directly,
            and back everything up end-to-end encrypted to Google Drive.
          </p>
          <button class="primary" onclick={() => { editing = null; dialog = "add"; }}>+ Add your first credential</button>
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
      <div class="table" role="table" aria-label={showTrash ? "Deleted credentials" : "Saved credentials"}>
        <div class="tr thead" role="row">
          <span role="columnheader">Platform</span>
          <span role="columnheader">Login URL</span>
          <span role="columnheader">Username</span>
          <span role="columnheader">Password</span>
          <span role="columnheader" class="actions-head">Actions</span>
        </div>
        {#each list as c (c.id)}
          <div class="tr" role="row">
            <div class="td platform" role="cell">
              <span class="avatar" style="background: hsl({hue(c.platform)}, 55%, 42%)" aria-hidden="true">
                {c.platform.trim().charAt(0).toUpperCase() || "?"}
              </span>
              <span class="platform-text">
                <span class="platform-name" title={c.platform}>{c.platform}</span>
                <span class="meta">
                  {#if showTrash}
                    <span class="chip warn">Deleted · {daysLeft(c)} {daysLeft(c) === 1 ? "day" : "days"} left</span>
                  {/if}
                  {#if c.category}<span class="chip">{c.category}</span>{/if}
                  {#if c.owner}<span class="chip subtle">{c.owner}</span>{/if}
                  {#each c.tags.slice(0, 3) as tag (tag)}<span class="tag">#{tag}</span>{/each}
                  {#if c.tags.length > 3}<span class="tag">+{c.tags.length - 3}</span>{/if}
                </span>
              </span>
            </div>
            <div class="td" role="cell" data-label="Login URL">
              {#if c.url}
                <span class="url" title={c.url}>{displayUrl(c.url)}</span>
              {:else}<span class="none">—</span>{/if}
            </div>
            <div class="td" role="cell" data-label="Username">
              {#if c.username}<span class="username" title={c.username}>{c.username}</span>{:else}<span class="none">—</span>{/if}
            </div>
            <div class="td" role="cell" data-label="Password">
              {#if revealed[c.id] !== undefined}
                <span class="secret revealed" title="Hides automatically in 20 seconds">{revealed[c.id] || "(empty)"}</span>
              {:else}
                <span class="secret">••••••••••</span>
              {/if}
            </div>
            <div class="td actions" role="cell">
              {#if showTrash}
                {@render iconButton("restore", "Restore", () => restore(c))}
                {@render iconButton("trash", "Delete permanently", () => (confirmPurge = [c]), "danger")}
              {:else}
                {@render iconButton(revealed[c.id] !== undefined ? "eye-off" : "eye", revealed[c.id] !== undefined ? "Hide password" : "Show password", () => toggleReveal(c))}
                {@render iconButton("user", "Copy username", () => copyPlain(c.username, "Username"), "", !c.username)}
                {@render iconButton("key", "Copy password", () => copyPassword(c))}
                {@render iconButton("link", "Copy login URL", () => copyPlain(c.url, "URL"), "", !c.url)}
                {@render iconButton("open", "Open login page", () => openLink(c.url), "", !c.url)}
                <span class="sep" aria-hidden="true"></span>
                {@render iconButton("edit", "Edit", () => openEdit(c))}
                {@render iconButton("trash", "Move to trash", () => remove(c), "danger")}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  {#if toast}
    <div class="toast tone-{toast.tone}" role="status">
      <span>{toast.text}</span>
      {#if toast.undo}<button class="undo" onclick={toast.undo}>Undo</button>{/if}
    </div>
  {/if}
</div>

{#if !authStore.locked}
  {#if dialog === "add" || dialog === "edit"}
    <CredentialDialog
      credential={dialog === "edit" ? editing : null}
      suggestions={options}
      {loadSecret}
      onsave={save}
      onclose={() => { dialog = null; editing = null; }}
    />
  {:else if dialog === "audit"}
    <AuditLogDialog onclose={() => (dialog = null)} />
  {:else if dialog === "settings"}
    <SettingsDialog
      title="Vault & security settings"
      onclose={() => (dialog = null)}
      ontoast={(m) => showToast(m)}
      onrestore={(id) => { restorePreselect = id ?? null; dialog = "restore"; }}
    />
  {:else if dialog === "restore"}
    <RestoreDialog
      preselectId={restorePreselect}
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
  .center {
    text-align: center;
    padding: 40px 0;
  }
  .small {
    font-size: 12px;
  }

  /* ---- onboarding ---- */
  .onboard {
    max-width: 440px;
    margin: 40px auto;
    padding: 28px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent 120px),
      var(--surface);
    text-align: center;
  }
  .onboard h2 {
    margin: 12px 0 6px;
    font-size: 18px;
  }
  .onboard p {
    font-size: 13px;
    line-height: 1.55;
  }
  .onboard form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 18px 0 10px;
    text-align: left;
  }
  .onboard input,
  .search input,
  select {
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
  }
  .onboard input {
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
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
  .field-error {
    color: var(--danger);
    font-size: 12px;
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

  /* ---- toolbar ---- */
  .toolbar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .search {
    flex: 1 1 260px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text-muted);
  }
  .search:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .search input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    padding: 8px 0;
    min-width: 0;
  }
  .search .clear {
    border: none;
    background: transparent;
    padding: 2px 4px;
    color: var(--text-muted);
    font-size: 12px;
  }
  select {
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    max-width: 180px;
  }
  .toolbar button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 8px;
  }
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

  /* ---- table / cards ---- */
  .table {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    overflow: hidden;
  }
  .tr {
    display: grid;
    grid-template-columns:
      minmax(190px, 1.35fr) minmax(150px, 1.2fr) minmax(130px, 1fr)
      minmax(120px, 0.9fr) auto;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
    transition: background 0.12s ease;
  }
  .tr:not(.thead):hover {
    background: color-mix(in srgb, var(--accent) 4%, transparent);
  }
  .thead {
    border-top: none;
    background: var(--surface-2);
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    padding-top: 9px;
    padding-bottom: 9px;
  }
  .actions-head {
    text-align: right;
  }
  .td {
    min-width: 0;
    font-size: 13px;
  }
  .platform {
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .avatar {
    flex: none;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    color: #fff;
    font-weight: 700;
    font-size: 14px;
  }
  .platform-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .platform-name {
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .chip.subtle {
    background: var(--surface-2);
    color: var(--text-muted);
  }
  .chip.warn {
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
  .tag {
    font-size: 10.5px;
    color: var(--text-muted);
  }
  .url,
  .username {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .url {
    color: var(--text-muted);
  }
  .none {
    color: var(--text-muted);
  }
  .secret {
    font-family: var(--mono);
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .secret.revealed {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
    letter-spacing: 0.02em;
    color: var(--text);
    background: var(--accent-soft);
    padding: 2px 6px;
    border-radius: 5px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 2px;
  }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 4px;
  }
  .icon-btn {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--text-muted);
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--accent);
  }
  .icon-btn.danger:hover:not(:disabled) {
    color: var(--danger);
    background: var(--removed-bg);
  }
  .icon-btn:disabled {
    opacity: 0.3;
  }
  .head-actions .icon-btn {
    border-color: var(--border);
  }

  /* Hover tooltips on every action icon. */
  [data-tip] {
    position: relative;
  }
  [data-tip]:hover::after,
  [data-tip]:focus-visible::after {
    content: attr(data-tip);
    position: absolute;
    bottom: calc(100% + 7px);
    left: 50%;
    transform: translateX(-50%);
    white-space: nowrap;
    font-size: 11px;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--text);
    color: var(--bg);
    pointer-events: none;
    z-index: 20;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
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

  /* ---- toast ---- */
  .toast {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--text);
    color: var(--bg);
    padding: 9px 18px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    z-index: 60;
    animation: toast-in 0.18s ease;
  }
  .toast.tone-bad {
    background: var(--danger);
    color: #fff;
  }
  .undo {
    border: none;
    background: transparent;
    color: inherit;
    font-weight: 700;
    text-decoration: underline;
    padding: 0;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
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
  .danger-solid {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
    font-weight: 600;
  }

  /* ---- mobile: rows become cards ---- */
  @media (max-width: 760px) {
    .table {
      border: none;
      background: transparent;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .thead {
      display: none;
    }
    .tr {
      grid-template-columns: 1fr;
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
    }
    .td[data-label] {
      display: grid;
      grid-template-columns: 92px 1fr;
      align-items: center;
      gap: 8px;
    }
    .td[data-label]::before {
      content: attr(data-label);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .actions {
      justify-content: flex-start;
      flex-wrap: wrap;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }
    .head-actions .cloud-chip {
      display: none;
    }
  }
</style>
