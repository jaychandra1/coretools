<script lang="ts">
  import { authStore } from "../authenticator/store.svelte";
  import { displayUrl } from "../../core/credentials/url";
  import { TRASH_RETENTION_MS, type StoredCredential } from "../../core/credentials/types";
  import { nameHue } from "../../core/hue";
  import { Sortable } from "../../sortable.svelte";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";
  import SpaceDot from "./SpaceDot.svelte";

  /**
   * The logins (or the trash) as a table; rows become cards on narrow
   * screens. Passwords show only while revealed (`revealed`, by id). In
   * reorder mode (`movable`) rows drag by the handle or move with the arrows.
   */
  let {
    rows,
    trash,
    showSpace,
    revealed,
    movable,
    onmove,
    onstep,
    onreveal,
    oncopypassword,
    oncopy,
    onopen,
    onedit,
    onremove,
    onrestore,
    onpurge,
  }: {
    rows: StoredCredential[];
    /** Showing the trash: restore and delete-permanently actions. */
    trash: boolean;
    /** Show each login's space chip (on All and in the trash). */
    showSpace: boolean;
    revealed: Record<string, string>;
    movable: boolean;
    /** `dragged` was dropped onto `target`. */
    onmove: (dragged: string, target: string) => void;
    /** Swap with the row above (-1) or below (+1). */
    onstep: (id: string, delta: number) => void;
    onreveal: (c: StoredCredential) => void;
    oncopypassword: (c: StoredCredential) => void;
    /** Copy a non-secret field. */
    oncopy: (text: string, what: string) => void;
    onopen: (url: string) => void;
    onedit: (c: StoredCredential) => void;
    onremove: (c: StoredCredential) => void;
    onrestore: (c: StoredCredential) => void;
    onpurge: (c: StoredCredential) => void;
  } = $props();

  const sortable = new Sortable<string>((dragged, target) => onmove(dragged, target));

  function daysLeft(c: StoredCredential): number {
    // Exact clock: a minute-floored one would read "31 days" right after deleting.
    return Math.max(0, Math.ceil(((c.deletedAt ?? 0) + TRASH_RETENTION_MS - authStore.now) / 86_400_000));
  }
</script>

<div class="table" role="table" aria-label={trash ? "Deleted credentials" : "Saved credentials"}>
  <div class="tr thead" role="row">
    <span role="columnheader">Platform</span>
    <span role="columnheader">Login URL</span>
    <span role="columnheader">Username</span>
    <span role="columnheader">Password</span>
    <span role="columnheader" class="actions-head">Actions</span>
  </div>
  {#each rows as c, i (c.id)}
    {@const shown = revealed[c.id] !== undefined}
    <div
      class="tr"
      role="row"
      tabindex="-1"
      class:movable
      class:dragging={sortable.dragged === c.id}
      class:drop-row={sortable.over === c.id}
      {@attach sortable.item(c.id, movable)}
    >
      <div class="td platform" role="cell">
        {#if movable}
          <span class="grip" title="Drag to reorder" aria-hidden="true"><Icon name="grip" /></span>
        {/if}
        <span class="avatar" style="background: hsl({nameHue(c.platform)}, 55%, 42%)" aria-hidden="true">
          {c.platform.trim().charAt(0).toUpperCase() || "?"}
        </span>
        <span class="platform-text">
          <span class="platform-name" title={c.platform}>{c.platform}</span>
          <span class="meta">
            {#if trash}
              <span class="chip warn">Deleted · {daysLeft(c)} {daysLeft(c) === 1 ? "day" : "days"} left</span>
            {/if}
            {#if c.space && showSpace}
              <span class="chip space-chip" title="Space"><SpaceDot name={c.space} size={6} />{c.space}</span>
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
        {#if shown}
          <span class="secret revealed" title="Hides automatically in 20 seconds">{revealed[c.id] || "(empty)"}</span>
        {:else}
          <span class="secret">••••••••••</span>
        {/if}
      </div>
      <div class="td actions" role="cell">
        {#if trash}
          <IconButton icon="restore" tip="Restore" onclick={() => onrestore(c)} />
          <IconButton icon="trash" tip="Delete permanently" onclick={() => onpurge(c)} danger />
        {:else if movable}
          <IconButton icon="up" tip="Move {c.platform} up" onclick={() => onstep(c.id, -1)} disabled={i === 0} />
          <IconButton icon="down" tip="Move {c.platform} down" onclick={() => onstep(c.id, 1)} disabled={i === rows.length - 1} />
        {:else}
          <IconButton icon={shown ? "eye-off" : "eye"} tip={shown ? "Hide password" : "Show password"} onclick={() => onreveal(c)} />
          <IconButton icon="user" tip="Copy username" onclick={() => oncopy(c.username, "Username")} disabled={!c.username} />
          <IconButton icon="key" tip="Copy password" onclick={() => oncopypassword(c)} />
          <IconButton icon="link" tip="Copy login URL" onclick={() => oncopy(c.url, "URL")} disabled={!c.url} />
          <IconButton icon="open" tip="Open login page" onclick={() => onopen(c.url)} disabled={!c.url} />
          <span class="sep" aria-hidden="true"></span>
          <IconButton icon="edit" tip="Edit" onclick={() => onedit(c)} />
          <IconButton icon="trash" tip="Move to trash" onclick={() => onremove(c)} danger />
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
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

  /* ---- your own order ---- */
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
  .chip.space-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--surface-2);
    color: var(--text);
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
  }
</style>
