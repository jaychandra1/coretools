/**
 * Master-password policy (audit F-06): at least 12 characters and a strength
 * estimate that rejects common, repetitive and keyboard-walk passwords.
 *
 * The estimate is deliberately simple and dependency-free (no 800 KB
 * dictionary): it scores the effective character pool and length, then
 * subtracts for patterns attackers try first. It errs on the side of
 * "fair" — it is a guard rail, not a guarantee. Passphrases of four or more
 * ordinary words score well, as they should.
 */

export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordAssessment {
  /** 0 very weak … 4 strong. */
  score: 0 | 1 | 2 | 3 | 4;
  /** Rough guessing entropy in bits after pattern penalties. */
  bits: number;
  /** Acceptable as a master password. */
  ok: boolean;
  /** One short reason when not ok (or a tip when merely fair). */
  message: string;
}

/** Passwords and fragments that appear at the top of every breach list. */
const COMMON = [
  "password", "passw0rd", "p@ssword", "qwerty", "qwertz", "azerty", "letmein", "welcome",
  "admin", "administrator", "login", "iloveyou", "monkey", "dragon", "football", "baseball",
  "master", "shadow", "sunshine", "princess", "trustno1", "superman", "batman", "starwars",
  "whatever", "freedom", "secret", "abc123", "111111", "123123", "000000", "654321",
  "changeme", "default", "coretools", "authenticator", "google", "summer", "winter",
  "spring", "autumn", "january", "december",
];

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "0987654321"];

function poolSize(password: string): number {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[ ]/.test(password)) pool += 1;
  if (/[^a-zA-Z0-9 ]/.test(password)) pool += 33;
  return Math.max(pool, 1);
}

/** Characters that continue a run (aaaa, abcd, 4321, qwer) count for little. */
function patternPenalty(password: string): number {
  const lower = password.toLowerCase();
  let penalty = 0;
  let run = 0;
  for (let i = 1; i < lower.length; i++) {
    const a = lower.charCodeAt(i - 1);
    const b = lower.charCodeAt(i);
    const pair = lower.slice(i - 1, i + 1);
    const sequential =
      a === b ||
      Math.abs(a - b) === 1 ||
      KEYBOARD_ROWS.some((row) => row.includes(pair) || row.includes([...pair].reverse().join("")));
    run = sequential ? run + 1 : 0;
    if (run >= 2) penalty += 1;
  }
  return penalty;
}

export function assessPassword(password: string): PasswordAssessment {
  const length = [...password].length;
  const perChar = Math.log2(poolSize(password));
  const effectiveLength = Math.max(0, length - patternPenalty(password));
  let bits = effectiveLength * perChar;

  const lower = password.toLowerCase();
  const common = COMMON.find((word) => lower.includes(word));
  if (common) {
    // The common word is guessed as one token; only the rest adds entropy.
    bits = Math.max(0, bits - (common.length - 1) * perChar);
  }
  // A password that is just one character class repeated in a short loop.
  if (new Set(lower).size <= 3) bits = Math.min(bits, 20);

  const score: PasswordAssessment["score"] =
    bits < 28 ? 0 : bits < 45 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;

  // A common word inside a long passphrase is fine — its entropy was already
  // discounted above; it only blocks when what's left is too little.
  const ok = length >= MIN_PASSWORD_LENGTH && score >= 2;
  let message = "";
  if (length < MIN_PASSWORD_LENGTH) {
    message = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  } else if (!ok && common) {
    message = `Too guessable — “${common}” is one of the first words attackers try.`;
  } else if (!ok) {
    message = "Too predictable — avoid repeats, sequences and keyboard patterns.";
  } else if (score === 2) {
    message = "Fair. A longer passphrase of several unrelated words is stronger.";
  }
  return { score, bits: Math.round(bits), ok, message };
}
