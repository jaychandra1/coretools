/**
 * Strong password generator and a rough strength estimate.
 *
 * Uses crypto.getRandomValues with rejection sampling, so every character is
 * uniformly distributed (no modulo bias). Look-alike characters (O/0, l/1/I)
 * are left out so generated passwords are easy to read back.
 */

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";

function randomIndex(max: number): number {
  // Largest multiple of `max` below 2^32: values above it are rejected.
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % max;
  }
}

export function generatePassword(length = 20, symbols = true): string {
  const sets = symbols ? [LOWER, UPPER, DIGITS, SYMBOLS] : [LOWER, UPPER, DIGITS];
  const size = Math.max(length, sets.length);
  const all = sets.join("");
  // One character from every set, the rest from the union, then shuffle.
  const chars = sets.map((set) => set[randomIndex(set.length)]);
  while (chars.length < size) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export type Strength = "empty" | "weak" | "fair" | "good" | "strong";

/** Charset-size × length estimate in bits; deliberately simple and conservative. */
export function passwordStrength(password: string): { strength: Strength; bits: number } {
  if (!password) return { strength: "empty", bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 32;
  // Repeated characters add little entropy.
  const unique = new Set(password).size;
  const bits = Math.round(Math.log2(Math.max(pool, 2)) * Math.min(password.length, unique * 2));
  const strength: Strength =
    bits < 40 ? "weak" : bits < 60 ? "fair" : bits < 80 ? "good" : "strong";
  return { strength, bits };
}
