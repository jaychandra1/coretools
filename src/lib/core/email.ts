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
  "Q2", "Q3", "Q4", "KPI", "SLA", "PO", "NDA", "DOB", "SSN", "PAN", "KYC",
  "REF", "INV", "EMI", "UPI", "IFSC", "GST", "TIN", "EIN", "POC", "DL",
]);

/**
 * A greeting embedded inside flowing text (emails pasted without line breaks),
 * e.g. "… below: Hello john.doe@corp.com, I want to …". Addressee runs to the
 * first comma so email addresses (with dots) are captured.
 */
const EMBEDDED_GREETING = /\b(hello|hi|dear)\s+([^,;\n]{1,60}?),/i;

/**
 * An inline sign-off at the very end of the body, e.g.
 * "… if required. Thank you and Regards, Jaya Chandra K."
 * Restricted to regards/sincerely-family phrases so mid-sentence "thank you"
 * is never mistaken for a closing.
 */
const INLINE_CLOSING =
  /[.,!]?\s*\b(thanks?(?:\s+you)?\s+(?:and|&)\s+regards|best\s+regards|kind\s+regards|warm\s+regards|regards|sincerely)\b\s*[,.]?\s+([A-Z][A-Za-z]*\.?(?:\s+[A-Z][A-Za-z]*\.?){0,3})\s*$/i;

/**
 * Common second words of two-word labels ("Baby Name:", "Policy Number:").
 * A colon-word extends backward over one preceding TitleCase word only when
 * it is in this set — otherwise TitleCase *values* before the next label
 * ("… Velagala Deepika DOB:") would be swallowed into it.
 */
const LABEL_SECOND_WORDS = new Set([
  "Name", "Number", "No", "Date", "Code", "ID", "Id", "Type", "Status",
  "Address", "Details",
]);

/** A capitalized word immediately followed by a colon and whitespace. */
const LABEL_WORD = /\b([A-Z][a-zA-Z]*):(?=\s)/g;

/**
 * Find "Key: value" labels in a paragraph. Returns the start offset of each
 * label. Two or more labels make a details block (formatted one per line).
 */
function findDetailLabels(text: string): number[] {
  const starts: number[] = [];
  for (const m of text.matchAll(LABEL_WORD)) {
    let start = m.index ?? 0;
    if (LABEL_SECOND_WORDS.has(m[1])) {
      // Extend over one preceding TitleCase word ("Baby Name:").
      const before = text.slice(0, start).match(/(?:^|\s)([A-Z][a-zA-Z]*)\s$/);
      if (before) start -= before[1].length + 1;
    }
    starts.push(start);
  }
  return starts;
}

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
  // Email addresses and handles are left untouched.
  out = out
    .split(/\s+/)
    .map((w, i) => {
      if (/[@.]/.test(w)) return w;
      return i === 0 || /^[a-z]/.test(w) ? capitalize(w) : w;
    })
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
  let greeting = "";
  const firstLine = lines[0].trim();
  if (GREETING.test(firstLine)) {
    // A single-line email starting with a greeting ("hi sam, can you …"):
    // split the salutation off at the first comma that has content after it.
    const split = firstLine.match(/^(\S+(?:\s+[^,;\n]{0,60}?)?),\s+(\S.*)$/);
    if (split) {
      greeting = fixGreeting(split[1], issues);
      lines[0] = split[2];
    } else if (firstLine.length <= 40) {
      // Short salutation on its own line ("hey john" / "Dear Ms. Chen,").
      greeting = fixGreeting(lines.shift() as string, issues);
    }
  }
  if (!greeting) {
    // Greeting embedded mid-text (email pasted without line breaks):
    // extract it and move it to the top.
    const head = lines.slice(0, 2).join(" ");
    const m = head.slice(0, 250).match(EMBEDDED_GREETING);
    if (m) {
      greeting = fixGreeting(`${m[1]} ${m[2]}`, issues);
      issues.push({
        from: `${m[1]} ${m[2]},`,
        to: greeting,
        reason: "greeting was buried mid-text — moved to the top",
      });
      lines[0] = lines
        .slice(0, 2)
        .join(" ")
        .replace(m[0], " ")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (lines.length > 1) lines.splice(1, 1);
    }
  }
  if (!greeting) {
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
  // Sign-off written inline at the end of the last line
  // ("… if required. Thank you and Regards, Jaya Chandra K.").
  if (!closing && lines.length) {
    const last = lines[lines.length - 1];
    const m = last.match(INLINE_CLOSING);
    if (m) {
      closing = capitalize(m[1].toLowerCase().replace(/\s+/g, " ")) + ",";
      signature = [m[2].trim()];
      lines[lines.length - 1] = last.slice(0, m.index).trim();
      issues.push({
        from: `${m[1]}, ${m[2]}`,
        to: `${closing} ${signature[0]}`,
        reason: "inline sign-off — moved to its own lines",
      });
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
  let detailsFormatted = false;

  /** Tone + grammar + style rewrite for one run of flowing text. */
  const fixText = (text: string): string => {
    let p = text;
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
  };

  /**
   * Format one paragraph. A run of two or more "Key: value" labels is a
   * details block: each detail goes on its own line (values kept verbatim),
   * and any courtesy sentence resuming after the last value ("… Daughter
   * Please inform me …") is split back out as flowing text.
   */
  const fixParagraph = (para: string): string[] => {
    const p = softenCaps(para, issues);
    const labels = findDetailLabels(p);
    if (labels.length < 2) return [fixText(p)];

    const out: string[] = [];
    const head = p.slice(0, labels[0]).trim();
    if (head) out.push(fixText(head));

    const detailLines: string[] = [];
    let tail = "";
    labels.forEach((start, i) => {
      const end = i + 1 < labels.length ? labels[i + 1] : p.length;
      let chunk = p.slice(start, end).trim();
      if (i === labels.length - 1) {
        // A courtesy sentence may resume after the final value.
        const split = chunk.search(/\s(?=(?:Please|Kindly)\b)/);
        if (split > 0) {
          tail = chunk.slice(split).trim();
          chunk = chunk.slice(0, split).trim();
        }
      }
      detailLines.push(chunk);
    });
    out.push(detailLines.join("\n"));
    if (tail) out.push(fixText(tail));

    if (!detailsFormatted) {
      issues.push({
        from: "(inline details)",
        to: "(one per line)",
        reason: "details block formatted for readability",
      });
      detailsFormatted = true;
    }
    return out;
  };

  const fixedParagraphs = paragraphs.flatMap(fixParagraph);

  const output = [
    greeting,
    "",
    ...fixedParagraphs.flatMap((p) => [p, ""]),
    closing,
    ...signature,
  ].join("\n").replace(/\n{3,}/g, "\n\n");

  return { output, issues };
}
