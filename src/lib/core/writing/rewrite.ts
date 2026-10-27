/**
 * Tone rewrites: Professional, Friendly, Concise.
 *
 * Deliberately conservative. Each tone changes only what it is about —
 * chat shorthand and contractions for Professional, stiff phrasing for
 * Friendly, filler and wordy phrases for Concise — and never swaps a word for
 * a "fancier" one that could change the meaning or break an idiom. Links,
 * email addresses, `code`, @mentions, #tags and file names are never
 * touched, and line breaks and indentation are kept. Spelling and grammar
 * are the checker's job (Harper), not this module's. Pure functions; nothing
 * leaves the app.
 */

export type Tone = "professional" | "friendly" | "concise";

export const TONES: Record<Tone, { label: string; hint: string }> = {
  professional: {
    label: "Professional",
    hint: "Spells out chat shorthand and contractions, and opens formally — for emails, reports, updates",
  },
  friendly: {
    label: "Friendly",
    hint: "Warmer and plainer: contractions, everyday words instead of stiff phrases",
  },
  concise: {
    label: "Concise",
    hint: "Cuts filler words and wordy phrases — says the same in fewer words",
  },
};

interface Rule {
  find: RegExp;
  replace: string;
}

/** Not inside a word (letters, digits, apostrophes). */
const NOT_AFTER_WORD = "(?<![\\p{L}\\p{N}_'’])";
const NOT_BEFORE_WORD = "(?![\\p{L}\\p{N}_'’])";
/** Start of the text, of a line, or of a sentence. */
const SENTENCE_START = "(?<=(?:^|[.!?][ \\t]+|\\n[ \\t]*))";
/** A word follows (so a contraction never ends a clause: "as it is." stays). */
const WORD_FOLLOWS = "(?=[ \\t]+[\\p{L}\\p{N}])";
/** Not followed by sentence-ending punctuation ("Really?" stays). */
const NOT_ENDING = "(?![ \\t]*[?!.])";

function escape(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "[ \\t]+");
}

interface Where {
  /** Must come right after this (a lookbehind); default: not inside a word. */
  before?: string;
  /** Extra condition on what follows (a lookahead). */
  after?: string;
  /** Only as a whole line ("Sincerely,"), or at a line's start ("Hey Sam"). */
  line?: "start" | "whole";
}

function rule(phrase: string, replace: string, where: Where = {}): Rule {
  let head = where.before ?? NOT_AFTER_WORD;
  let tail = NOT_BEFORE_WORD + (where.after ?? "");
  if (where.line) head = "(?<=^[ \\t]*)";
  if (where.line === "whole") tail += "(?=[ \\t]*[,.!]?[ \\t]*$)";
  return { find: new RegExp(head + escape(phrase) + tail, "gimu"), replace };
}

const rules = (pairs: [string, string][], where?: Where) =>
  pairs.map(([phrase, replace]) => rule(phrase, replace, where));

/* ------------------------------ professional ------------------------------ */

const SHORTHAND: [string, string][] = [
  ["asap", "as soon as possible"],
  ["btw", "by the way"],
  ["idk", "I don't know"],
  ["imo", "in my opinion"],
  ["imho", "in my opinion"],
  ["tbh", "to be honest"],
  ["thx", "thanks"],
  ["thnx", "thanks"],
  ["tnx", "thanks"],
  ["pls", "please"],
  ["plz", "please"],
  ["u", "you"],
  ["ur", "your"],
  ["thru", "through"],
  ["cuz", "because"],
  ["coz", "because"],
  ["b/c", "because"],
  ["w/o", "without"],
  ["w/", "with"],
  ["gonna", "going to"],
  ["wanna", "want to"],
  ["gotta", "have to"],
  ["kinda", "somewhat"],
  ["sorta", "somewhat"],
  ["lemme", "let me"],
  ["gimme", "give me"],
  ["dunno", "don't know"],
  ["yeah", "yes"],
  ["yep", "yes"],
  ["yup", "yes"],
  ["nope", "no"],
  ["nah", "no"],
];

/** Only unambiguous contractions: "'s" and "'d" can each mean two things. */
const EXPAND: [string, string][] = [
  ["can't", "cannot"],
  ["won't", "will not"],
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
  ["I'm", "I am"],
  ["you're", "you are"],
  ["we're", "we are"],
  ["they're", "they are"],
  ["I've", "I have"],
  ["you've", "you have"],
  ["we've", "we have"],
  ["they've", "they have"],
  ["I'll", "I will"],
  ["you'll", "you will"],
  ["we'll", "we will"],
  ["they'll", "they will"],
];

