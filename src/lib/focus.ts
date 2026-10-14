/**
 * `{@attach focusOnMount}`: focus a field when it appears. Svelte's
 * `autofocus` only moves focus while nothing else has it, so a field in a
 * dialog opened by clicking a button never got the cursor.
 */
export function focusOnMount(node: HTMLElement): void {
  node.focus();
}
