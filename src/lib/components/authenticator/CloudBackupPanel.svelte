<script lang="ts">
  import { authStore } from "./store.svelte";
  import { cloudBackup, type CloudNotice } from "./cloud.svelte";
  import {
    BACKUP_KIND_LABELS,
    ofKind,
    type BackupKind,
  } from "../../core/authenticator/cloud-sync";

  let {
    scope,
    onrestore,
  }: {
    /**
     * The section showing the panel. Each module backs up separately, so the
     * panel shows and acts on that module's backups only; the Google
     * connection itself is shared.
     */
    scope: BackupKind;
    /** Open the restore dialog, optionally preselecting a version. */
    onrestore: (preselectId?: string) => void;
  } = $props();

  const busy = $derived(cloudBackup.activity !== null);
  const label = $derived(BACKUP_KIND_LABELS[scope]);
  /** "accounts" / "saved logins", for sentences. */
  const things = $derived(scope === "authenticator" ? "accounts" : "saved logins");
  const status = $derived(cloudBackup.statusOf(scope));
  const conflict = $derived(cloudBackup.conflictOf(scope));
  const lastBackupAt = $derived(cloudBackup.lastBackupAtOf(scope));

  // Version count and size — fetched once quietly when the panel opens, then
  // kept current by backups.
  $effect(() => {
    if (cloudBackup.connected && cloudBackup.versions === null) {
      void cloudBackup.refreshVersions();
    }
  });

  // Success messages fade on their own; warnings and errors stay put.
  $effect(() => {
    const notice: CloudNotice | null = cloudBackup.notice;
    if (notice?.kind !== "success") return;
    const timer = setTimeout(() => {
      if (cloudBackup.notice === notice) cloudBackup.notice = null;
    }, 6000);
    return () => clearTimeout(timer);
  });

  // ---- formatting -------------------------------------------------------------

  /** "Just now" / "5 min ago" / "Today, 11:47" / "12 Oct, 09:30" — ticks with the shared clock. */
  function relative(ms: number | null | undefined): string {
    if (!ms) return "Never";
    const diff = authStore.now - ms;
    if (diff < 45_000) return "Just now";
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
    const date = new Date(ms);
    const time = date.toLocaleTimeString(undefined, { timeStyle: "short" });
    const today = new Date(authStore.now);
    if (date.toDateString() === today.toDateString()) return `Today, ${time}`;
    const yesterday = new Date(authStore.now - 86_400_000);
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
    return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
  }

  function absolute(ms: number | null | undefined): string {
    return ms
      ? new Date(ms).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })
      : "";
  }

  function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  /** This module's versions in Drive; null until known. */
  const versions = $derived(cloudBackup.versions ? ofKind(cloudBackup.versions, scope) : null);
  const versionCount = $derived(versions?.length ?? null);
  const totalSize = $derived(versions?.reduce((sum, v) => sum + (v.size || 0), 0) ?? 0);

  type Tone = "ok" | "busy" | "warn" | "bad";
  const pill = $derived.by((): { tone: Tone; label: string; detail: string } => {
    switch (status) {
      case "up-to-date":
        return {
          tone: "ok",
          label: "Up to date",
          detail: versionCount === 0 ? `Your ${things} back up after the first change.` : "Every change is backed up.",
        };
      case "working":
        return {
          tone: "busy",
          label:
            cloudBackup.activity === "backing-up"
              ? "Backing up"
              : cloudBackup.activity === "restoring"
                ? "Restoring"
                : cloudBackup.activity === "deleting"
                  ? "Deleting"
                  : "Syncing",
          detail: "Talking to Google Drive…",
        };
      case "pending":
        return {
          tone: "busy",
          label: "Pending",
          detail: authStore.locked
            ? "Changes back up after you unlock."
            : cloudBackup.config?.autoBackup
              ? "Changes are about to back up."
              : "Changes aren't backed up yet.",
        };
      case "retrying":
        return {
          tone: "warn",
          label: "Offline",
          detail: `Couldn't reach Google Drive — retrying at ${new Date(cloudBackup.retryAt ?? 0).toLocaleTimeString(undefined, { timeStyle: "short" })}.`,
        };
      case "conflict":
        return { tone: "warn", label: "Needs review", detail: "Another device made a newer backup." };
      case "needs-password":
        return { tone: "warn", label: "Paused", detail: "Set an encryption password to resume." };
      case "reconnect":
        return { tone: "bad", label: "Disconnected", detail: "Google access was lost." };
      case "error":
        return { tone: "bad", label: "Failed", detail: cloudBackup.lastError ?? "Backup failed." };
      default:
        return { tone: "warn", label: "", detail: "" };
    }
  });

  // ---- actions -----------------------------------------------------------------

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect your Google account? Automatic backups stop here and in the other vault section, which shares this connection. Backups already in Google Drive are kept until you delete them.",
      )
    ) {
      return;
    }
    await cloudBackup.disconnect();
  }

  async function deleteBackups() {
    if (
      !window.confirm(
        `Permanently delete ALL ${label} backups from your Google Drive? You won't be able to restore them on a new device. This cannot be undone.`,
      )
    ) {
      return;
    }
    await cloudBackup.deleteAllBackups(scope);
  }

  async function keepThisDevice() {
    const other = conflict?.deviceLabel || "the other device";
    if (
      !window.confirm(
        `Upload this device's ${things} as the newest backup? Changes made on ${other} that aren't here won't be in it (its backup stays available as an older version).`,
      )
    ) {
      return;
    }
    await cloudBackup.keepThisDevice(scope);
  }