const PROFESSIONAL: Rule[] = [
  ...rules([["hey", "Hello"], ["heyy", "Hello"], ["hiya", "Hello"], ["yo", "Hello"], ["sup", "Hello"]], { line: "start" }),
  // "U.S." isn't "you" — no letter right after a dot or a hyphen.
  ...rules(SHORTHAND, { after: "(?![.\\-]\\p{L})" }),
  // Curly apostrophes too ("don’t").
  ...EXPAND.flatMap(([from, to]) => [rule(from, to), rule(from.replace("'", "’"), to)]),
];

/* -------------------------------- friendly -------------------------------- */

const FRIENDLY: Rule[] = [
  ...rules([["dear", "Hi"]], { line: "start" }),
  ...rules([["yours sincerely", "Best"], ["sincerely", "Best"], ["yours truly", "Best"]], { line: "whole" }),
  ...rules([["kindly", "please"]], { before: SENTENCE_START }),
  ...rules([
    ["please do not hesitate to contact me", "feel free to reach out"],
    ["please do not hesitate to reach out", "feel free to reach out"],
    ["please do not hesitate to", "feel free to"],
    ["at your earliest convenience", "when you get a chance"],
    ["i would be grateful if you could", "could you please"],
    ["could you kindly", "could you please"],
    ["would you kindly", "would you please"],
    ["thank you for your assistance", "thanks for your help"],
    ["thank you very much", "thanks so much"],
    ["thank you", "thanks"],
    ["i apologize for", "sorry for"],
    ["i apologise for", "sorry for"],
    ["regarding", "about"],
    ["assistance", "help"],
    ["utilize", "use"],
    ["utilise", "use"],
    ["commence", "start"],
  ]),
  ...rules([
    ["do not", "don't"],
    ["does not", "doesn't"],
    ["did not", "didn't"],
    ["is not", "isn't"],
    ["are not", "aren't"],
    ["was not", "wasn't"],
    ["were not", "weren't"],
    ["cannot", "can't"],
    ["can not", "can't"],
    ["will not", "won't"],
    ["would not", "wouldn't"],
    ["should not", "shouldn't"],
    ["could not", "couldn't"],
    ["have not", "haven't"],
    ["has not", "hasn't"],
  ]),
  ...rules(
    [
      ["i would like to", "I'd like to"],
      ["i am", "I'm"],
      ["you are", "you're"],
      ["we are", "we're"],
      ["they are", "they're"],
      ["it is", "it's"],
      ["that is", "that's"],
      ["there is", "there's"],
      ["what is", "what's"],
      ["i will", "I'll"],
      ["we will", "we'll"],
      ["you will", "you'll"],
    ],
    { after: WORD_FOLLOWS },
  ),
];

/* -------------------------------- concise --------------------------------- */

/** Filler words, removed with their comma ("Basically, we…" → "We…"). */
function filler(word: string, after = ""): Rule {
  return {
    find: new RegExp(`${NOT_AFTER_WORD}${word}${NOT_BEFORE_WORD}${NOT_ENDING}${after},?`, "giu"),
    replace: "",
  };
}

const CONCISE: Rule[] = [
  ...rules([
    ["please be advised that", ""],
    ["it is important to note that", ""],
    ["i am writing to let you know that", ""],
    ["i just wanted to let you know that", ""],
    ["i wanted to let you know that", ""],
    ["in order to", "to"],
    ["so as to", "to"],
    ["due to the fact that", "because"],
    ["owing to the fact that", "because"],
    ["in light of the fact that", "because"],
    ["despite the fact that", "although"],
    ["in spite of the fact that", "although"],
    ["at this point in time", "now"],
    ["at the present time", "now"],
    ["at this moment in time", "now"],
    ["in the near future", "soon"],
    ["in the event that", "if"],
    ["with regard to", "about"],
    ["with regards to", "about"],
    ["in regard to", "about"],
    ["in regards to", "about"],
    ["a large number of", "many"],
    ["a significant number of", "many"],
    ["the majority of", "most"],
    ["is able to", "can"],
    ["are able to", "can"],
    ["has the ability to", "can"],
    ["have the ability to", "can"],
    ["make a decision", "decide"],
    ["made a decision", "decided"],
    ["come to a conclusion", "conclude"],
    ["give consideration to", "consider"],
    ["each and every", "every"],
    ["first and foremost", "first"],
    ["until such time as", "until"],
    ["prior to", "before"],
    ["subsequent to", "after"],
    ["in close proximity to", "near"],
    ["on a daily basis", "daily"],
    ["on a weekly basis", "weekly"],
    ["on a monthly basis", "monthly"],
    ["on a regular basis", "regularly"],
    ["at all times", "always"],
    ["past history", "history"],
    ["end result", "result"],
    ["final outcome", "outcome"],
    ["advance planning", "planning"],
    ["basic fundamentals", "fundamentals"],
    ["completely eliminate", "eliminate"],
    ["revert back", "revert"],
    ["return back", "return"],
    ["repeat again", "repeat"],
  ]),
  filler("basically"),
  filler("literally"),
  filler("actually"),
  filler("totally"),
  filler("honestly"),
  filler("really"),
  // "very much" and "very well" mean something; "not just" too; "quite a few" isn't "a few".
  filler("very", "(?![ \\t]+(?:much|well)\\b)"),
  { ...filler("just"), find: new RegExp(`(?<!\\bnot[ \\t]+)${filler("just").find.source}`, "giu") },
  filler("quite", "(?![ \\t]+a\\b)"),
];

