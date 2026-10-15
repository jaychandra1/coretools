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
  import PasswordStrength from "../authenticator/PasswordStrength.svelte";
  import { assessPassword } from "../../core/authenticator/password-strength";
  import type { CloudBackupFile } from "../../core/authenticator/cloud-backup";
  import { credentialStore, type CredentialInput } from "./credentials.svelte";
  import { copySecret, copyText, clearSecretLater } from "../../secure-clipboard";
  import {
    CREATED_RANGES,
    EMPTY_FILTER,
    facets,
    filterCredentials,
    type CredentialFilter,
  } from "../../core/credentials/search";
  import { displayUrl } from "../../core/credentials/url";
  import { moveOnto, sortByOrder } from "../../core/credentials/order";
  import {
    canonicalSpace,
    inSpace,
    moveSpace,
    orderSpaces,
    renameInOrder,
    spaceCounts,
    spaceHue,
    spaceNameError,
    spaceNames,
    SPACE_NAME_MAX,
  } from "../../core/credentials/spaces";
  import { TRASH_RETENTION_MS, type StoredCredential } from "../../core/credentials/types";
  import { getPlatform } from "../../platform";
  import { focusOnMount } from "../../focus";

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
  let draggedRow = $state<string | null>(null);
  let dropRow = $state<string | null>(null);

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

  function onRowDragStart(event: DragEvent, id: string) {
    draggedRow = id;
    if (event.dataTransfer) {
      // Some engines refuse to start a drag without data.
      event.dataTransfer.setData("text/plain", id);
      event.dataTransfer.effectAllowed = "move";
    }
  }

  function onRowDragOver(event: DragEvent, id: string) {
    if (!draggedRow || draggedRow === id) return;
    event.preventDefault(); // required for the drop event to fire
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dropRow = id;
  }

  function onRowDrop(event: DragEvent, id: string) {
    event.preventDefault();
    const dragged = draggedRow;
    draggedRow = dropRow = null;
    if (dragged && dragged !== id) void saveRowOrder(moveOnto(fullOrder, dragged, id));
  }

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

  function readSetting(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeSetting(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Storage unavailable: the choice lasts until the app closes.
    }
  }

  // ---- tab order: drag a tab onto another, or Move up/down in Manage spaces ----

  let draggedSpace = $state<string | null>(null);
  let dropTarget = $state<string | null>(null);

  async function saveOrder(order: string[]) {
    try {
      await credentialStore.setSpaceOrder(order);
    } catch (e) {
      failed(e, "Couldn't save the order");
    }
  }

  function moveBy(name: string, delta: number) {
    void saveOrder(moveSpace(spaces, name, spaces.indexOf(name) + delta));
  }

  /** Keep a saved order in step with a rename, merge or removal (`to` = null). */
  async function reorderAfter(from: string, to: string | null) {
    if (credentialStore.spaceOrder.length === 0) return;
    await credentialStore.setSpaceOrder(renameInOrder(credentialStore.spaceOrder, from, to));
  }

  function onTabDragStart(event: DragEvent, name: string) {
    draggedSpace = name;
    if (event.dataTransfer) {
      // Some engines refuse to start a drag without data.
      event.dataTransfer.setData("text/plain", name);
      event.dataTransfer.effectAllowed = "move";
    }
  }

  function onTabDragOver(event: DragEvent, name: string) {
    if (!draggedSpace || !name || name === draggedSpace) return; // All stays first
    event.preventDefault(); // required for the drop event to fire
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dropTarget = name;
  }

  function onTabDrop(event: DragEvent, name: string) {
    event.preventDefault();
    const dragged = draggedSpace;
    draggedSpace = dropTarget = null;
    // Dropped onto a tab: take its place (after it when moving right, before when moving left).
    if (dragged && name && dragged !== name) void saveOrder(moveSpace(spaces, dragged, spaces.indexOf(name)));
  }

  function onTabDragEnd() {
    draggedSpace = dropTarget = null;
  }

  /** Arrow keys move along the tabs (WAI-ARIA tabs pattern). */
  function onTabKeydown(event: KeyboardEvent) {
    const order = tabOrder;
    const at = order.indexOf(activeSpace);
    let next = at;
    if (event.key === "ArrowRight") next = (at + 1) % order.length;
    else if (event.key === "ArrowLeft") next = (at - 1 + order.length) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    else return;
    event.preventDefault();
    selectSpace(order[next]);
    const tabs = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]');
    tabs[next]?.focus();
  }

  let spaceName = $state("");
  let spaceFormError = $state("");

  function openNewSpace() {
    spaceName = "";
    spaceFormError = "";
    dialog = "new-space";
  }

  function createSpace(event: SubmitEvent) {
    event.preventDefault();
    spaceFormError = spaceNameError(spaceName) ?? "";
    if (spaceFormError) return;
    const name = canonicalSpace(spaceName, spaces);
    if (!spaces.includes(name)) {
      credentialStore.pendingSpaces = [...credentialStore.pendingSpaces, name];
      showToast(`Space “${name}” created — add logins or move them here`);
    }
    selectSpace(name);
    dialog = null;
  }

  /** Manage dialog: the space being renamed or confirmed for removal. */
  let renaming = $state<string | null>(null);
  let renameText = $state("");
  let removing = $state<string | null>(null);
  let spaceBusy = $state(false);

  const renameTarget = $derived(
    renaming ? canonicalSpace(renameText, spaces.filter((s) => s !== renaming)) : "",
  );
  const renameMerges = $derived(
    !!renaming && renameTarget !== "" && spaces.some((s) => s !== renaming && s === renameTarget),
  );

  function openManageSpaces() {
    renaming = removing = null;
    spaceFormError = "";
    dialog = "spaces";
  }

  function startRename(name: string) {
    removing = null;
    renaming = name;
    renameText = name;
    spaceFormError = "";
  }

  function swapPending(from: string, to: string | null) {
    const rest = credentialStore.pendingSpaces.filter((s) => s !== from);
    credentialStore.pendingSpaces = to && !rest.includes(to) ? [...rest, to] : rest;
  }

  async function commitRename(event: SubmitEvent) {
    event.preventDefault();
    const from = renaming;
    if (!from || spaceBusy) return;
    spaceFormError = spaceNameError(renameText) ?? "";
    if (spaceFormError) return;
    // Read before the move: afterwards `to` is a space either way.
    const to = renameTarget;
    const merging = renameMerges;
    spaceBusy = true;
    try {
      if (to !== from) {
        await credentialStore.moveToSpace(credentialStore.idsInSpace(from), to);
        await reorderAfter(from, to);
        swapPending(from, credentialStore.idsInSpace(to).length ? null : to);
        if (activeSpace === from) selectSpace(to);
        showToast(merging ? `Moved “${from}” into “${to}”` : `Renamed to “${to}”`);
      }
      renaming = null;
    } catch (e) {
      failed(e, "Couldn't rename the space");
    } finally {
      spaceBusy = false;
    }
  }

  async function removeSpace(name: string) {
    if (spaceBusy) return;
    spaceBusy = true;
    try {
      const moved = await credentialStore.moveToSpace(credentialStore.idsInSpace(name), "");
      await reorderAfter(name, null);
      swapPending(name, null);
      if (activeSpace === name) selectSpace("");
      removing = null;
      if (spaces.length === 0) dialog = null; // nothing left to manage
      showToast(
        moved
          ? `Removed “${name}” — its ${moved === 1 ? "login is" : `${moved} logins are`} still under All`
          : `Removed “${name}”`,
      );
    } catch (e) {
      failed(e, "Couldn't remove the space");
    } finally {
      spaceBusy = false;
    }
  }

  // ---- master password onboarding ------------------------------------------------

  let newPw = $state("");
  let confirmPw = $state("");
  let onboardError = $state("");
  let onboardBusy = $state(false);

  async function createVault(event: SubmitEvent) {
    event.preventDefault();
    if (!assessPassword(newPw).ok || newPw !== confirmPw || onboardBusy) return;
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
    const s = cloudBackup.statusOf("credmanager");
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
    {:else if name === "grip"}
      <circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" />
    {:else if name === "up"}
      <path d="m6 15 6-6 6 6" />
    {:else if name === "down"}
      <path d="m6 9 6 6 6-6" />
    {:else if name === "more"}
      <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
    {/if}
  </svg>
{/snippet}

{#snippet iconButton(name: string, tip: string, run: () => void, extra = "", disabled = false)}
  <button class="icon-btn {extra}" onclick={run} data-tip={tip} aria-label={tip} {disabled}>
    {@render icon(name)}
  </button>
{/snippet}

<div class="cm">
  {#if authStore.loadError}
    <p class="load-error" role="alert">{authStore.loadError}</p>
  {:else if !authStore.ready || !credentialStore.ready}
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
        <input type="password" bind:value={newPw} placeholder="Master password (min. 12 characters)" autocomplete="new-password" aria-label="Master password" />
        <input type="password" bind:value={confirmPw} placeholder="Confirm master password" autocomplete="new-password" aria-label="Confirm master password" />
        <PasswordStrength password={newPw} />
        {#if newPw && confirmPw && newPw !== confirmPw}
          <span class="field-error">Passwords don't match.</span>
        {/if}
        <button class="primary" type="submit" disabled={!assessPassword(newPw).ok || newPw !== confirmPw || onboardBusy}>
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
        {@render iconButton("gear", "Settings", () => (dialog = "settings"))}
        {@render iconButton("lock", "Lock now", () => authStore.lock())}
      </div>
    </header>

    {#if authStore.weakPassword}
      <p class="weak-password" role="status">
        Your master password is weaker than CoreTools now requires (12+
        characters, not easily guessed). It protects every saved login and
        your backups —
        <button class="link" onclick={() => (dialog = "settings")}>change it in Settings</button>.
      </p>
    {/if}

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

    <!-- ------------------------------------ spaces ------------------------------------ -->
    {#if !showTrash && (credentialStore.active.length > 0 || spaces.length > 0)}
      <div class="spaces">
        <div class="space-tabs" role="tablist" aria-label="Spaces" tabindex="-1" onkeydown={onTabKeydown}>
          {#each tabOrder as s (s)}
            {@const n = s ? (spaceTotals.get(s) ?? 0) : credentialStore.active.length}
            <button
              role="tab"
              class="space-tab"
              class:on={activeSpace === s}
              aria-selected={activeSpace === s}
              aria-label="{s || 'All'}, {n} {n === 1 ? 'login' : 'logins'}"
              tabindex={activeSpace === s ? 0 : -1}
              onclick={() => selectSpace(s)}
              draggable={s !== ""}
              class:dragging={draggedSpace === s}
              class:drop-target={dropTarget === s}
              ondragstart={(e) => onTabDragStart(e, s)}
              ondragover={(e) => onTabDragOver(e, s)}
              ondragleave={() => dropTarget === s && (dropTarget = null)}
              ondrop={(e) => onTabDrop(e, s)}
              ondragend={onTabDragEnd}
            >
              {#if s}<span class="dot" style="background: hsl({spaceHue(s)}, 60%, 55%)" aria-hidden="true"></span>{/if}
              <span class="space-name" title={s || undefined}>{s || "All"}</span>
              <span class="count" aria-hidden="true">{n}</span>
            </button>
          {/each}
        </div>
        <button class="space-new" onclick={openNewSpace}>+ New space</button>
        <div class="spaces-end">
          <button
            class="ghost reorder-toggle"
            class:active={reordering}
            aria-pressed={reordering}
            onclick={() => (reordering = !reordering)}
            disabled={credentialStore.active.length < 2}
            title="Put your logins in your own order"
          >
            {@render icon("grip")} Reorder
          </button>
          {#if everyLoginFiled}
            <label class="all-switch" title="Every login is in a space, so the All tab is optional">
              <input
                type="checkbox"
                role="switch"
                checked={allTabWanted}
                onchange={(e) => setAllTab(e.currentTarget.checked)}
              />
              <span>Show All</span>
            </label>
          {/if}
          {#if spaces.length}
            {@render iconButton("more", "Manage spaces", openManageSpaces)}
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
          <span class="hero-icon">{@render icon("key")}</span>
          <p><strong>No logins in “{activeSpace}” yet.</strong></p>
          <p class="muted">
            Add one here, or move an existing login by editing it and choosing
            this space. A space is kept once a login is in it.
          </p>
          <button class="primary" onclick={() => { editing = null; dialog = "add"; }}>+ Add credential</button>
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
        {#each list as c, i (c.id)}
          <div
            class="tr"
            role="row"
            tabindex="-1"
            class:movable={rowsMovable}
            class:dragging={draggedRow === c.id}
            class:drop-row={dropRow === c.id}
            draggable={rowsMovable}
            ondragstart={(e) => onRowDragStart(e, c.id)}
            ondragover={(e) => onRowDragOver(e, c.id)}
            ondragleave={() => dropRow === c.id && (dropRow = null)}
            ondrop={(e) => onRowDrop(e, c.id)}
            ondragend={() => (draggedRow = dropRow = null)}
          >
            <div class="td platform" role="cell">
              {#if rowsMovable}
                <span class="grip" title="Drag to reorder" aria-hidden="true">{@render icon("grip")}</span>
              {/if}
              <span class="avatar" style="background: hsl({hue(c.platform)}, 55%, 42%)" aria-hidden="true">
                {c.platform.trim().charAt(0).toUpperCase() || "?"}
              </span>
              <span class="platform-text">
                <span class="platform-name" title={c.platform}>{c.platform}</span>
                <span class="meta">
                  {#if showTrash}
                    <span class="chip warn">Deleted · {daysLeft(c)} {daysLeft(c) === 1 ? "day" : "days"} left</span>
                  {/if}
                  {#if c.space && (showTrash || !activeSpace)}
                    <span class="chip space-chip" title="Space">
                      <span class="dot" style="background: hsl({spaceHue(c.space)}, 60%, 55%)" aria-hidden="true"></span>{c.space}
                    </span>
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
              {:else if rowsMovable}
                {@render iconButton("up", `Move ${c.platform} up`, () => moveRow(c.id, -1), "", i === 0)}
                {@render iconButton("down", `Move ${c.platform} down`, () => moveRow(c.id, 1), "", i === list.length - 1)}
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
      defaultSpace={activeSpace}
      suggestions={options}
      {loadSecret}
      onsave={save}
      onclose={() => { dialog = null; editing = null; }}
    />
  {:else if dialog === "new-space"}
    <Modal title="New space" onclose={() => (dialog = null)}>
      <form class="space-form" onsubmit={createSpace} novalidate>
        <p class="muted small">
          Spaces split your logins into tabs, such as Personal, Dev team or
          Organisation. Each login can be in one space; All lists every login.
        </p>
        <input
          bind:value={spaceName}
          oninput={() => (spaceFormError = "")}
          maxlength={SPACE_NAME_MAX}
          placeholder="Dev team"
          aria-label="Space name"
          autocomplete="off"
          {@attach focusOnMount}
        />
        {#if spaceFormError}<span class="field-error" role="alert">{spaceFormError}</span>{/if}
        <div class="modal-actions">
          <button type="button" onclick={() => (dialog = null)}>Cancel</button>
          <button class="primary" type="submit">Create space</button>
        </div>
      </form>
    </Modal>
  {:else if dialog === "spaces"}
    <Modal title="Manage spaces" onclose={() => (dialog = null)}>
      <ul class="space-list">
        {#each spaces as s, i (s)}
          {@const total = spaceTotals.get(s) ?? 0}
          <li>
            {#if renaming === s}
              <form class="space-row" onsubmit={commitRename} novalidate>
                <span class="dot" style="background: hsl({spaceHue(s)}, 60%, 55%)" aria-hidden="true"></span>
                <input
                  bind:value={renameText}
                  oninput={() => (spaceFormError = "")}
                  maxlength={SPACE_NAME_MAX}
                  aria-label="New name for {s}"
                  autocomplete="off"
                  {@attach focusOnMount}
                />
                <button class="primary" type="submit" disabled={spaceBusy}>Save</button>
                <button type="button" onclick={() => (renaming = null)}>Cancel</button>
              </form>
              {#if spaceFormError}
                <span class="field-error" role="alert">{spaceFormError}</span>
              {:else if renameMerges}
                <span class="space-note">“{renameTarget}” already exists — its logins and these will be one space.</span>
              {/if}
            {:else if removing === s}
              <div class="space-row">
                <span class="space-confirm">
                  Remove “{s}”?
                  {total
                    ? `${total === 1 ? "Its login stays" : `Its ${total} logins stay`} saved and show under All only.`
                    : "It has no logins."}
                </span>
                <button class="danger-solid" onclick={() => removeSpace(s)} disabled={spaceBusy}>Remove</button>
                <button onclick={() => (removing = null)}>Cancel</button>
              </div>
            {:else}
              <div class="space-row">
                <span class="dot" style="background: hsl({spaceHue(s)}, 60%, 55%)" aria-hidden="true"></span>
                <span class="space-label">{s}</span>
                <span class="muted small">{total} {total === 1 ? "login" : "logins"}</span>
                {@render iconButton("up", `Move ${s} up`, () => moveBy(s, -1), "", i === 0)}
                {@render iconButton("down", `Move ${s} down`, () => moveBy(s, 1), "", i === spaces.length - 1)}
                <button class="ghost" onclick={() => startRename(s)}>Rename</button>
                <button class="ghost danger" onclick={() => { renaming = null; removing = s; }}>Remove</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="muted small">
        Drag the tabs, or use the arrows here, to change their order. Removing
        a space never deletes logins. Spaces travel with your encrypted backups.
      </p>
    </Modal>
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

  /* ---- spaces ---- */
  .spaces {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .space-tabs {
    display: flex;
    gap: 2px;
    min-width: 0;
    /* Many spaces scroll sideways; never a vertical scrollbar. */
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }
  @media (pointer: coarse) {
    /* Touch screens swipe the strip; a scrollbar would only add a grey bar. */
    .space-tabs {
      scrollbar-width: none;
    }
  }
  .space-tab {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: none;
    padding: 8px 12px;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }
  .space-tab:hover {
    color: var(--text);
  }
  .space-tab.on {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--accent);
  }
  .space-tab.dragging {
    opacity: 0.45;
  }
  .space-tab.drop-target {
    background: var(--accent-soft);
    border-radius: 8px 8px 0 0;
  }
  .space-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .space-name {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    font-size: 11px;
    font-weight: 600;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-muted);
  }
  .space-tab.on .count {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .dot {
    flex: none;
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
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
  .all-switch {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    color: var(--text-muted);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
  }
  .all-switch input {
    appearance: none;
    position: relative;
    flex: none;
    width: 28px;
    height: 16px;
    margin: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-muted) 45%, transparent);
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .all-switch input::before {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
  }
  .all-switch input:checked {
    background: var(--accent);
  }
  .all-switch input:checked::before {
    transform: translateX(12px);
  }
  .all-switch input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .chip.space-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--surface-2);
    color: var(--text);
  }
  .space-chip .dot {
    width: 6px;
    height: 6px;
  }
  .space-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .space-form p {
    margin: 0;
  }
  .space-form input,
  .space-row input {
    font-family: inherit;
    font-size: 13px;
    padding: 8px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    min-width: 0;
  }
  .space-list {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .space-list li {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
  }
  .space-list li:first-child {
    border-top: none;
  }
  .space-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
  }
  .space-row input {
    flex: 1;
  }
  .space-row button {
    font-size: 12px;
    padding: 5px 10px;
    border-radius: 7px;
  }
  .space-label {
    flex: 1;
    font-weight: 600;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .space-confirm {
    flex: 1;
    font-size: 12.5px;
  }
  .space-note {
    font-size: 12px;
    color: var(--text-muted);
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
  .tr.movable {
    cursor: grab;
  }
  .tr.dragging {
    opacity: 0.45;
  }
  .tr.drop-row {
    box-shadow: inset 0 2px 0 var(--accent);
    background: var(--accent-soft);
  }
  .grip {
    flex: none;
    display: inline-grid;
    place-items: center;
    color: var(--text-muted);
    margin-right: -4px;
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
