<script lang="ts">
  import Modal from "../authenticator/Modal.svelte";
  import { credentialStore } from "./credentials.svelte";
  import { AUDIT_LIMIT, type AuditAction } from "../../core/credentials/types";
  import { getPlatform } from "../../platform";

  let { onclose }: { onclose: () => void } = $props();

  let loading = $state(true);
  let filter = $state<"all" | "access" | "changes">("all");
  let exportNote = $state("");

  const status = $derived(credentialStore.auditStatus);

  async function exportLog() {
    exportNote = "";
    try {
      const json = await credentialStore.exportAudit(__APP_VERSION__);
      const stamp = new Date().toISOString().slice(0, 10);
      if (await getPlatform().saveTextFile(`coretools-audit-${stamp}.json`, json)) {
        exportNote = "Exported, with the integrity result and chain head.";
      }
    } catch (e) {
      exportNote = e instanceof Error ? e.message : "Export failed";
    }
  }

  $effect(() => {
    credentialStore.loadAudit().finally(() => (loading = false));
  });

  const LABELS: Record<AuditAction, { text: string; tone: string }> = {
    created: { text: "Created", tone: "ok" },
    updated: { text: "Edited", tone: "neutral" },
    "password-changed": { text: "Password changed", tone: "warn" },
    deleted: { text: "Moved to trash", tone: "bad" },
    restored: { text: "Restored from trash", tone: "ok" },
    purged: { text: "Deleted permanently", tone: "bad" },
    revealed: { text: "Password viewed", tone: "access" },
    "copied-password": { text: "Password copied", tone: "access" },
    "restored-from-backup": { text: "Restored from backup", tone: "ok" },
    "log-reset": { text: "Log restarted after tampering was found", tone: "bad" },
  };

  const ACCESS: AuditAction[] = ["revealed", "copied-password"];

  const events = $derived(
    credentialStore.audit.filter((e) =>
      filter === "all"
        ? true
        : filter === "access"
          ? ACCESS.includes(e.action)
          : !ACCESS.includes(e.action),
    ),
  );

  function when(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
</script>

<Modal title="Activity log" {onclose} wide>
  <div class="head">
    <p class="muted">
      Every credential you create, edit, delete or restore, and every time a
      password is viewed or copied. Stored only on this device; the newest
      {AUDIT_LIMIT.toLocaleString()} events are kept. No secrets are logged.
      Entries are encrypted and chained, so changes are detectable.
    </p>
    {#if status}
      <p class="integrity" class:bad={status.state === "tampered"} role="status">
        {#if status.state === "verified"}
          ✓ Integrity verified — {status.count.toLocaleString()} {status.count === 1 ? "entry" : "entries"}, none altered or removed.
        {:else}
          ⚠ This log was altered outside CoreTools ({status.reason}). The entries below are the ones that could still be verified.
        {/if}
      </p>
    {/if}
    {#if credentialStore.auditWriteFailed}
      <p class="integrity bad" role="alert">
        ⚠ Some recent activity couldn't be written to this log. Copy diagnostics from About for details.
      </p>
    {/if}
    <div class="tools">
    <div class="segmented" role="tablist" aria-label="Filter events">
      {#each [["all", "All"], ["access", "Password access"], ["changes", "Changes"]] as const as [value, label] (value)}
        <button
          role="tab"
          aria-selected={filter === value}
          class:active={filter === value}
          onclick={() => (filter = value)}
        >
          {label}
        </button>
      {/each}
    </div>
    <button class="export" onclick={exportLog} disabled={loading}>Export…</button>
    </div>
    {#if exportNote}<p class="muted note">{exportNote}</p>{/if}
  </div>

  {#if loading}
    <p class="muted center">Loading…</p>
  {:else if events.length === 0}
    <p class="muted center">No activity yet.</p>
  {:else}
    <ol class="log">
      {#each events as event (event.id)}
        <li>
          <span class="tag t-{LABELS[event.action].tone}">{LABELS[event.action].text}</span>
          <span class="platform">{event.platform}</span>
          <time datetime={new Date(event.at).toISOString()}>{when(event.at)}</time>
        </li>
      {/each}
    </ol>
  {/if}
</Modal>

<style>
  .head {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 12px;
  }
  .head p {
    margin: 0;
    font-size: 12.5px;
  }
  .tools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .export {
    font-size: 12px;
    padding: 5px 12px;
  }
  .note {
    font-size: 12px;
  }
  .integrity {
    font-size: 12.5px;
    padding: 7px 10px;
    border-radius: 8px;
    background: var(--added-bg);
    color: var(--added-fg);
  }
  .integrity.bad {
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
  .segmented {
    display: inline-flex;
    align-self: flex-start;
    padding: 3px;
    gap: 2px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface-2);
  }
  .segmented button {
    border: none;
    background: transparent;
    padding: 5px 12px;
    border-radius: 7px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .segmented button.active {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  }
  .center {
    text-align: center;
    padding: 24px 0;
  }
  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    max-height: 52vh;
    overflow-y: auto;
  }
  .log li {
    display: grid;
    grid-template-columns: 150px 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 8px 4px;
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
  }
  .platform {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  time {
    color: var(--text-muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .tag {
    justify-self: start;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 9px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .t-ok { background: var(--added-bg); color: var(--added-fg); }
  .t-bad { background: var(--removed-bg); color: var(--removed-fg); }
  .t-warn { background: color-mix(in srgb, #f6ad55 16%, transparent); color: #b7791f; }
  :global(:root[data-theme="dark"]) .t-warn { color: #f6c26b; }
  .t-access { background: var(--accent-soft); color: var(--accent); }
  .t-neutral { background: var(--surface-2); color: var(--text-muted); }
  @media (max-width: 560px) {
    .log li {
      grid-template-columns: 1fr auto;
    }
    .log li .tag {
      grid-column: 1 / -1;
    }
  }
</style>
