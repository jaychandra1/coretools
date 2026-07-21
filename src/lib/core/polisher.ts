/**
 * Sentence Polisher engine.
 *
 * Deterministic, rule-based text rewriting in three styles: professional,
 * Gen Z, and complete. Pure functions, zero dependencies, fully offline —
 * nothing the user types ever leaves the app.
 */

export type PolishMode = "professional" | "genz" | "complete";

/* --------------------------- helpers --------------------------- */

function normalize(text: string): string {
  return String(text || "")
    .replace(/’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Capitalize the first letter of every sentence. */
function sentenceCase(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre: string, ch: string) => pre + ch.toUpperCase());
}

/** Ensure the text ends with terminal punctuation. */
function ensureEnd(text: string): string {
  if (!text) return text;
  return /[.!?…]$/.test(text) ? text : text + ".";
}

/** Collapse repeated punctuation and fix spacing around it. */
function tidyPunctuation(text: string): string {
  return text
    .replace(/([!?])\1+/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,([^\s\d])/g, ", $1");
}

type Rule = [pattern: string, replacement: string];

/**
 * Apply ordered word rules with word boundaries and first-letter case
 * preservation. Longer (multi-word) patterns must come first.
 */
function applyRules(text: string, rules: Rule[]): string {
  let out = text;
  for (const [pattern, replacement] of rules) {
    const re = new RegExp(`\\b${pattern}\\b`, "gi");
    out = out.replace(re, (match) => {
      if (match.charAt(0) === match.charAt(0).toUpperCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1);
      }
      return replacement;
    });
  }
  return out;
}

/** Standalone "i" → "I". */
function fixI(text: string): string {
  return text.replace(/\bi\b/g, "I");
}

/**
 * Common "its" typo → "it is" when followed by a word that cannot follow the
 * possessive. Real possessives ("its color") are left untouched.
 */
function fixItsTypo(text: string): string {
  return text.replace(
    /\bits\b(?=\s+(?:a|an|the|so|too|very|really|quite|not|going|just)\b)/gi,
    "it is",
  );
}

/* ------------------------- word tables ------------------------- */

const EXPAND_CONTRACTIONS: Rule[] = [
  ["can't", "cannot"],
  ["won't", "will not"],
  ["shan't", "shall not"],
  // "n't" has no word boundary inside e.g. "don't", so each form is explicit.
  ["don't", "do not"],
  ["doesn't", "does not"],
  ["didn't", "did not"],
  ["isn't", "is not"],
  ["aren't", "are not"],
  ["wasn't", "was not"],
  ["weren't", "were not"],
  ["couldn't", "could not"],
  ["shouldn't", "should not"],
  ["wouldn't", "would not"],
  ["haven't", "have not"],
  ["hasn't", "has not"],
  ["hadn't", "had not"],
  ["mustn't", "must not"],
  ["i'm", "I am"],
  ["it's", "it is"],
  ["that's", "that is"],
  ["there's", "there is"],
  ["what's", "what is"],
  ["let's", "let us"],
  ["they're", "they are"],
  ["we're", "we are"],
  ["you're", "you are"],
  ["i've", "I have"],
  ["we've", "we have"],
  ["you've", "you have"],
  ["they've", "they have"],
  ["i'll", "I will"],
  ["we'll", "we will"],
  ["you'll", "you will"],
  ["he'll", "he will"],
  ["she'll", "she will"],
  ["they'll", "they will"],
  ["i'd", "I would"],
  ["we'd", "we would"],
  ["you'd", "you would"],
  ["he's", "he is"],
  ["she's", "she is"],
  ["who's", "who is"],
  ["would've", "would have"],
  ["should've", "should have"],
  ["could've", "could have"],
];

const TXT_SPEAK: Rule[] = [
  ["asap", "as soon as possible"],
  ["btw", "by the way"],
  ["fyi", "for your information"],
  ["idk", "I do not know"],
  ["imo", "in my opinion"],
  ["imho", "in my honest opinion"],
  ["thx", "thank you"],
  ["pls", "please"],
  ["plz", "please"],
  ["u", "you"],
  ["ur", "your"],
  ["thru", "through"],
  ["cuz", "because"],
  ["coz", "because"],
  ["gonna", "going to"],
  ["wanna", "want to"],
  ["gotta", "have to"],
  ["kinda", "somewhat"],
  ["sorta", "somewhat"],
  ["approx", "approximately"],
  ["docs", "documentation"],
  ["specs", "specifications"],
  ["info", "information"],
];

/* ------------------------ professional ------------------------ */

const PRO_FILLERS =
  /\b(just|basically|literally|really|very|super|totally|honestly,?|you know,?|i mean,?|like,)\s+/gi;

