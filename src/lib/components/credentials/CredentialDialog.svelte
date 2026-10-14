<script lang="ts">
  import Modal from "../authenticator/Modal.svelte";
  import type { CredentialInput } from "./credentials.svelte";
  import type { StoredCredential } from "../../core/credentials/types";
  import { normalizeUrl, UrlError } from "../../core/credentials/url";
  import { parseTags } from "../../core/credentials/search";
  import { generatePassword, passwordStrength } from "../../core/credentials/generate";
  import { focusOnMount } from "../../focus";
  import {
    canonicalSpace,
    spaceHue,
    spaceNameError,
    spaceNames,
    SPACE_NAME_MAX,
  } from "../../core/credentials/spaces";

  let {
    credential = null,
    defaultSpace = "",
    suggestions,
    loadSecret,
    onsave,
    onclose,
  }: {
    /** Present when editing. */
    credential?: StoredCredential | null;
    /** Adding: the space tab on screen, preselected. */
    defaultSpace?: string;
    suggestions: { categories: string[]; owners: string[]; tags: string[]; spaces: string[] };
    /** Decrypt the current password/notes (gated + audited by the store). */
    loadSecret: (kind: "password" | "notes") => Promise<string | null>;
    onsave: (input: CredentialInput) => Promise<void>;
    onclose: () => void;
  } = $props();

  const editing = $derived(credential !== null);

  // svelte-ignore state_referenced_locally — the form is seeded once.
  let platform = $state(credential?.platform ?? "");
  // svelte-ignore state_referenced_locally
  let url = $state(credential?.url ?? "");
  // svelte-ignore state_referenced_locally
  let username = $state(credential?.username ?? "");
  // svelte-ignore state_referenced_locally
  let category = $state(credential?.category ?? "");
  // svelte-ignore state_referenced_locally
  let owner = $state(credential?.owner ?? "");
  // svelte-ignore state_referenced_locally
  let tagsText = $state(credential?.tags.join(", ") ?? "");
  // svelte-ignore state_referenced_locally
  let spaceChoice = $state(credential ? credential.space : defaultSpace);
  /** Typing the name of a space that doesn't exist yet. */
  let creatingSpace = $state(false);
  let newSpaceName = $state("");
  let spaceError = $state("");
  // svelte-ignore state_referenced_locally — includes a just-created, still empty space.
  const spaceOptions = spaceNames([], [...suggestions.spaces, spaceChoice]);
  /** The "New space…" option; no real name can match (control characters are stripped). */
  const NEW_SPACE = "\u0000new";
  let password = $state("");
  let notes = $state("");
  let showPassword = $state(false);
  /** Edit mode: the password field holds a value the user wants to save. */
  let passwordDirty = $state(false);
  /** Edit mode: notes were loaded or typed, so their content is known. */
  let notesKnown = $state(false);
  let loadedPassword: string | null = null;

  let error = $state("");
  let urlError = $state("");
  let busy = $state(false);

  const tags = $derived(parseTags(tagsText));
  const strength = $derived(passwordStrength(password));
  const strengthLabel: Record<string, string> = {
    weak: "Weak",
    fair: "Fair",
    good: "Good",
    strong: "Strong",
  };

  function checkUrl(): string | null {
    try {
      urlError = "";
      return normalizeUrl(url);
    } catch (e) {
      urlError = e instanceof UrlError ? e.message : "Invalid link";
      return null;
    }
  }

  function pickSpace(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    if (select.value === NEW_SPACE) {
      select.value = spaceChoice;
      creatingSpace = true;
      return;
    }
    spaceChoice = select.value;
  }

  function cancelNewSpace() {
    creatingSpace = false;
    newSpaceName = "";
    spaceError = "";
  }

  function generate() {
    password = generatePassword(20);
    showPassword = true;
    passwordDirty = true;
  }

  async function revealCurrent() {
    try {
      const current = await loadSecret("password");
      if (current === null) return;
      loadedPassword = current;
      password = current;
      showPassword = true;
      passwordDirty = false;
    } catch (e) {
      error = e instanceof Error && e.message !== "canceled" ? e.message : "";
    }
  }

  async function loadNotes() {
    try {
      const current = await loadSecret("notes");
      if (current === null) return;
      notes = current;
      notesKnown = true;
    } catch (e) {
      error = e instanceof Error && e.message !== "canceled" ? e.message : "";
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    error = "";
    if (!platform.trim()) {
      error = "Enter a platform or application name.";
      return;
    }
    const normalized = checkUrl();
    if (normalized === null) return;
    let space = spaceChoice;
    if (creatingSpace) {
      spaceError = spaceNameError(newSpaceName) ?? "";
      if (spaceError) return;
      space = canonicalSpace(newSpaceName, spaceOptions);
    }

    const changedPassword = editing
      ? passwordDirty && password !== loadedPassword
        ? password
        : null
      : password;
    const changedNotes = editing ? (notesKnown ? notes : null) : notes;

    busy = true;
    try {
      await onsave({
        platform,
        url: normalized,
        username,
        category,
        owner,
        tags,
        space,
        password: changedPassword,
        notes: changedNotes,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not save";
    } finally {
      busy = false;
    }
  }
</script>

<Modal title={editing ? "Edit credential" : "Add credential"} {onclose} wide>
  <form onsubmit={save} novalidate>
    <div class="grid">
      <label class="field span-2">
        <span class="label">Platform / application <em>*</em></span>
        <input
          bind:value={platform}
          placeholder="AWS Production"
          autocomplete="off"
          {@attach editing ? undefined : focusOnMount}
        />
      </label>

      <label class="field span-2">
        <span class="label">Login URL</span>
        <input
          bind:value={url}
          onblur={() => url.trim() && checkUrl()}
          placeholder="https://console.aws.amazon.com"
          autocomplete="off"
          inputmode="url"
          class:invalid={urlError}
        />
        {#if urlError}<span class="field-error">{urlError}</span>{/if}
      </label>

      <label class="field span-2">
        <span class="label">Username / email</span>
        <input bind:value={username} placeholder="devops-admin" autocomplete="off" />
      </label>

      <div class="field span-2">
        <span class="label" id="pw-label">Password / secret</span>
        <div class="pw-row">
          <input
            type={showPassword ? "text" : "password"}
            class="mono"
            bind:value={password}
            oninput={() => (passwordDirty = true)}
            placeholder={editing ? "Unchanged — type to replace" : ""}
            autocomplete="new-password"
            aria-labelledby="pw-label"
          />
          <button
            type="button"
            class="icon"
            onclick={() => (showPassword = !showPassword)}
            data-tip={showPassword ? "Hide" : "Show"}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {#if showPassword}
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.7 9.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 7 9.5 7a9.4 9.4 0 0 0 5.4-1.6" /></svg>
            {:else}
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" /><circle cx="12" cy="12" r="3" /></svg>
            {/if}
          </button>
          <button type="button" class="ghost" onclick={generate} data-tip="Generate a strong password">
            Generate
          </button>
          {#if editing}
            <button type="button" class="ghost" onclick={revealCurrent}>Show current</button>
          {/if}
        </div>
        {#if password}
          <div class="strength s-{strength.strength}" aria-live="polite">
            <span class="bar"><span></span></span>
            <span class="strength-text">{strengthLabel[strength.strength]} · ~{strength.bits} bits</span>
          </div>
        {/if}
      </div>

      <div class="field">
        <span class="label" id="space-label">Space</span>
        {#if creatingSpace}
          <div class="space-new">
            <input
              bind:value={newSpaceName}
              oninput={() => (spaceError = "")}
              maxlength={SPACE_NAME_MAX}
              placeholder="Dev team"
              autocomplete="off"
              aria-labelledby="space-label"
              class:invalid={spaceError}
              {@attach focusOnMount}
            />
            <button type="button" class="ghost" onclick={cancelNewSpace}>Cancel</button>
          </div>
        {:else}
          <div class="space-pick">
            {#if spaceChoice}
              <span class="dot" style="background: hsl({spaceHue(spaceChoice)}, 60%, 55%)" aria-hidden="true"></span>
            {/if}
            <select value={spaceChoice} onchange={pickSpace} aria-labelledby="space-label">
              <option value="">No space (All only)</option>
              {#each spaceOptions as s (s)}<option value={s}>{s}</option>{/each}
              <option value={NEW_SPACE}>New space…</option>
            </select>
          </div>
        {/if}
        {#if spaceError}<span class="field-error">{spaceError}</span>{/if}
      </div>

      <label class="field">
        <span class="label">Category</span>
        <input bind:value={category} list="cred-categories" placeholder="Cloud" autocomplete="off" />
        <datalist id="cred-categories">
          {#each suggestions.categories as c (c)}<option value={c}></option>{/each}
        </datalist>
      </label>

      <label class="field">
        <span class="label">Owner</span>
        <input bind:value={owner} list="cred-owners" placeholder="Platform team" autocomplete="off" />
        <datalist id="cred-owners">
          {#each suggestions.owners as o (o)}<option value={o}></option>{/each}
        </datalist>
      </label>

      <label class="field">
        <span class="label">Tags <span class="hint">comma-separated</span></span>
        <input bind:value={tagsText} placeholder="prod, infra" autocomplete="off" />
        {#if tags.length}
          <span class="chips">{#each tags as tag (tag)}<span class="chip">#{tag}</span>{/each}</span>
        {/if}
      </label>

      <div class="field span-2">
        <span class="label" id="notes-label">Notes <span class="hint">encrypted</span></span>
        {#if editing && credential?.notes && !notesKnown}
          <button type="button" class="ghost load-notes" onclick={loadNotes}>
            Show saved notes to edit them
          </button>
        {:else}
          <textarea
            bind:value={notes}
            oninput={() => (notesKnown = true)}
            rows="3"
            placeholder="Recovery codes location, MFA device, …"
            aria-labelledby="notes-label"
          ></textarea>
        {/if}
      </div>
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      <button type="button" onclick={onclose}>Cancel</button>
      <button class="primary" type="submit" disabled={busy || !platform.trim()}>
        {busy ? "Saving…" : editing ? "Save changes" : "Add credential"}
      </button>
    </div>
  </form>
</Modal>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 14px;
  }
  .span-2 {
    grid-column: span 2;
  }
  @media (max-width: 560px) {
    .grid {
      grid-template-columns: 1fr;
    }
    .span-2 {
      grid-column: auto;
    }
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
  .label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .label em {
    color: var(--danger);
    font-style: normal;
  }
  .hint {
    font-weight: 400;
    opacity: 0.8;
    margin-left: 4px;
  }
  input,
  textarea,
  select {
    font-family: inherit;
    font-size: 13px;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    min-width: 0;
  }
  textarea {
    resize: vertical;
    font-family: inherit;
  }
  input.mono {
    font-family: var(--mono);
    letter-spacing: 0.02em;
  }
  input:focus-visible,
  textarea:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  input.invalid {
    border-color: var(--danger);
  }
  .field-error {
    color: var(--danger);
    font-size: 11.5px;
  }
  .pw-row,
  .space-new {
    display: flex;
    gap: 6px;
  }
  .space-new input {
    flex: 1;
  }
  .space-pick {
    position: relative;
    display: flex;
  }
  .space-pick select {
    flex: 1;
  }
  .space-pick .dot {
    position: absolute;
    left: 11px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
  }
  .space-pick .dot + select {
    padding-left: 26px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .pw-row input {
    flex: 1;
  }
  .icon {
    display: inline-grid;
    place-items: center;
    width: 36px;
    padding: 0;
    border-radius: 8px;
  }
  .ghost {
    background: transparent;
    border-radius: 8px;
    white-space: nowrap;
  }
  .load-notes {
    align-self: flex-start;
  }
  .strength {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .bar {
    flex: 0 0 120px;
    height: 5px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    transition: width 0.2s ease;
  }
  .s-weak .bar span { width: 25%; background: var(--danger); }
  .s-fair .bar span { width: 50%; background: #f6ad55; }
  .s-good .bar span { width: 75%; background: var(--accent); }
  .s-strong .bar span { width: 100%; background: var(--added-fg); }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 12.5px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  [data-tip] {
    position: relative;
  }
  [data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute;
    bottom: calc(100% + 6px);
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
    z-index: 5;
  }
</style>
