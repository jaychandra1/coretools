<script lang="ts">
  import Modal from "./authenticator/Modal.svelte";
  import { updates } from "../updates.svelte";
  import { authStore } from "./authenticator/store.svelte";
  import { cloudBackup } from "./authenticator/cloud.svelte";
  import { describeKdf, LEGACY_PBKDF2_ITERATIONS } from "../core/authenticator/kdf";
  import { copyText } from "../secure-clipboard";
  import { getPlatform } from "../platform";
  import { sessionFailures } from "../diagnostics";

  let { onclose }: { onclose: () => void } = $props();

  const platform = getPlatform();
  let copied = $state("");

  function when(ms: number | null): string {
    return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";
  }

  /**
   * A support report (audit F-16): versions, states and recent error causes.
   * Never names, secrets, URLs or account details.
   */
  async function copyDiagnostics() {
    const vault = authStore.vault;
    const kdf = vault?.kdf
      ? describeKdf(vault.kdf)
      : vault?.encrypted
        ? `${describeKdf({ name: "PBKDF2-SHA256", iterations: vault.iterations ?? LEGACY_PBKDF2_ITERATIONS })} (upgrades at next password unlock)`
        : "none";
    // The desktop keeps a log file; the browser build only this session's record.
    const log =
      (platform.diagnostics
        ? await platform.diagnostics.report().catch(() => sessionFailures())
        : sessionFailures()) || "(empty)";
    const report = [
      `CoreTools ${__APP_VERSION__} · ${platform.kind === "tauri" ? (platform.storeInstall ? "desktop (Microsoft Store)" : "desktop") : "browser"}`,
      `User agent: ${navigator.userAgent}`,
      `Vault: ${vault?.encrypted ? "encrypted" : vault ? "not encrypted" : "not set up"} · KDF ${kdf} · ${authStore.locked ? "locked" : "unlocked"} · Hello ${authStore.helloEnabled ? "on" : "off"}`,
      `Accounts: ${authStore.entries.length}`,
      `Cloud backup: ${cloudBackup.connected ? "connected" : "not connected"} · status ${cloudBackup.statusOf()} · auto ${cloudBackup.config?.autoBackup ? "on" : "off"}`,
      `Update check: ${updates.pref ?? "not asked"} · last ${when(updates.lastCheckedAt)}`,
      "",
      "Recent errors (causes only):",
      log,
    ].join("\n");
    await copyText(report);
    copied = "Copied. Paste it into your support request — it contains no names, secrets or account details.";
  }
</script>

<Modal title="About CoreTools" {onclose}>
  <section>
    <p class="version">
      <strong>CoreTools {__APP_VERSION__}</strong>
      <span class="muted">· {platform.kind === "tauri" ? "Desktop app" : "Browser preview"}</span>
    </p>
  </section>

  {#if updates.supported}
    <section>
      <h3>Updates</h3>
      {#if updates.available}
        <div class="callout" class:security={updates.available.security}>
          <strong>
            {updates.available.security ? "Security update" : "Update available"}:
            CoreTools {updates.available.version}
          </strong>
          {#if updates.available.notice}<p>{updates.available.notice}</p>{/if}
          {#if updates.installing}
            <p role="status">
              {updates.installing.phase === "installing"
                ? "Installing — CoreTools restarts when it's done."
                : `Downloading…${updates.installing.percent === null ? "" : ` ${updates.installing.percent}%`}`}
            </p>
          {:else}
            {#if updates.installError}<p role="alert">{updates.installError}</p>{/if}
            <button class="primary" onclick={() => updates.update()}>Update now</button>
            <button onclick={() => updates.download()}>Download installer</button>
            <button onclick={() => updates.openRelease()}>What's new</button>
          {/if}
        </div>
      {/if}
      <label class="inline">
        <input
          type="checkbox"
          checked={updates.pref === "on"}
          onchange={(e) => updates.setPref(e.currentTarget.checked ? "on" : "off")}
        />
        Check for new versions about once an hour
      </label>
      <p class="muted small">
        Reads one public file from the CoreTools release page. Nothing about
        you or your data is sent, and nothing is installed without you.
      </p>
      <div class="row">
        <button onclick={() => updates.check(true)} disabled={updates.checking}>
          {updates.checking ? "Checking…" : "Check now"}
        </button>
        <span class="muted small">Last checked: {when(updates.lastCheckedAt)}</span>
      </div>
      {#if updates.message}<p class="small" role="status">{updates.message}</p>{/if}
    </section>
  {:else if platform.storeInstall}
    <section>
      <h3>Updates</h3>
      <p class="muted small">This copy comes from the Microsoft Store, which keeps it up to date.</p>
    </section>
  {/if}

  <section>
    <h3>Report a problem</h3>
    <p class="muted small">
      Copy a diagnostics report and email it to
      <strong>coretools.works@gmail.com</strong>: versions, settings states and
      recent error causes — never your accounts, logins or any secret.
      CoreTools sends nothing by itself.
    </p>
    <div class="row">
      <button onclick={copyDiagnostics}>Copy diagnostics</button>
      <button onclick={() => copyText("coretools.works@gmail.com").then(() => (copied = "Email address copied."))}>
        Copy email address
      </button>
    </div>
    {#if copied}<p class="small" role="status">{copied}</p>{/if}
  </section>
</Modal>

<style>
  section + section {
    margin-top: 16px;
  }
  .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 13px;
  }
  p {
    margin: 0 0 8px;
    font-size: 12.5px;
  }
  .small {
    font-size: 12px;
  }
  .version {
    font-size: 13.5px;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    margin-bottom: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 6px 0;
  }
  .callout {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
    padding: 10px 12px;
    margin-bottom: 10px;
    border-radius: 9px;
    background: var(--accent-soft);
    font-size: 12.5px;
  }
  .callout.security {
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
</style>
