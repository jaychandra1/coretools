<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    onclose,
    wide = false,
    children,
  }: {
    title: string;
    onclose: () => void;
    wide?: boolean;
    children: Snippet;
  } = $props();

  function onBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) onclose();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="backdrop"
  onclick={onBackdropClick}
  role="presentation"
>
  <div class="modal" class:wide role="dialog" aria-modal="true" aria-label={title}>
    <header>
      <h2>{title}</h2>
      <button class="close" onclick={onclose} aria-label="Close dialog">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>
    <div class="body">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(10, 12, 16, 0.55);
    display: grid;
    place-items: center;
    z-index: 40;
    padding: 20px;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: min(460px, 100%);
    max-height: min(85vh, 720px);
    display: flex;
    flex-direction: column;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
    animation: modal-in 0.16s ease;
  }
  .modal.wide {
    width: min(680px, 100%);
  }
  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .modal {
      animation: none;
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-size: 15px;
    letter-spacing: -0.01em;
  }
  .close {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: 6px;
    color: var(--text-muted);
  }
  .body {
    padding: 16px 18px 18px;
    overflow-y: auto;
  }
</style>