const PRO_RULES: Rule[] = [
  ["a lot of", "many"],
  ["lots of", "many"],
  ["need to", "must"],
  ["let me know", "please inform me"],
  ["get back to you", "follow up with you"],
  ["find out", "determine"],
  ["deal with", "address"],
  ["think about", "consider"],
  ["talk about", "discuss"],
  ["right now", "at present"],
  ["hey", "hello"],
  ["hi", "hello"],
  ["hiya", "hello"],
  ["yeah", "yes"],
  ["yep", "yes"],
  ["nope", "no"],
  ["thanks", "thank you"],
  ["sorry", "I apologize"],
  ["awesome", "excellent"],
  ["cool", "excellent"],
  ["stuff", "material"],
  ["huge", "substantial"],
  ["kids", "children"],
  ["boss", "manager"],
  ["buy", "purchase"],
  ["help", "assist"],
  ["also", "additionally"],
];

function polishProfessional(text: string): string {
  let t = fixItsTypo(normalize(text)).replace(PRO_FILLERS, "");
  t = applyRules(t, TXT_SPEAK);
  t = applyRules(t, EXPAND_CONTRACTIONS);
  t = applyRules(t, PRO_RULES);
  // Mid-sentence "but" reads better as a parenthetical "however".
  t = t.replace(/\s+but\s+/gi, ", however, ").replace(/,\s*,/g, ",");
  // Sentence-opening casual conjunctions.
  t = t.replace(/(^|[.!?]\s+)(but|and|so)\b,?\s*/gi, (_, pre: string, word: string) => {
    const map: Record<string, string> = {
      but: "However, ",
      and: "Additionally, ",
      so: "Therefore, ",
    };
    return pre + map[word.toLowerCase()];
  });
  t = fixI(t);
  t = tidyPunctuation(t);
  t = sentenceCase(t);
  return ensureEnd(t);
}

/* --------------------------- gen z ---------------------------- */

const GENZ_RULES: Rule[] = [
  ["very good", "straight fire"],
  ["to be honest", "ngl"],
  ["i agree", "bet"],
  ["no problem", "say less"],
  ["i understand", "i get it"],
  ["the best", "the goat"],
  ["amazing", "fire"],
  ["awesome", "fire"],
  ["excellent", "fire"],
  ["fantastic", "fire"],
  ["great", "fire"],
  ["good", "solid"],
  ["best", "goated"],
  ["bad", "mid"],
  ["terrible", "mid"],
  ["mediocre", "mid"],
  ["average", "mid"],
  ["delicious", "bussin"],
  ["beautiful", "a whole vibe"],
  ["crazy", "wild"],
  ["insane", "wild"],
  ["surprising", "wild"],
  ["honestly", "ngl"],
  ["seriously", "deadass"],
  ["definitely", "fr"],
  ["certainly", "fr"],
  ["very", "lowkey"],
  ["really", "lowkey"],
  ["extremely", "hella"],
  ["incredibly", "hella"],
  ["friends", "the squad"],
  ["impressive", "different"],
];

const CONTRACT: Rule[] = [
  ["cannot", "can't"],
  ["will not", "won't"],
  ["do not", "don't"],
  ["does not", "doesn't"],
  ["did not", "didn't"],
  ["is not", "isn't"],
  ["are not", "aren't"],
  ["was not", "wasn't"],
  ["were not", "weren't"],
  ["would not", "wouldn't"],
  ["could not", "couldn't"],
  ["should not", "shouldn't"],
  ["i am", "i'm"],
  ["it is", "it's"],
  ["that is", "that's"],
  ["they are", "they're"],
  ["we are", "we're"],
  ["you are", "you're"],
  ["i will", "i'll"],
  ["i have", "i've"],
  ["going to", "gonna"],
  ["want to", "wanna"],
];

function polishGenZ(text: string): string {
  let t = normalize(text);
  t = applyRules(t, CONTRACT);
  t = applyRules(t, GENZ_RULES);
  t = tidyPunctuation(t);
  t = t.toLowerCase();
  t = t.replace(/[.]+$/, ""); // gen z doesn't end on a period
  if (!/\b(no cap|fr|ngl|deadass)\b/.test(t)) {
    t += ", no cap";
  }
  return t;
}

/* -------------------------- complete -------------------------- */

const COMPLETE_RULES: Rule[] = [
  ["etc", "and so on"],
  ["stuff", "details"],
  ["w/", "with"],
  ["b/c", "because"],
  ["esp", "especially"],
];

function polishComplete(text: string): string {
  let t = normalize(text);
  t = applyRules(t, TXT_SPEAK);
  t = fixItsTypo(t);
  t = applyRules(t, EXPAND_CONTRACTIONS);
  t = applyRules(t, COMPLETE_RULES);
  t = fixI(t);
  t = tidyPunctuation(t);
  t = sentenceCase(t);
  return ensureEnd(t);
}

/* --------------------------- public --------------------------- */

/** Rewrite `text` in the given style. Returns "" for empty input. */
export function polish(text: string, mode: PolishMode): string {
  if (!normalize(text)) return "";
  switch (mode) {
    case "genz":
      return polishGenZ(text);
    case "complete":
      return polishComplete(text);
    case "professional":
    default:
      return polishProfessional(text);
  }
}
