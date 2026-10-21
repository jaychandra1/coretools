<script lang="ts">
  import Icon, { type IconName } from "./Icon.svelte";

  let {
    icon,
    tip,
    onclick,
    danger = false,
    outlined = false,
    disabled = false,
  }: {
    icon: IconName;
    /** Tooltip and accessible name. */
    tip: string;
    onclick: () => void;
    danger?: boolean;
    /** Bordered at rest (header actions), not only on hover. */
    outlined?: boolean;
    disabled?: boolean;
  } = $props();
</script>

<button class="icon-btn" class:danger class:outlined {onclick} data-tip={tip} aria-label={tip} {disabled}>
  <Icon name={icon} />
</button>

<style>
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
  .icon-btn.outlined {
    border-color: var(--border);
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

  /* Hover tooltip. */
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
</style>
