/**
 * Password-based key derivation for the vault (audit F-06).
 *
 * New vaults use **Argon2id** (memory-hard, so GPU/ASIC guessing of a stolen
 * backup costs ~64 MiB per guess) through hash-wasm's WebAssembly build.
 * PBKDF2-SHA256 remains only to open vaults and backups made before 1.2.
 *
 * The derived bytes are never the data key itself any more: they form a
 * key-encryption key (KEK) that wraps a random data key (see vault-keys.ts).
 * That is what lets an old vault move to Argon2id without re-encrypting
 * anything, and keeps Windows Hello working across the upgrade.
 */

import { argon2id } from "hash-wasm";
import { base64ToBytes } from "./legacy-crypto";

export interface Pbkdf2Params {
  name: "PBKDF2-SHA256";
  iterations: number;
}

export interface Argon2idParams {
  name: "Argon2id";
  /** Memory cost in KiB. */
  memoryKiB: number;
  /** Time cost (passes over memory). */
  iterations: number;
  /** Lanes. The WebAssembly build is single-threaded, so lanes add memory, not speed. */
  parallelism: number;
}

export type KdfParams = Pbkdf2Params | Argon2idParams;

/**
 * Default for new vaults: 64 MiB, 3 passes, 1 lane — the same order as
 * mainstream password managers. Roughly 0.2–0.6 s per unlock on a laptop.
 */
export const DEFAULT_KDF: Argon2idParams = {
  name: "Argon2id",
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
};

/** The only PBKDF2 work factor this app ever wrote. */
export const LEGACY_PBKDF2_ITERATIONS = 310_000;

/**
 * Bounds on parameters read from a stored vault or a downloaded backup. A
 * tampered header must not be able to make unlock spin for minutes or
 * allocate gigabytes (DoS), nor downgrade to a trivially guessable setting.
 */
const BOUNDS = {
  pbkdf2Iterations: [100_000, 5_000_000],
  argonMemoryKiB: [19 * 1024, 1024 * 1024],
  argonIterations: [1, 10],
  argonParallelism: [1, 8],
} as const;

function within(value: unknown, [min, max]: readonly [number, number]): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Parse KDF parameters from untrusted JSON; null when missing or out of bounds. */
export function parseKdf(raw: unknown): KdfParams | null {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (p.name === "PBKDF2-SHA256") {
    return within(p.iterations, BOUNDS.pbkdf2Iterations)
      ? { name: "PBKDF2-SHA256", iterations: p.iterations }
      : null;
  }
  if (p.name === "Argon2id") {
    return within(p.memoryKiB, BOUNDS.argonMemoryKiB) &&
      within(p.iterations, BOUNDS.argonIterations) &&
      within(p.parallelism, BOUNDS.argonParallelism)
      ? {
          name: "Argon2id",
          memoryKiB: p.memoryKiB,
          iterations: p.iterations,
          parallelism: p.parallelism,
        }
      : null;
  }
  return null;
}

/** 32 key bytes from a password. The caller zeroes them when done. */
export async function deriveKeyBytes(
  password: string,
  saltB64: string,
  params: KdfParams,
): Promise<Uint8Array> {
  const salt = base64ToBytes(saltB64);
  if (params.name === "Argon2id") {
    return argon2id({
      password: new TextEncoder().encode(password),
      salt,
      memorySize: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism,
      hashLength: 32,
      outputType: "binary",
    });
  }
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: params.iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** Human summary for diagnostics and docs ("Argon2id 64 MiB × 3"). */
export function describeKdf(params: KdfParams): string {
  return params.name === "Argon2id"
    ? `Argon2id ${Math.round(params.memoryKiB / 1024)} MiB × ${params.iterations}`
    : `PBKDF2-SHA256 × ${params.iterations.toLocaleString("en-US")}`;
}
