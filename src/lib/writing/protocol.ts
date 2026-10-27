/** Messages between the writing checker (checker.ts) and its worker. */

import type { DialectId } from "../core/writing/dialects";
import type { Issue } from "../core/writing/issues";

export interface CheckRequest {
  /** Increases with every request; the worker skips requests a newer one replaced. */
  id: number;
  text: string;
  dialect: DialectId;
  /** The user's own dictionary (names, product terms). */
  words: string[];
}

export type CheckResponse =
  | { id: number; issues: Issue[] }
  | { id: number; skipped: true }
  | { id: number; error: string };
