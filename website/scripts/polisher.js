/* ============================================================
   CoreTools — Sentence Polisher engine
   ------------------------------------------------------------
   Deterministic, rule-based text rewriting in three styles:
   "professional", "genz", and "complete". Pure functions, zero
   dependencies, and 100% local — nothing the user types is ever
   sent anywhere (there is no network code on this site at all).
   ============================================================ */
(function () {
  "use strict";

  /* ------------------------- helpers ------------------------- */

  function normalize(text) {
    return String(text || "")
      .replace(/’/g, "'") // curly → straight apostrophe
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Capitalize the first letter of every sentence. */
  function sentenceCase(text) {
    return text.replace(/(^|[.!?]\s+)([a-z])/g, function (_, pre, ch) {
      return pre + ch.toUpperCase();
    });
  }

  /** Ensure the text ends with terminal punctuation. */
  function ensureEnd(text) {
    if (!text) return text;
    return /[.!?…]$/.test(text) ? text : text + ".";
  }

  /** Collapse repeated punctuation ("!!", "??", "..") to one mark. */
  function tidyPunctuation(text) {
    return text
      .replace(/([!?])\1+/g, "$1")
      .replace(/\.{2,}/g, ".")
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/,([^\s\d])/g, ", $1");
  }

  /**
   * Apply an ordered list of [pattern, replacement] word rules with word
   * boundaries and first-letter case preservation. Longer (multi-word)
   * patterns must come first in the list.
   */
  function applyRules(text, rules) {
    var out = text;
    rules.forEach(function (rule) {
      var pattern = rule[0];
      var replacement = rule[1];
      var re = new RegExp("\\b" + pattern + "\\b", "gi");
      out = out.replace(re, function (match) {
        // Preserve a leading capital (e.g. sentence starts).
        if (match.charAt(0) === match.charAt(0).toUpperCase()) {
          return replacement.charAt(0).toUpperCase() + replacement.slice(1);
        }
        return replacement;
      });
    });
    return out;
  }

  /* ---------------------- shared word maps ---------------------- */

  // Standalone "i" → "I" (all modes except genz, which lowercases anyway).
  function fixI(text) {
    return text.replace(/\bi\b/g, "I");
  }

  var EXPAND_CONTRACTIONS = [
    ["can't", "cannot"],
    ["won't", "will not"],
    ["shan't", "shall not"],
    ["n't", " not"], // don't, isn't, wasn't, couldn't… (after specials above)
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

  var TXT_SPEAK = [
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

  /* ------------------------ PROFESSIONAL ------------------------ */

  var PRO_FILLERS =
    /\b(just|basically|literally|really|very|super|totally|honestly,?|you know,?|i mean,?|like,)\s+/gi;

  /**
   * Common "its" typo → "it is" when followed by a word that can't follow the
   * possessive (articles, intensifiers, negation). Real possessives ("its
   * color") are left untouched.
   */
  function fixItsTypo(text) {
    return text.replace(
      /\bits\b(?=\s+(?:a|an|the|so|too|very|really|quite|not|going|just)\b)/gi,
      "it is"
    );
  }

  var PRO_RULES = [
    // multi-word first
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
    // single words
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

  function polishProfessional(text) {
    // Fix the "its" typo before filler removal can hide the tell-tale adverb.
    var t = fixItsTypo(normalize(text)).replace(PRO_FILLERS, "");
    t = applyRules(t, TXT_SPEAK);
    t = applyRules(t, EXPAND_CONTRACTIONS);
    t = applyRules(t, PRO_RULES);
    // Mid-sentence "but" reads better as a parenthetical "however".
    t = t.replace(/\s+but\s+/gi, ", however, ").replace(/,\s*,/g, ",");
    // Sentence-opening casual conjunctions.
    t = t.replace(/(^|[.!?]\s+)(but|and|so)\b,?\s*/gi, function (_, pre, word) {
      var map = { but: "However, ", and: "Additionally, ", so: "Therefore, " };
      return pre + map[word.toLowerCase()];
    });
    t = fixI(t);
    t = tidyPunctuation(t);
    t = sentenceCase(t);
    return ensureEnd(t);
  }

  /* --------------------------- GEN Z ---------------------------- */

  var GENZ_RULES = [
    // multi-word first
    ["very good", "straight fire"],
    ["to be honest", "ngl"],
    ["i agree", "bet"],
    ["no problem", "say less"],
    ["i understand", "i get it"],
    ["the best", "the goat"],
    // single words
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

  var CONTRACT = [
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

  function polishGenZ(text) {
    var t = normalize(text);
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

  /* -------------------------- COMPLETE -------------------------- */

  var COMPLETE_RULES = [
    ["info", "information"],
    ["docs", "documentation"],
    ["specs", "specifications"],
    ["etc", "and so on"],
    ["stuff", "details"],
    ["w/", "with"],
    ["b/c", "because"],
    ["esp", "especially"],
  ];

  function polishComplete(text) {
    var t = normalize(text);
    t = applyRules(t, TXT_SPEAK);
    t = fixItsTypo(t);
    t = applyRules(t, EXPAND_CONTRACTIONS);
    t = applyRules(t, COMPLETE_RULES);
    t = fixI(t);
    t = tidyPunctuation(t);
    t = sentenceCase(t);
    return ensureEnd(t);
  }

  /* --------------------------- export ---------------------------- */

  window.CoreToolsPolisher = {
    /**
     * Rewrite `text` in the given style.
     * @param {string} text
     * @param {"professional"|"genz"|"complete"} mode
     * @returns {string}
     */
    polish: function (text, mode) {
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
    },
  };
})();
