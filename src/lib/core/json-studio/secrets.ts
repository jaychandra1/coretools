/**
 * Spotting credentials in a document before it is autosaved (audit F-15).
 *
 * JSON-Studio keeps an unencrypted recovery copy of the working document so
 * a reload doesn't lose work. API responses and config files pasted in for
 * formatting often carry tokens and keys, which would then sit on disk
 * indefinitely. When a document matches one of these patterns the recovery
 * copy is skipped (and any old one deleted). False positives only cost the
 * convenience of recovery; false negatives are bounded by the 24-hour expiry.
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
    /"(?:password|passwd|pwd|secret|client_secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key)"\s*:\s*"[^"\s]{6,}"/i,
  ],
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
