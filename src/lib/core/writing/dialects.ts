/** The English dialects the checker offers (Harper's, see harper-lints.ts). */
export const DIALECT_LABELS = {
  american: "English (US)",
  british: "English (UK)",
  canadian: "English (Canada)",
  australian: "English (Australia)",
  indian: "English (India)",
} as const;

export type DialectId = keyof typeof DIALECT_LABELS;

export function isDialectId(value: unknown): value is DialectId {
  return typeof value === "string" && Object.hasOwn(DIALECT_LABELS, value);
}
