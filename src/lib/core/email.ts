/**
 * Email correction mode.
 *
 * Analyzes an email against corporate communication standards and repairs it:
 * greeting and sign-off presence/formality, shouting caps, exclamation tone,
 * plus the full grammar check and style rewrite on every body paragraph.
 *
 * Deterministic and rule-based like the rest of the core: no network, no
 * models, no storage — pure in-memory string processing.
 */

import { checkGrammar, type GrammarIssue } from "./grammar";
import { polish, type PolishMode } from "./polisher";

export interface EmailResult {
  /** The corrected, restructured email. */
  output: string;
  /** Every structural, tone, and grammar correction that was applied. */
  issues: GrammarIssue[];
}

/** Casual greetings normalized to a corporate-standard "Hi". */
const CASUAL_GREETINGS = /^(hey+|yo|hiya|heya|sup|hai)\b/i;
/** Any recognized greeting opener. */
const GREETING =
  /^(hi|hello|hey+|yo|hiya|heya|sup|hai|dear|greetings|good\s+(morning|afternoon|evening))\b/i;

/** A line that is (only) a closing phrase, e.g. "thanks," or "cheers". */
const CLOSING_LINE =
  /^(thanks|thank you|many thanks|best|best regards|regards|kind regards|warm regards|sincerely|cheers|br|thx|rgds)\s*[,.!]?$/i;

/** Casual closings mapped to corporate-standard ones. */
const CLOSING_FIX: Record<string, string> = {
  cheers: "Best regards",
  br: "Best regards",
  rgds: "Regards",
  thx: "Thanks",
  best: "Best regards",
};

/** All-caps words that are legitimate in business email. */
const CAPS_OK = new Set([
  "FYI", "ASAP", "EOD", "COB", "CC", "BCC", "PS", "OK", "IT", "HR", "PR",
  "QA", "CEO", "CTO", "CFO", "COO", "VP", "API", "URL", "ID", "USA", "UK",
  "EU", "PDF", "FAQ", "ETA", "AM", "PM", "EST", "PST", "IST", "UTC", "Q1",
  "Q2", "Q3", "Q4", "KPI", "SLA", "PO", "NDA",
]);

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Normalize a greeting line to "Hi Name," form. */
function fixGreeting(line: string, issues: GrammarIssue[]): string {
  let out = line.trim().replace(/[,.!;: ]+$/, "");

  if (CASUAL_GREETINGS.test(out)) {
    const fixed = out.replace(CASUAL_GREETINGS, "Hi");
    issues.push({
      from: out,
      to: fixed + ",",
      reason: "casual greeting — corporate emails open with “Hi”/“Hello”",
    });
    out = fixed;
  }

  // Capitalize the opener and the name that follows ("hi john" → "Hi John").
  out = out
    .split(/\s+/)
    .map((w, i) => (i === 0 || /^[a-z]/.test(w) ? capitalize(w) : w))
    .join(" ");

  return out + ",";
}

/**
 * Soften shouting caps in body text ("URGENT" → "urgent"; sentence casing is
 * restored later by the grammar pass). Whitelisted acronyms are kept.
 */
function softenCaps(text: string, issues: GrammarIssue[]): string {
  return text.replace(/\b[A-Z]{3,}\b/g, (word) => {
    if (CAPS_OK.has(word)) return word;
    issues.push({
      from: word,
      to: word.toLowerCase(),
      reason: "all-caps reads as shouting in email",
    });
    return word.toLowerCase();
  });
}

/**
 * Correct and rewrite an email to corporate standards. The rewrite `style`
 * applies to the body sentences; structural fixes (greeting, sign-off, tone)
 * always follow professional email conventions.
 */
export function polishEmail(raw: string, style: PolishMode): EmailResult {
  const issues: GrammarIssue[] = [];
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");

  // Trim leading/trailing blank lines.
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (!lines.length) return { output: "", issues };

  // --- greeting -----------------------------------------------------------
  let greeting: string;
  if (GREETING.test(lines[0].trim())) {
    greeting = fixGreeting(lines.shift() as string, issues);
  } else {
    greeting = "Hi [Name],";
    issues.push({
      from: "(no greeting)",
      to: greeting,
      reason: "missing greeting — corporate emails open with one",
    });
  }

  // --- sign-off ------------------------------------------------------------
  // Look for a closing phrase in the last few non-empty lines; everything
  // after it (usually the sender's name) is preserved.
  let closing = "";
  let signature: string[] = [];
  // The closing may be followed by a signature (name, title), so scan the
  // whole window rather than stopping at the last line.
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (CLOSING_LINE.test(trimmed)) {
      const word = trimmed.replace(/\s*[,.!]?$/, "");
      const fixed = CLOSING_FIX[word.toLowerCase()] ?? capitalize(word.toLowerCase());
      if (fixed.toLowerCase() !== word.toLowerCase()) {
        issues.push({
          from: trimmed,
          to: fixed + ",",
          reason: "casual sign-off — replaced with a corporate-standard closing",
        });
      }
      closing = fixed + ",";
      signature = lines.slice(i + 1).map((l) => l.trim()).filter(Boolean);
      lines.length = i; // body is everything before the closing
      break;
    }
  }
  if (!closing) {
    closing = "Best regards,";
    signature = ["[Your Name]"];
    issues.push({
      from: "(no sign-off)",
      to: "Best regards, [Your Name]",
      reason: "missing sign-off — corporate emails end with one",
    });
  } else if (signature.length === 0) {
    signature = ["[Your Name]"];
  }

  // --- body ----------------------------------------------------------------
  const paragraphs = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let exclamationsSoftened = false;
  const fixedParagraphs = paragraphs.map((para) => {
    let p = softenCaps(para, issues);

    // Exclamation marks read as pushy in corporate email (kept for Gen Z).
    if (style !== "genz" && /!/.test(p)) {
      p = p.replace(/!+/g, ".");
      if (!exclamationsSoftened) {
        issues.push({
          from: "!",
          to: ".",
          reason: "exclamation marks read as pushy in corporate email",
        });
        exclamationsSoftened = true;
      }
    }

    const grammar = checkGrammar(p);
    issues.push(...grammar.issues);
    return polish(grammar.corrected, style);
  });

  const output = [
    greeting,
    "",
    ...fixedParagraphs.flatMap((p) => [p, ""]),
    closing,
    ...signature,
  ].join("\n").replace(/\n{3,}/g, "\n\n");

  return { output, issues };
}
