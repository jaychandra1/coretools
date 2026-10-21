<script lang="ts">
  /** A labelled on/off switch (a checkbox with role="switch"). */
  let {
    label,
    checked,
    onchange,
    title,
  }: {
    label: string;
    checked: boolean;
    onchange: (checked: boolean) => void;
    title?: string;
  } = $props();
</script>

<label class="switch" {title}>
  <input type="checkbox" role="switch" {checked} onchange={(e) => onchange(e.currentTarget.checked)} />
  <span>{label}</span>
</label>

<style>
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    color: var(--text-muted);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
  }
  input {
    appearance: none;
    position: relative;
    flex: none;
    width: 28px;
    height: 16px;
    margin: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-muted) 45%, transparent);
    cursor: pointer;
    transition: background 0.15s ease;
  }
  input::before {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
  }
  input:checked {
    background: var(--accent);
  }
  input:checked::before {
    transform: translateX(12px);
  }
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