const RULES: Record<Tone, Rule[]> = {
  professional: PROFESSIONAL,
  friendly: FRIENDLY,
  concise: CONCISE,
};

/* ------------------------------ protection ------------------------------- */

/** Never rewritten: code, links, email addresses, @mentions, #tags, file names, paths, snake_case. */
const PROTECTED =
  /`[^`\n]*`|\b(?:https?:\/\/|www\.)[^\s<>"'`]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\p{L}\p{N}_])[@#][\p{L}\p{N}_-]+|[\p{L}\p{N}_-]*\p{L}[\p{L}\p{N}_-]*(?:[./\\][\p{L}\p{N}_-]+)+|\b\w+_\w+\b/giu;
/** Shorthand that looks like a path but isn't: "w/o", "b/c". */
const SLASH_SHORTHAND = /^\p{L}\/\p{L}?$/u;

const OPEN = "\uE000";
const CLOSE = "\uE001";
/** Marks where a removed phrase started a sentence: the next letter gets capitalized. */
const CAPITAL = "\uE002";

function protect(text: string): { masked: string; kept: string[] } {
  const kept: string[] = [];
  const masked = text.replace(PROTECTED, (match) => {
    if (SLASH_SHORTHAND.test(match)) return match;
    kept.push(match);
    return `${OPEN}${kept.length - 1}${CLOSE}`;
  });
  return { masked, kept };
}

function restore(text: string, kept: readonly string[]): string {
  return text.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_, i: string) => kept[Number(i)] ?? "");
}

function atSentenceStart(text: string, offset: number): boolean {
  return /(?:^|[.!?][ \t]+|\n[ \t]*)$/.test(text.slice(0, offset));
}

/**
 * The replacement in the match's case: capitalized where the match was
 * ("Gonna" → "Going to"), but an all-capitals abbreviation mid-sentence
 * becomes lowercase ("send it ASAP" → "send it as soon as possible").
 */
function withCase(match: string, replacement: string, sentenceStart: boolean): string {
  const first = match.charAt(0);
  const capital = first !== first.toLowerCase();
  const shouting = match.length > 1 && match === match.toUpperCase() && /\p{L}{2}/u.test(match);
  if (capital && (!shouting || sentenceStart)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Applies `rules`; returns null when none of them matched. */
function applyRules(text: string, list: readonly Rule[]): string | null {
  let out = text;
  let matched = false;
  for (const { find, replace } of list) {
    out = out.replace(find, (match: string, ...args: unknown[]) => {
      matched = true;
      const offset = args.find((arg): arg is number => typeof arg === "number") ?? 0;
      const whole = args.find((arg): arg is string => typeof arg === "string") ?? "";
      const start = atSentenceStart(whole, offset);
      if (replace === "") return start ? CAPITAL : "";
      return withCase(match, replace, start);
    });
  }
  return matched ? out : null;
}

/** Tidy what removals and replacements leave behind; line breaks and indentation stay. */
function tidy(text: string): string {
  return text
    .replace(new RegExp(`${CAPITAL}[ \\t,]*(\\p{Ll})`, "gu"), (_, letter: string) => letter.toUpperCase())
    .replace(new RegExp(`${CAPITAL}[ \\t,]*`, "g"), "")
    .replace(/(?<=\S)[ \t]{2,}(?=\S)/g, " ")
    .replace(/(?<=\S)[ \t]+(?=[,.;:!?](?:\s|$))/g, "")
    .replace(/,(?:[ \t]*,)+/g, ",")
    .replace(/(?<=\S)[ \t]+$/gm, "");
}

/**
 * `text` rewritten in `tone`. Returns the very same string when the tone
 * has nothing to change.
 */
export function rewrite(text: string, tone: Tone): string {
  if (!text.trim()) return text;
  const { masked, kept } = protect(text);
  const changed = applyRules(masked, RULES[tone]);
  if (changed === null) return text;
  const rewritten = restore(tidy(changed), kept);
  return rewritten === text ? text : rewritten;
}
