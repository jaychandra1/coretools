<script lang="ts">
  import { copySecret } from "../../secure-clipboard";
  import type { StoredEntry } from "../../core/authenticator/db";
  import { generateCode, groupCode, secondsRemaining } from "../../core/authenticator/otp";
  import { authStore } from "./store.svelte";

  let {
    entry,
    editMode,
    oncopied,
    onrename,
    ondelete,
    ondragstartcard,
    ondropcard,
  }: {
    entry: StoredEntry;
    editMode: boolean;
    oncopied: (code: string) => void;
    onrename: (entry: StoredEntry) => void;
    ondelete: (entry: StoredEntry) => void;
    ondragstartcard: (id: string) => void;
    ondropcard: (id: string) => void;
  } = $props();

  const isTimed = $derived(entry.type !== "hotp");
  const period = $derived(entry.type === "totp" ? entry.period : 30);

  /** Changes exactly when a new code is due (period boundary / counter bump). */
  const step = $derived(
    isTimed ? Math.floor(authStore.now / (period * 1000)) : entry.counter,
  );

  let code = $state("");
  let generationError = $state(false);

  $effect(() => {
    void step; // re-run on every new period or counter change
    const secret = authStore.secretOf(entry.id);
    if (!secret) return;
    const params = {
      type: entry.type,
      secret,
      algorithm: entry.algorithm,
      digits: entry.digits,
      period,
      counter: entry.counter,
    };
    generateCode(params, authStore.now)
      .then((c) => {
        code = c;
        generationError = false;
      })
      .catch(() => {
        generationError = true;
      });
  });

  const remaining = $derived(secondsRemaining(authStore.now, period));
  const RING_CIRCUMFERENCE = 2 * Math.PI * 15.5;
  const ringOffset = $derived(
    RING_CIRCUMFERENCE * (1 - remaining / period),
  );

  const displayCode = $derived(
    authStore.settings.groupCodes ? groupCode(code) : code,
  );

  const monogram = $derived(
    (entry.issuer || entry.account || "?").trim().charAt(0).toUpperCase(),
  );
  const hue = $derived.by(() => {
    const name = entry.issuer || entry.account;
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % 360;
  });

  async function copy() {
    if (!code) return;
    // Kept out of clipboard history / cloud sync on the desktop (F-07).
    await copySecret(code);
    oncopied(code);
  }

  let dragOver = $state(false);

  function handleDragStart(event: DragEvent) {
    if (event.dataTransfer) {
      // Some engines refuse to start a drag without data.
      event.dataTransfer.setData("text/plain", entry.id);
      event.dataTransfer.effectAllowed = "move";
    }
    ondragstartcard(entry.id);
  }
  function handleDragOver(event: DragEvent) {
    if (!editMode) return;
    event.preventDefault(); // required for the drop event to fire
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dragOver = true;
  }
  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragOver = false;
    ondropcard(entry.id);
  }
</script>

<div
  class="card"
  class:drag-over={dragOver}
  draggable={editMode}
  role="listitem"
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondragleave={() => (dragOver = false)}
  ondragend={() => (dragOver = false)}
  ondrop={handleDrop}
>
  {#if editMode}
    <span class="drag-handle" title="Drag to reorder" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
        <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
        <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
      </svg>
    </span>
  {/if}

  <span class="avatar" style="background: hsl({hue}, 55%, 42%)" aria-hidden="true">
    {monogram}
  </span>

  <div class="info">
    <div class="issuer">
      {entry.issuer || entry.account || "Unnamed"}
      {#if entry.pinned}
        <svg class="pin" viewBox="0 0 24 24" width="11" height="11" fill="var(--accent)" aria-label="Pinned">
          <path d="M12 2l2.4 6.2 6.6.4-5.1 4.2 1.7 6.4L12 15.6l-5.6 3.6 1.7-6.4L3 8.6l6.6-.4z" />
        </svg>
      {/if}
    </div>
    {#if entry.issuer && entry.account}
      <div class="account muted">{entry.account}</div>
    {/if}
  </div>

  {#if editMode}
    <div class="edit-actions">
      <button
        class="icon-btn"
        title={entry.pinned ? "Unpin" : "Pin to top"}
        aria-label={entry.pinned ? "Unpin" : "Pin to top"}
        onclick={() => authStore.togglePin(entry.id)}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill={entry.pinned ? "var(--accent)" : "none"} stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M12 2l2.4 6.2 6.6.4-5.1 4.2 1.7 6.4L12 15.6l-5.6 3.6 1.7-6.4L3 8.6l6.6-.4z" />
        </svg>
      </button>
      <button class="icon-btn" title="Rename" aria-label="Rename" onclick={() => onrename(entry)}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
        </svg>
      </button>
      <button class="icon-btn danger" title="Delete" aria-label="Delete" onclick={() => ondelete(entry)}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </svg>
      </button>
    </div>
  {:else}
    <button
      class="code"
      class:error={generationError}
      onclick={copy}
      title="Click to copy"
      aria-label="Copy code {code}"
    >
      {generationError ? "error" : displayCode || "······"}
    </button>

    {#if entry.type === "hotp"}
      <div class="hotp">
        <span class="counter muted" title="HOTP counter">#{entry.counter}</span>
        <button
          class="icon-btn"
          title="Next code (increments counter)"
          aria-label="Generate next code"
          onclick={() => authStore.incrementCounter(entry.id)}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
          </svg>
        </button>
      </div>
    {:else}
      <svg class="ring" viewBox="0 0 36 36" width="34" height="34" role="timer" aria-label="{Math.ceil(remaining)} seconds remaining">
        <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--border)" stroke-width="3" />
        <circle
          cx="18"
          cy="18"
          r="15.5"
          fill="none"
          stroke={remaining < 6 ? "var(--danger)" : "var(--accent)"}
          stroke-width="3"
          stroke-linecap="round"
          stroke-dasharray={RING_CIRCUMFERENCE}
          stroke-dashoffset={ringOffset}
          transform="rotate(-90 18 18)"
        />
        <text x="18" y="22" text-anchor="middle" font-size="11" fill="var(--text-muted)">
          {Math.ceil(remaining)}
        </text>
      </svg>
    {/if}
  {/if}
</div>

<style>
  .card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .card.drag-over {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .card[draggable="true"] {
    cursor: grab;
  }
  .drag-handle {
    color: var(--text-muted);
    display: inline-grid;
    place-items: center;
  }
  .avatar {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    color: #fff;
    font-weight: 700;
    font-size: 16px;
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .issuer {
    font-weight: 600;
    font-size: 13.5px;
    display: flex;
    align-items: center;
    gap: 5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .account {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .code {
    font-family: var(--mono);
    font-size: 22px;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--accent);
    background: transparent;
    border: none;
    padding: 4px 8px;
    border-radius: 6px;
    white-space: nowrap;
  }
  .code:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .code.error {
    color: var(--danger);
    font-size: 14px;
  }
  .ring {
    flex: none;
  }
  .ring circle {
    transition: stroke-dashoffset 0.4s linear;
  }
  .hotp {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .counter {
    font-family: var(--mono);
    font-size: 12px;
  }
  .icon-btn {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 6px;
    color: var(--text-muted);
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--text);
  }
  .icon-btn.danger:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
  }
  .edit-actions {
    display: flex;
    gap: 4px;
  }
  @media (max-width: 560px) {
    .code {
      font-size: 18px;
    }
    .avatar {
      width: 30px;
      height: 30px;
      font-size: 13px;
    }
  }
</style>