</script>

{#snippet spinner()}
  <span class="spinner" aria-hidden="true"></span>
{/snippet}

{#snippet cloudIcon(size: number)}
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M17.5 19H8a5 5 0 1 1 1.6-9.74A6 6 0 0 1 21 12.5 4.5 4.5 0 0 1 17.5 19z" />
    <rect x="10" y="12.5" width="5" height="4" rx="0.8" />
    <path d="M11 12.5v-1.2a1.5 1.5 0 0 1 3 0v1.2" />
  </svg>
{/snippet}

{#snippet check()}
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m5 12 5 5 9-10" />
  </svg>
{/snippet}

<div class="panel">
  {#if !cloudBackup.configured}
    <div class="card muted-card">
      <div class="card-head">
        <span class="badge-icon">{@render cloudIcon(20)}</span>
        <div class="head-text">
          <span class="title">Google Drive backup</span>
          <span class="subtitle">Not available in this build</span>
        </div>
      </div>
      <p class="body-text">
        This build of CoreTools has no Google sign-in configured. Use
        <strong>Export</strong> for manual backups.
      </p>
    </div>
  {:else if !cloudBackup.connected}
    <!-- ---------------------------- not connected ---------------------------- -->
    <div class="card hero">
      <div class="card-head">
        <span class="badge-icon">{@render cloudIcon(22)}</span>
        <div class="head-text">
          <span class="title">Google Drive backup</span>
          <span class="subtitle">Never lose your {scope === "authenticator" ? "2FA accounts" : "saved logins"}</span>
        </div>
        <span class="pill tone-off">Off</span>
      </div>

      <ul class="benefits">
        <li>{@render check()}<span><strong>End-to-end encrypted</strong> with your password — Google can't read it</span></li>
        <li>{@render check()}<span><strong>Automatic</strong> after every change, with a year of versions to roll back to</span></li>
        <li>{@render check()}<span><strong>Restore anywhere</strong> — new device or reinstall, just sign in</span></li>
      </ul>

      {#if cloudBackup.needsReconnect && cloudBackup.config?.email}
        <div class="callout warn">
          Backups to <strong>{cloudBackup.config.email}</strong> stopped because
          Google access was lost. Reconnect to resume.
        </div>
      {/if}
      {#if !authStore.encrypted}
        <div class="callout warn">
          Set an encryption password above first — it encrypts your backups,
          and you'll need it to restore them.
        </div>
      {/if}

      <div class="actions">
        {#if cloudBackup.activity === "connecting"}
          <span class="waiting">{@render spinner()} Finish signing in in your browser…</span>
          <button class="ghost" onclick={() => cloudBackup.cancelSignIn()}>Cancel</button>
        {:else}
          <button
            class="primary"
            onclick={() => cloudBackup.connect(scope)}
            disabled={!authStore.encrypted || busy}
          >
            {cloudBackup.needsReconnect ? "Reconnect Google account" : "Connect Google Account"}
          </button>
          <button class="ghost" onclick={() => onrestore()} disabled={busy}>
            Restore from Google Drive…
          </button>
        {/if}
      </div>
    </div>
  {:else}
    <!-- ------------------------------ connected ------------------------------ -->
    <div class="card">
      <div class="card-head">
        <span class="badge-icon live">{@render cloudIcon(22)}</span>
        <div class="head-text">
          <span class="title">Google Drive backup</span>
          <span class="subtitle account" title={cloudBackup.account ?? ""}>{cloudBackup.account}</span>
        </div>
        <span class="pill tone-{pill.tone}" title={pill.detail}>
          {#if pill.tone === "busy"}{@render spinner()}{:else}<span class="dot"></span>{/if}
          {pill.label}
        </span>
      </div>

      <div class="stats">
        <div class="stat" title={absolute(lastBackupAt)}>
          <span class="stat-label">Last backup</span>
          <span class="stat-value">{relative(lastBackupAt)}</span>
        </div>
        <div
          class="stat"
          title="Kept: the newest 10, then one per hour for a day, one per day for a month and one per month for a year"
        >
          <span class="stat-label">Versions kept</span>
          <span class="stat-value">
            {versionCount === null ? "—" : versionCount}
          </span>
          {#if versionCount}<span class="stat-sub">{formatSize(totalSize)} total</span>{/if}
        </div>
        <div class="stat">
          <span class="stat-label">Encryption</span>
          <span class="stat-value">AES-256</span>
          <span class="stat-sub">End-to-end</span>
        </div>
      </div>

      <p class="status-line tone-text-{pill.tone}">{pill.detail}</p>

      {#if conflict}
        <div class="callout warn">
          <strong>{conflict.deviceLabel || "Another device"}</strong>
          backed up {relative(Date.parse(conflict.createdTime)).toLowerCase()}.
          Automatic backups from here are paused so its changes aren't buried.
          <div class="callout-actions">
            <button class="primary small" onclick={() => onrestore(conflict?.id)} disabled={busy}>
              Review &amp; merge…
            </button>
            <button class="ghost small" onclick={keepThisDevice} disabled={busy}>
              Keep this device's data
            </button>
          </div>
        </div>
      {/if}

      {#if status === "reconnect"}
        <div class="callout bad">
          Google access was revoked or expired.
          <div class="callout-actions">
            <button class="primary small" onclick={() => cloudBackup.connect(scope)} disabled={busy}>
              Reconnect Google account
            </button>
          </div>
        </div>
      {/if}

      <label class="switch-row">
        <span class="switch-text">
          <span class="switch-title">Automatic backup</span>
          <span class="switch-sub">Back up a few seconds after every change</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          class="switch"
          checked={cloudBackup.config?.autoBackup ?? true}
          onchange={(e) => cloudBackup.setAutoBackup(e.currentTarget.checked)}
        />
      </label>

      <div class="actions split">
        <div class="group">
          <button
            class="primary"
            onclick={() => cloudBackup.backupNow({ series: [scope] })}
            disabled={busy || !authStore.encrypted || cloudBackup.needsReconnect}
          >
            {#if cloudBackup.activity === "backing-up" && cloudBackup.backingUp === scope}{@render spinner()} Backing up…{:else}Back up now{/if}
          </button>
          <button class="ghost" onclick={() => onrestore()} disabled={busy}>Restore…</button>
        </div>
        <div class="group">
          <button class="ghost quiet" onclick={disconnect} disabled={busy}>Disconnect</button>
          <button
            class="ghost danger"
            onclick={deleteBackups}
            disabled={busy}
            title="Delete all {label} backups"
            aria-label="Delete all {label} backups"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if cloudBackup.notice}
    <div
      class="notice {cloudBackup.notice.kind}"
      role={cloudBackup.notice.kind === "error" ? "alert" : "status"}
    >
      {#if cloudBackup.notice.kind === "success"}{@render check()}{/if}
      <span>{cloudBackup.notice.text}</span>
      <button class="dismiss" aria-label="Dismiss" onclick={() => (cloudBackup.notice = null)}>✕</button>
    </div>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 12px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 70px),
      var(--surface);
    padding: 14px 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .muted-card {
    background: var(--surface);
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 11px;
    min-width: 0;
  }
  .badge-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .badge-icon.live {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .head-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .title {
    font-size: 14px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .subtitle {
    font-size: 12.5px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subtitle.account {
    color: var(--text);
    opacity: 0.85;
  }

  /* ---- status pill ---- */
  .pill {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 650;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .pill .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .tone-ok {
    color: var(--added-fg);
    background: var(--added-bg);
    border-color: color-mix(in srgb, var(--added-fg) 25%, transparent);
  }
  .tone-ok .dot {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--added-fg) 22%, transparent);
  }
  .tone-busy {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .tone-warn {
    color: #b7791f;
    background: color-mix(in srgb, #f6ad55 16%, transparent);
    border-color: color-mix(in srgb, #f6ad55 35%, transparent);
  }
  .tone-bad {
    color: var(--removed-fg);
    background: var(--removed-bg);
    border-color: color-mix(in srgb, var(--removed-fg) 25%, transparent);
  }
  .tone-off {
    color: var(--text-muted);
    background: var(--surface-2);
    border-color: var(--border);
  }

  /* ---- stats ---- */
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 11px;
    border-radius: 9px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    min-width: 0;
  }
  .stat-label {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    font-weight: 600;
  }
  .stat-value {
    font-size: 13.5px;
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stat-sub {
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .status-line {
    margin: -4px 0 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .tone-text-bad {
    color: var(--removed-fg);
  }
  .tone-text-warn {
    color: #b7791f;
  }
  /* Amber needs to be lighter to stay readable on the dark surfaces. */
  :global(:root[data-theme="dark"]) .tone-warn,
  :global(:root[data-theme="dark"]) .tone-text-warn {
    color: #f6c26b;
  }

  /* ---- switch ---- */
  .switch-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 2px 2px 0;
    cursor: pointer;
  }
  .switch-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .switch-title {
    font-size: 13px;
    font-weight: 600;
  }
  .switch-sub {
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .switch {
    appearance: none;
    flex: none;
    width: 36px;
    height: 20px;
    margin: 0;
    border-radius: 999px;
    background: var(--border);
    position: relative;
    cursor: pointer;
    transition: background 0.18s ease;
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: transform 0.18s ease;
  }
  .switch:checked {
    background: var(--accent);
  }
  .switch:checked::after {
    transform: translateX(16px);
  }
  .switch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* ---- actions ---- */
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .actions.split {
    justify-content: space-between;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .group {
    display: flex;
    gap: 8px;
  }
  button.primary,
  button.ghost {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border-radius: 8px;
    padding: 7px 14px;
  }
  button.primary {
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.12) inset,
      0 4px 14px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  button.ghost {
    background: transparent;
  }
  button.quiet {
    color: var(--text-muted);
  }
  button.danger {
    color: var(--danger);
    padding: 7px 10px;
  }
  button.danger:hover:not(:disabled) {
    background: var(--removed-bg);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }
  button.small {
    font-size: 12px;
    padding: 5px 11px;
  }
  .waiting {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ---- hero (not connected) ---- */
  .benefits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .benefits li {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    font-size: 12.5px;
    line-height: 1.45;
  }
  .benefits li :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--added-fg);
  }
  .body-text {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ---- callouts & notices ---- */
  .callout {
    font-size: 12.5px;
    line-height: 1.5;
    padding: 9px 11px;
    border-radius: 9px;
    border: 1px solid var(--border);
  }
  .callout.warn {
    background: color-mix(in srgb, #f6ad55 10%, transparent);
    border-color: color-mix(in srgb, #f6ad55 35%, transparent);
  }
  .callout.bad {
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
  .callout-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    border-radius: 10px;
    font-size: 12.5px;
    animation: notice-in 0.2s ease;
  }
  .notice span {
    flex: 1;
  }
  .notice.success {
    background: var(--added-bg);
    color: var(--added-fg);
  }
  .notice.warning {
    background: color-mix(in srgb, #f6ad55 12%, transparent);
    border: 1px solid color-mix(in srgb, #f6ad55 35%, transparent);
  }
  .notice.error {
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
  .dismiss {
    border: none;
    background: none;
    color: inherit;
    opacity: 0.7;
    padding: 0 2px;
    font-size: 12px;
  }
  .dismiss:hover:not(:disabled) {
    background: none;
    opacity: 1;
  }
  @keyframes notice-in {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }

  .spinner {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-right-color: transparent;
    animation: spin 0.8s linear infinite;
    flex: none;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2.4s;
    }
    .notice,
    .switch,
    .switch::after {
      animation: none;
      transition: none;
    }
  }
</style>
