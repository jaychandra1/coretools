<script lang="ts">
  import DiffChecker from "./lib/components/DiffChecker.svelte";
  import YamlOptimizer from "./lib/components/YamlOptimizer.svelte";
  import SentencePolisher from "./lib/components/SentencePolisher.svelte";
  import Authenticator from "./lib/components/authenticator/Authenticator.svelte";
  import JsonStudio from "./lib/components/json-studio/JsonStudio.svelte";
  import { cloudBackup } from "./lib/components/authenticator/cloud.svelte";
  import { getPlatform } from "./lib/platform";

  type Tab = "diff" | "yaml" | "polish" | "authenticator" | "json";
  let tab = $state<Tab>("diff");

  const platform = getPlatform();

  // Connectivity badge — must tell the truth per section. Every tool is
  // offline except the Authenticator once Google Drive backup is connected;
  // and while a backup/sign-in is actually running (debounced backups can
  // finish after the user switched tabs) it reads "Online" wherever you are.
  // The badge only observes: it never starts cloud activity itself.
  const connectivity = $derived.by(() => {
    if (cloudBackup.activity) {
      return {
        online: true,
        label: "Online · Syncing…",
        title: "Talking to Google Drive for Authenticator backup (end-to-end encrypted). Other tools stay offline.",
      };
    }
    if (tab === "authenticator" && cloudBackup.connected) {
      return {
        online: true,
        label: "Online · Drive backup",
        title: "This section backs up to your Google Drive, end-to-end encrypted — Google can't read it. All other tools stay offline.",
      };
    }
    return {
      online: false,
      label: "Offline",
      title:
        tab === "authenticator" && cloudBackup.available
          ? "This section is offline. Connect Google Drive backup in Authenticator settings to back up (end-to-end encrypted)."
          : "Everything in this tool runs locally. No network access.",
    };
  });

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
      <span class="mode muted" title={connectivity.title}>
        <span class="dot" class:online={connectivity.online} aria-hidden="true">●</span>
        {connectivity.label} · {platform.kind === "tauri" ? "Desktop" : "Preview"} ·
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
  .dot.online {
    color: var(--added-fg);
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
  .tabs button {
    position: relative;
  }
  .tabs button.active {
    color: var(--accent);
    font-weight: 600;
  }
  /* Underline drawn inside the button box: a negative margin would be
     clipped by the scroller, and an inset box-shadow leaves faint vertical
     edge lines in Chromium/WebView2. */
  .tabs button.active::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: var(--accent);
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
