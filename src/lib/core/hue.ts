/**
 * A stable hue (0–359) for a name, so the same account, login or space gets
 * the same colour every time without storing one.
 */
export function nameHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}
