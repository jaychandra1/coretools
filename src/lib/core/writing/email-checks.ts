/**
 * Work-email conventions, checked as suggestions alongside Harper's: a
 * greeting and a sign-off (not a casual one), no shouting capitals, no
 * pushy exclamation marks, no placeholder left in. Nothing changes unless
 * the user applies a fix. Pure functions; no network.
 */

import type { Issue } from "./issues";

const GREETING = /^(?:hi|hello|hey+|yo|hiya|heya|sup|dear|greetings|good\s+(?:morning|afternoon|evening))\b/i;
const CASUAL_GREETING = /^(?:hey+|yo|hiya|heya|sup)\b/i;

/** A line that is only a closing phrase: "Thanks," / "best regards" / "cheers!". */
const CLOSING_LINE =
  /^(thanks|thank you|many thanks|best|best regards|regards|kind regards|warm regards|sincerely|yours sincerely|yours truly|cheers|br|thx|rgds|ttyl|later)\s*[,.!]?$/i;

/** Casual closings and their usual work-email equivalent. */
const CASUAL_CLOSINGS: Record<string, string> = {
  cheers: "Best regards",
  br: "Best regards",
  ttyl: "Best regards",
  later: "Best regards",
  rgds: "Regards",
  thx: "Thanks",
};

/** All-caps words that are normal in business email. */
const ACRONYMS = new Set([
  "FYI", "ASAP", "EOD", "COB", "CC", "BCC", "PS", "OK", "IT", "HR", "PR",
  "QA", "CEO", "CTO", "CFO", "COO", "VP", "API", "URL", "ID", "USA", "UK",
  "EU", "PDF", "FAQ", "ETA", "AM", "PM", "EST", "PST", "IST", "UTC", "KPI",
  "SLA", "PO", "NDA", "DOB", "SSN", "PAN", "KYC", "REF", "INV", "EMI", "UPI",
  "IFSC", "GST", "TIN", "EIN", "POC", "DL", "AWS", "GCP", "SQL", "JSON",
  "YAML", "HTML", "CSS", "CSV", "XML", "HTTP", "HTTPS", "SSO", "MFA", "VPN",
  "CI", "CD", "RCA", "TBD", "TBA", "NA", "WFH", "OOO", "PTO", "ROI", "B2B",
]);

interface Line {
  start: number;
  text: string;
}

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const text_ of text.split("\n")) {
    out.push({ start, text: text_ });
    start += text_.length + 1;
  }
  return out;
}

function issue(
  rule: string,
  start: number,
  end: number,
  problem: string,
  title: string,
  message: string,
  fixes: Issue["fixes"],
): Issue {
  return { id: `e:${rule}:${start}`, start, end, category: "email", rule, title, message, problem, fixes };
}

/** Email-convention issues in `text` (offsets into `text`). */
export function checkEmail(text: string): Issue[] {
  const issues: Issue[] = [];
  const lines = linesOf(text);
  const filled = lines.filter((line) => line.text.trim() !== "");
  if (!filled.length) return issues;

  // Greeting: the first line with words in it.
  const first = filled[0];
  const lead = first.text.length - first.text.trimStart().length;
  const opening = first.text.trimStart();
  const casual = opening.match(CASUAL_GREETING);
  if (casual) {
    issues.push(
      issue("casual-greeting", first.start + lead, first.start + lead + casual[0].length, casual[0],
        "Casual greeting", `“${casual[0]}” reads as casual in a work email.`,
        [{ kind: "replace", text: "Hi" }, { kind: "replace", text: "Hello" }]),
    );
  } else if (!GREETING.test(opening)) {
    issues.push(
      issue("no-greeting", first.start + lead, first.start + lead, "", "Greeting",
        "Work emails usually open with a greeting.",
        [{ kind: "insert-before", text: "Hi,\n\n" }, { kind: "insert-before", text: "Hello,\n\n" }]),
    );
  }

  // Sign-off: a closing line among the last few lines (a name may follow it).
  const tail = filled.slice(-4).reverse();
  const closing = tail.find((line) => CLOSING_LINE.test(line.text.trim()));
  if (closing) {
    const lineLead = closing.text.length - closing.text.trimStart().length;
    const word = closing.text.trim().replace(/\s*[,.!]$/, "");
    const better = CASUAL_CLOSINGS[word.toLowerCase()];
    if (better) {
      const start = closing.start + lineLead;
      issues.push(
        issue("casual-sign-off", start, start + word.length, word, "Casual sign-off",
          `“${word}” reads as casual in a work email.`, [{ kind: "replace", text: better }]),
      );
    }
  } else if (filled.length > 1) {
    const end = text.trimEnd().length;
    issues.push(
      issue("no-sign-off", end, end, "", "Sign-off",
        "Work emails usually end with a sign-off and your name.",
        [{ kind: "insert-after", text: "\n\nBest regards,\n" }, { kind: "insert-after", text: "\n\nThanks,\n" }]),
    );
  }

  // Shouting: words in capitals that aren't acronyms.
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])\p{Lu}{3,}(?![\p{L}\p{N}_])/gu)) {
    const word = match[0];
    if (ACRONYMS.has(word)) continue;
    const start = match.index ?? 0;
    const atSentenceStart = /(?:^|[.!?]\s+|\n\s*)$/.test(text.slice(0, start));
    const lower = word.toLowerCase();
    issues.push(
      issue("all-caps", start, start + word.length, word, "All capitals",
        "Words in capitals read as shouting in email.",
        [{ kind: "replace", text: atSentenceStart ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower }]),
    );
  }

  // Pushy punctuation: "!!", "!!!".
  for (const match of text.matchAll(/!{2,}/g)) {
    const start = match.index ?? 0;
    issues.push(
      issue("exclamations", start, start + match[0].length, match[0], "Exclamation marks",
        "Several exclamation marks read as pushy in a work email.",
        [
          { kind: "replace", text: ".", label: "Use “.”" },
          { kind: "replace", text: "!", label: "Keep one “!”" },
        ]),
    );
  }

  // Placeholders left in: "[Name]", "[Your Name]", "[date]".
  for (const match of text.matchAll(/\[(?:your\s+)?(?:name|date|company|title|phone|email)\]/gi)) {
    const start = match.index ?? 0;
    issues.push(
      issue("placeholder", start, start + match[0].length, match[0], "Placeholder",
        "Fill in this placeholder before sending.", []),
    );
  }

  return issues.sort((a, b) => a.start - b.start);
}
