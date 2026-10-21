/**
 * Spotting credentials in a document before it is autosaved (audit F-15).
 *
 * JSON-Studio keeps an unencrypted recovery copy of the working document so
 * a reload doesn't lose work. API responses and config files pasted in for
 * formatting often carry tokens and keys, which would then sit on disk
 * indefinitely. When a document matches one of these patterns the recovery
 * copy is skipped (and any old one deleted). False positives only cost the
 * convenience of recovery; false negatives are bounded by the 24-hour expiry.
 *
 * Every repetition that can backtrack is bounded, so a scan stays linear in
 * the document's size whatever it contains (N9: an unbounded scheme or name
 * run made a long "a.a.a…" line quadratic).
 */

const PATTERNS: Array<[label: string, pattern: RegExp]> = [
  ["a private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["a Stripe secret key", /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/],
  ["a JSON Web Token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  [
    "a password or token field",
    /"(?:password|passwd|pwd|secret|client_secret|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key)"\s*:\s*"[^"\s]{6,}"/i,
  ],
  // YAML, .env and ini style: password: hunter22 / API_KEY=abc123… (L6)
  [
    "a password or token setting",
    /^[ \t-]{0,32}["']?[\w.-]{0,64}(?:password|passwd|pwd|secret|api[_-]?key|token|private[_-]?key)["']?[ \t]{0,16}[:=][ \t]{0,16}["']?[^\s"'#]{6}/im,
  ],
  ["credentials in a URL", /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,256}:[^\s/@]{3,256}@/i],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
  ["an API secret key", /\bsk-[A-Za-z0-9_-]{20,}/],
];

/** What kind of credential the text seems to contain, or null. */
export function findSecret(...texts: string[]): string | null {
  for (const text of texts) {
    if (!text) continue;
    for (const [label, pattern] of PATTERNS) {
      if (pattern.test(text)) return label;
    }
  }
  return null;
}
