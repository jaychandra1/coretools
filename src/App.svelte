<script lang="ts">
  import DiffChecker from "./lib/components/DiffChecker.svelte";
  import YamlOptimizer from "./lib/components/YamlOptimizer.svelte";
  import SentencePolisher from "./lib/components/SentencePolisher.svelte";
  import Authenticator from "./lib/components/authenticator/Authenticator.svelte";
  import JsonStudio from "./lib/components/json-studio/JsonStudio.svelte";
  import { getPlatform } from "./lib/platform";

  type Tab = "diff" | "yaml" | "polish" | "authenticator" | "json";
  let tab = $state<Tab>("diff");

  const platform = getPlatform();

  // Theme toggle. Initial value follows the OS preference; kept in memory
  // only (never persisted) in line with the no-storage privacy model.
  type Theme = "light" | "dark";
  let theme = $state<Theme>(
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });

  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
  }
</script>

<div class="shell">
  <!-- One bar: tool tabs on the left, status + theme on the right. The app
       name lives in the window title, so it doesn't take a row here. -->
  <header>
    <nav class="tabs" aria-label="Tools">
      <button class:active={tab === "diff"} onclick={() => (tab = "diff")}>
        Diff-Checker
      </button>
      <button class:active={tab === "yaml"} onclick={() => (tab = "yaml")}>
        YML-Validator
      </button>
      <button class:active={tab === "polish"} onclick={() => (tab = "polish")}>
        Grammar-Polisher
      </button>
      <button
        class:active={tab === "authenticator"}
        onclick={() => (tab = "authenticator")}
      >
        Authenticator
      </button>
      <button class:active={tab === "json"} onclick={() => (tab = "json")}>
        JSON-Studio
      </button>
    </nav>
    <div class="header-right">
      <span class="mode muted" title="Everything runs locally. No network access.">
        ● Offline · {platform.kind === "tauri" ? "Desktop" : "Preview"} ·
        v{__APP_VERSION__}
      </span>
      <button
        class="theme-toggle"
        onclick={toggleTheme}
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {#if theme === "dark"}
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        {/if}
      </button>
    </div>
  </header>

  <main>
    {#key tab}
      <div class="tab-panel">
        {#if tab === "diff"}
          <DiffChecker />
        {:else if tab === "yaml"}
          <YamlOptimizer />
        {:else if tab === "polish"}
          <SentencePolisher />
        {:else if tab === "authenticator"}
          <Authenticator />
        {:else}
          <JsonStudio />
        {/if}
      </div>
    {/key}
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
    gap: 16px;
    /* 10px + the tab's 14px padding = the first label lines up with the
       24px content gutter below. */
    padding: 6px 24px 0 10px;
    border-bottom: 1px solid var(--border);
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    padding-bottom: 6px;
  }
  .mode {
    font-size: 12px;
    white-space: nowrap;
  }
  .theme-toggle {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 50%;
    color: var(--text-muted);
  }
  .theme-toggle:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .tabs {
    display: flex;
    align-self: stretch;
    align-items: flex-end;
    gap: 4px;
    min-width: 0;
    /* Narrow windows: tabs scroll sideways instead of pushing the status
       off the bar. */
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tabs button {
    flex-shrink: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 12px 14px;
    font-weight: 500;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .tabs button:hover {
    background: transparent;
    color: var(--text);
  }
  .tabs button.active {
    color: var(--accent);
    /* Inset underline: a negative margin would be clipped by the scroller. */
    box-shadow: inset 0 -2px 0 var(--accent);
    font-weight: 600;
  }
  main {
    flex: 1;
    overflow: auto;
    padding: 20px 24px 32px;
  }
  .tab-panel {
    animation: panel-in 0.25s ease;
  }
  @keyframes panel-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tab-panel {
      animation: none;
    }
  }
</style>
