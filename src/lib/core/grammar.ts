/**
 * Offline grammar checker.
 *
 * Deterministic, rule-based validation of common English mistakes. Every
 * correction is recorded with the original text, the replacement, and a
 * human-readable reason, so the UI can show exactly what changed. Pure
 * functions, zero dependencies, no network — nothing leaves the app.
 */

export interface GrammarIssue {
  /** The original (incorrect) fragment. */
  from: string;
  /** What it was corrected to. */
  to: string;
  /** Short human-readable explanation. */
  reason: string;
}

export interface GrammarResult {
  /** The input with all corrections applied. */
  corrected: string;
  /** Ordered list of corrections that were made. */
  issues: GrammarIssue[];
}

type WordRule = readonly [pattern: string, replacement: string, reason: string];

/** Common misspellings. */
const SPELLING: readonly WordRule[] = [
  ["alot", "a lot", "spelling"],
  ["definately", "definitely", "spelling"],
  ["recieve", "receive", "spelling"],
  ["seperate", "separate", "spelling"],
  ["occured", "occurred", "spelling"],
  ["untill", "until", "spelling"],
  ["wich", "which", "spelling"],
  ["teh", "the", "spelling"],
  ["becuase", "because", "spelling"],
  ["tommorow", "tomorrow", "spelling"],
  ["wierd", "weird", "spelling"],
  ["grammer", "grammar", "spelling"],
  ["accross", "across", "spelling"],
  ["beleive", "believe", "spelling"],
  ["freind", "friend", "spelling"],
  ["thier", "their", "spelling"],
];

/** Missing apostrophes (only forms that are not valid words on their own). */
const APOSTROPHES: readonly WordRule[] = [
  ["dont", "don't", "missing apostrophe"],
  ["cant", "can't", "missing apostrophe"],
  ["wont", "won't", "missing apostrophe"],
  ["isnt", "isn't", "missing apostrophe"],
  ["arent", "aren't", "missing apostrophe"],
  ["wasnt", "wasn't", "missing apostrophe"],
  ["werent", "weren't", "missing apostrophe"],
  ["didnt", "didn't", "missing apostrophe"],
  ["doesnt", "doesn't", "missing apostrophe"],
  ["couldnt", "couldn't", "missing apostrophe"],
  ["shouldnt", "shouldn't", "missing apostrophe"],
  ["wouldnt", "wouldn't", "missing apostrophe"],
  ["havent", "haven't", "missing apostrophe"],
  ["hasnt", "hasn't", "missing apostrophe"],
  ["youre", "you're", "missing apostrophe"],
  ["theyre", "they're", "missing apostrophe"],
  ["whats", "what's", "missing apostrophe"],
  ["thats", "that's", "missing apostrophe"],
  ["im", "I'm", "missing apostrophe"],
  ["ive", "I've", "missing apostrophe"],
];

/** "should of" family. */
const MODAL_OF: readonly WordRule[] = [
  ["should of", "should have", '"of" after a modal verb'],
  ["would of", "would have", '"of" after a modal verb'],
  ["could of", "could have", '"of" after a modal verb'],
  ["must of", "must have", '"of" after a modal verb'],
  ["might of", "might have", '"of" after a modal verb'],
];

/** Subject–verb agreement (unambiguous cases only). */
const AGREEMENT: readonly WordRule[] = [
  ["he don't", "he doesn't", "subject–verb agreement"],
  ["she don't", "she doesn't", "subject–verb agreement"],
  ["it don't", "it doesn't", "subject–verb agreement"],
  ["they was", "they were", "subject–verb agreement"],
  ["we was", "we were", "subject–verb agreement"],
  ["you was", "you were", "subject–verb agreement"],
  ["he have", "he has", "subject–verb agreement"],
  ["she have", "she has", "subject–verb agreement"],
  ["it have", "it has", "subject–verb agreement"],
  ["your welcome", "you're welcome", 'possessive "your" vs "you\'re"'],
  ["your the", "you're the", 'possessive "your" vs "you\'re"'],
];

/**
 * Words after "a" that *sound* consonant-initial despite a vowel spelling
 * ("a university", "a one-off", "a European").
 */
const AN_EXCEPTIONS = /^(uni|use|user|one|once|eu)/i;

function preserveCase(source: string, replacement: string): string {
  if (source.charAt(0) === source.charAt(0).toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function applyWordRules(
  text: string,
  rules: readonly WordRule[],
  issues: GrammarIssue[],
): string {
  let out = text;
  for (const [pattern, replacement, reason] of rules) {
    const re = new RegExp("\\b" + pattern + "\\b", "gi");
    out = out.replace(re, (match) => {
      const to = preserveCase(match, replacement);
      issues.push({ from: match, to, reason });
      return to;
    });
  }
  return out;
}

/**
 * Check `text` for common grammar mistakes and return the corrected string
 * together with the list of applied corrections.
 */
export function checkGrammar(text: string): GrammarResult {
  const issues: GrammarIssue[] = [];
  let t = String(text || "")
    .replace(/’/g, "'")
    .trim();

  if (!t) return { corrected: "", issues };

  // Collapse runs of whitespace (reported once, only if present).
  if (/\s{2,}/.test(t)) {
    issues.push({ from: "  ", to: " ", reason: "extra spaces" });
    t = t.replace(/\s+/g, " ");
  }

  // Repeated word: "the the report".
  t = t.replace(/\b(\w+)\s+\1\b/gi, (match, word: string) => {
    issues.push({ from: match, to: word, reason: "repeated word" });
    return word;
  });

  t = applyWordRules(t, MODAL_OF, issues);
  t = applyWordRules(t, AGREEMENT, issues);
  t = applyWordRules(t, SPELLING, issues);
  t = applyWordRules(t, APOSTROPHES, issues);

  // "its" typo → "it is" when followed by a word the possessive cannot precede.
  t = t.replace(
    /\bits\b(?=\s+(?:a|an|the|so|too|very|really|quite|not|going|just)\b)/gi,
    (match) => {
      const to = preserveCase(match, "it's");
      issues.push({ from: match, to, reason: 'possessive "its" vs "it\'s"' });
      return to;
    },
  );

  // Article: "a apple" → "an apple" (with consonant-sound exceptions).
  t = t.replace(/\b(a)\s+([aeiou]\w*)/gi, (match, article: string, word: string) => {
    if (AN_EXCEPTIONS.test(word)) return match;
    const to = preserveCase(article, "an") + " " + word;
    issues.push({ from: match, to, reason: 'article "a" vs "an"' });
    return to;
  });

  // Standalone lowercase "i".
  if (/\bi\b/.test(t)) {
    issues.push({ from: "i", to: "I", reason: 'capitalize "I"' });
    t = t.replace(/\bi\b/g, "I");
  }

  // Sentence-start capitalization.
  const capitalized = t.replace(
    /(^|[.!?]\s+)([a-z])/g,
    (_, pre: string, ch: string) => pre + ch.toUpperCase(),
  );
  if (capitalized !== t) {
    issues.push({
      from: t.charAt(0) === t.charAt(0).toLowerCase() ? t.split(" ")[0] : "…",
      to: "capitalized",
      reason: "sentence capitalization",
    });
    t = capitalized;
  }

  // Terminal punctuation.
  if (!/[.!?…]$/.test(t)) {
    issues.push({ from: "(end of sentence)", to: ".", reason: "missing end punctuation" });
    t = t + ".";
  }

  return { corrected: t, issues };
}
