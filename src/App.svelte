<script lang="ts">
  import DiffChecker from "./lib/components/DiffChecker.svelte";
  import YamlOptimizer from "./lib/components/YamlOptimizer.svelte";
  import { getPlatform } from "./lib/platform";

  type Tab = "diff" | "yaml";
  let tab = $state<Tab>("diff");

  const platform = getPlatform();
</script>

<div class="shell">
  <header>
    <div class="brand">
      <span class="logo" aria-hidden="true">◧</span>
      <div>
        <h1>CoreTools</h1>
        <p class="tagline muted">Offline file diff &amp; Kubernetes YAML optimizer</p>
      </div>
    </div>
    <span class="mode muted" title="Everything runs locally. No network access.">
      ● Offline · {platform.kind === "tauri" ? "Desktop" : "Preview"}
    </span>
  </header>

  <nav class="tabs">
    <button class:active={tab === "diff"} onclick={() => (tab = "diff")}>
      File Difference Checker
    </button>
    <button class:active={tab === "yaml"} onclick={() => (tab = "yaml")}>
      Kubernetes YAML Optimizer
    </button>
  </nav>

  <main>
    {#if tab === "diff"}
      <DiffChecker />
    {:else}
      <YamlOptimizer />
    {/if}
  </main>
</div>

<style>
  .shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
    max-width: 1180px;
    margin: 0 auto;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px 12px;
    gap: 16px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .logo {
    font-size: 26px;
    color: var(--accent);
    line-height: 1;
  }
  h1 {
    font-size: 18px;
    margin: 0;
    letter-spacing: -0.01em;
  }
  .tagline {
    margin: 0;
    font-size: 12.5px;
  }
  .mode {
    font-size: 12px;
    white-space: nowrap;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 10px 14px;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tabs button:hover {
    background: transparent;
    color: var(--text);
  }
  .tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  main {
    flex: 1;
    overflow: auto;
    padding: 20px 24px 32px;
  }
</style>
