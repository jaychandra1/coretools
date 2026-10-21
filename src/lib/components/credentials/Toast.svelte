<script lang="ts" module>
  export interface ToastMessage {
    text: string;
    tone: "ok" | "bad";
    /** Offers an Undo button. */
    undo?: () => void;
  }
</script>

<script lang="ts">
  let { toast }: { toast: ToastMessage } = $props();
</script>

<div class="toast tone-{toast.tone}" role="status">
  <span>{toast.text}</span>
  {#if toast.undo}<button class="undo" onclick={toast.undo}>Undo</button>{/if}
</div>

<style>
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
</style>
