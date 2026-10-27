/**
 * The writing checker's issues, independent of what found them (Harper for
 * spelling, grammar and style; email-checks.ts for email conventions), and
 * the pure operations on them: applying a fix, keeping issues in place while
 * the text is edited, "fix all", ignoring.
 *
 * Offsets are UTF-16 code units, like JavaScript string indices.
 */

export type IssueCategory = "spelling" | "grammar" | "style" | "email";

export type FixKind = "replace" | "remove" | "insert-before" | "insert-after";

export interface Fix {
  kind: FixKind;
  /** The new text (empty for "remove"). */
  text: string;
  /** The button's label, where the text alone wouldn't say enough ("." → "Use “.”"). */
  label?: string;
}

export interface Issue {
  /** Unique within one check. */
  id: string;
  start: number;
  /** Equal to `start` for a missing-something issue (nothing to underline). */
  end: number;
  category: IssueCategory;
  /** The rule that found it (a Harper lint kind, or an email-check id). */
  rule: string;
  /** Short name of the problem ("Spelling", "Agreement", "Greeting"). */
  title: string;
  /** What is wrong; `code` spans are marked with backticks. */
  message: string;
  /** The text at [start, end) when the issue was found. */
  problem: string;
  fixes: Fix[];
}

export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  spelling: "Spelling",
  grammar: "Grammar",
  style: "Style",
  email: "Email",
};

/** Harper's lint kinds, grouped the way the checker shows them. */
const SPELLING_KINDS = new Set(["Spelling", "Typo"]);
const STYLE_KINDS = new Set([
  "Style",
  "Readability",
  "Redundancy",
  "Enhancement",
  "WordChoice",
  "Regionalism",
  "Formatting",
  "Miscellaneous",
]);

export function categoryOf(lintKind: string): IssueCategory {
  if (SPELLING_KINDS.has(lintKind)) return "spelling";
  if (STYLE_KINDS.has(lintKind)) return "style";
  return "grammar";
}

/** What applying `fix` does, for its button. */
export function fixLabel(fix: Fix): string {
  if (fix.label) return fix.label;
  if (fix.kind === "remove" || (fix.kind === "replace" && fix.text === "")) return "Remove";
  if (!fix.text.trim()) return "Fix spacing";
  if (fix.kind === "insert-before" || fix.kind === "insert-after") return `Add “${fix.text.trim()}”`;
  return fix.text;
}

/** The text range a fix replaces, and what goes there. */
export function fixRange(issue: Issue, fix: Fix): { start: number; end: number; text: string } {
  switch (fix.kind) {
    case "insert-before":
      return { start: issue.start, end: issue.start, text: fix.text };
    case "insert-after":
      return { start: issue.end, end: issue.end, text: fix.text };
    case "remove":
      return { start: issue.start, end: issue.end, text: "" };
    case "replace":
      return { start: issue.start, end: issue.end, text: fix.text };
  }
}

/** A message with `code` spans split out, for safe rendering. */
export function messageParts(message: string): { text: string; code: boolean }[] {
  return message.split("`").map((text, i) => ({ text, code: i % 2 === 1 })).filter((part) => part.text);
}

/** The issue still points at the text it was found in. */
export function stillValid(text: string, issue: Issue): boolean {
  return text.slice(issue.start, issue.end) === issue.problem;
}

/**
 * Apply `fix` to `text`. Returns the new text and where the caret belongs
 * (just after the change).
 */
export function applyFix(text: string, issue: Issue, fix: Fix): { text: string; caret: number } {
  const range = fixRange(issue, fix);
  return {
    text: text.slice(0, range.start) + range.text + text.slice(range.end),
    caret: range.start + range.text.length,
  };
}

/** An issue "Fix all" may apply: exactly one fix, so there is no choice to make. */
export function hasSingleFix(issue: Issue): boolean {
  return issue.fixes.length === 1;
}

/**
 * Apply the single fix of every issue that has exactly one, from the end of
 * the text backwards so earlier offsets stay valid. Overlapping or outdated
 * issues are skipped. Returns the new text and how many fixes were applied.
 */
export function applyAll(text: string, issues: readonly Issue[]): { text: string; applied: number } {
  const candidates = issues
    .filter((issue) => hasSingleFix(issue) && stillValid(text, issue))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let applied = 0;
  let limit = Infinity; // everything at or after this offset was already changed
  for (const issue of candidates) {
    if (issue.end > limit || (issue.end === limit && issue.start !== issue.end)) continue;
    out = applyFix(out, issue, issue.fixes[0]).text;
    applied++;
    limit = issue.start;
  }
  return { text: out, applied };
}

/**
 * Move issues along with an edit from `before` to `after`: issues before the
 * changed region stay, issues after it shift, issues touching it are dropped
 * (the next check finds them again). Keeps underlines in place while typing.
 */
export function rebase(issues: readonly Issue[], before: string, after: string): Issue[] {
  if (before === after) return [...issues];
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  const changedEnd = before.length - suffix; // end of the edited region in `before`
  const delta = after.length - before.length;
  const out: Issue[] = [];
  for (const issue of issues) {
    if (issue.end < prefix || (issue.end === prefix && issue.start < prefix)) {
      out.push(issue);
    } else if (issue.start > changedEnd || (issue.start === changedEnd && issue.end > changedEnd)) {
      out.push({ ...issue, start: issue.start + delta, end: issue.end + delta });
    }
  }
  return out;
}

/**
 * Identifies "the same issue" across checks, for Ignore: the rule, the text
 * and the message — not the position, which moves as the text is edited.
 */
export function ignoreKey(issue: Pick<Issue, "rule" | "problem" | "message">): string {
  return `${issue.rule}\u0000${issue.problem.toLowerCase()}\u0000${issue.message}`;
}

/** Issues sorted by position, without the ones the user ignored. */
export function visibleIssues(issues: readonly Issue[], ignored: ReadonlySet<string>): Issue[] {
  return issues
    .filter((issue) => !ignored.has(ignoreKey(issue)))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export interface Segment {
  text: string;
  issue: Issue | null;
}

/**
 * Split `text` into plain runs and underlined runs for the highlight layer.
 * Missing-something issues (zero width) and overlaps aren't underlined;
 * they still show in the list.
 */
export function segments(text: string, issues: readonly Issue[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const issue of [...issues].sort((a, b) => a.start - b.start)) {
    if (issue.end <= issue.start || issue.start < at || issue.end > text.length) continue;
    if (issue.start > at) out.push({ text: text.slice(at, issue.start), issue: null });
    out.push({ text: text.slice(issue.start, issue.end), issue });
    at = issue.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), issue: null });
  return out;
}

/** The issue under the caret (or touching it), if any. */
export function issueAt(issues: readonly Issue[], offset: number): Issue | null {
  return issues.find((issue) => issue.end > issue.start && offset >= issue.start && offset <= issue.end) ?? null;
}

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}
