<script lang="ts">
  import { assessPassword } from "../../core/authenticator/password-strength";

  /**
   * Live strength meter for a new master password (audit F-06). Shows the
   * policy's verdict; the store enforces the same rule on save.
   */
  let { password }: { password: string } = $props();

  const result = $derived(assessPassword(password));
  const labels = ["Very weak", "Weak", "Fair", "Good", "Strong"];
</script>

{#if password}
  <div class="strength" data-score={result.score} aria-live="polite">
    <div class="bars" aria-hidden="true">
      {#each [0, 1, 2, 3] as i (i)}
        <span class:on={result.score > i}></span>
      {/each}
    </div>
    <span class="label">{labels[result.score]}</span>
    {#if result.message}<span class="hint">{result.message}</span>{/if}
  </div>
{/if}

<style>
  .strength {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    font-size: 11.5px;
  }
  .bars {
    display: flex;
    gap: 3px;
  }
  .bars span {
    width: 26px;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
  }
  .strength[data-score="0"] .on,
  .strength[data-score="1"] .on {
    background: var(--danger);
  }
  .strength[data-score="2"] .on {
    background: #d69e2e;
  }
  .strength[data-score="3"] .on,
  .strength[data-score="4"] .on {
    background: var(--added-fg);
  }
  .label {
    font-weight: 600;
  }
  .hint {
    flex-basis: 100%;
    color: var(--text-muted);
  }
</style>
