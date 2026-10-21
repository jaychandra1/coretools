/**
 * Verifies in-app update signatures (audit S-2) the way installed copies do.
 *
 *   node scripts/verify-update-signature.mjs --pubkey "$TAURI_UPDATER_PUBKEY" \
 *     --version 1.2.7 <file> [<file> ...]
 *
 *   node scripts/verify-update-signature.mjs --pubkey "$TAURI_UPDATER_PUBKEY" --check-key
 *     only checks that the public key is well-formed and prints its key ID
 *     (release.yml's quality job, so a malformed key fails in seconds rather
 *     than after the builds compiled it in).
 *
 * Each <file> needs `<file>.sig` beside it, as written by
 * `tauri signer sign`: base64 of a minisign signature file whose trusted
 * comment is `timestamp:<unix>\tfile:<signed file name>`. For every file this
 * checks that
 *   - the signature was made by the key whose PUBLIC half release builds
 *     compile in (`--pubkey`: the base64 text Tauri expects in
 *     plugins.updater.pubkey, i.e. the contents of the `.key.pub` file) —
 *     a private key that doesn't match it would publish updates no installed
 *     copy can verify;
 *   - the file's bytes match (minisign Ed25519 over BLAKE2b-512);
 *   - the trusted comment is authentic and names this file, and that name
 *     carries `_<version>_` — installed copies refuse a signed name without it,
 *     so an old signed file can't be replayed as a newer version.
 *
 * Exit status 1 on any failure. Dependency-free (Node's crypto only), so the
 * job holding the private key runs no extra packages for it. The helpers are
 * exported for scripts/updater-manifest.mjs and scripts/release-canary.mjs.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** The base64 payload line of a minisign text block (skips comment lines). */
function payloadLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Tauri's base64-wrapped minisign public key → { keyId, key }. */
export function parsePublicKey(base64Text) {
  const text = Buffer.from(String(base64Text).trim(), "base64").toString("utf8");
  const line = payloadLines(text).find((l) => !l.startsWith("untrusted comment:"));
  const raw = line ? Buffer.from(line, "base64") : Buffer.alloc(0);
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("the public key isn't a Tauri/minisign Ed25519 public key (expected the base64 contents of the .key.pub file)");
  }
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw.subarray(10)]);
  return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: spki, format: "der", type: "spki" }) };
}

/** A minisign key ID as minisign prints it (hex, most significant byte first). */
export function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/** Tauri's base64-wrapped minisign signature file → its parts. */
export function parseSignature(base64Text) {
  const text = Buffer.from(String(base64Text).trim(), "base64").toString("utf8");
  const lines = payloadLines(text);
  if (lines.length < 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith("trusted comment: ")) {
    throw new Error("not a minisign signature file");
  }
  const sig = Buffer.from(lines[1], "base64");
  const globalSig = Buffer.from(lines[3], "base64");
  if (sig.length !== 74 || globalSig.length !== 64) throw new Error("malformed minisign signature");
  const algorithm = sig.subarray(0, 2).toString("latin1");
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error(`unknown signature algorithm "${algorithm}"`);
  return {
    algorithm, // "ED" = prehashed (BLAKE2b-512), what Tauri writes; "Ed" = legacy
    keyId: sig.subarray(2, 10),
    signature: sig.subarray(10),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature: globalSig,
  };
}

/** The `file:` value of a trusted comment ("timestamp:…\tfile:…"), or "". */
export function trustedFileName(trustedComment) {
  for (const part of trustedComment.split("\t")) {
    if (part.startsWith("file:")) return part.slice("file:".length);
  }
  return "";
}

/** The signed file name inside a Tauri `.sig` (base64 text), or "" if unreadable. */
export function signedFileName(base64Text) {
  try {
    return trustedFileName(parseSignature(base64Text).trustedComment);
  } catch {
    return "";
  }
}

/** Installed copies accept only signed names that carry `_<version>_`. */
export function nameCarriesVersion(name, version) {
  return name.includes(`_${version}_`);
}

async function blake2b512(path) {
  const hash = createHash("blake2b512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest();
}

/** Throws with a reason unless `path` + `path.sig` verify against `publicKey` for `version`. */
export async function verifyFile(path, publicKey, version) {
  const sigPath = `${path}.sig`;
  if (!existsSync(path)) throw new Error("file not found");
  if (!existsSync(sigPath)) throw new Error(`no signature (${basename(sigPath)})`);
  const sig = parseSignature(readFileSync(sigPath, "utf8"));
  if (!sig.keyId.equals(publicKey.keyId)) {
    throw new Error(
      `signed with key ${keyIdHex(sig.keyId)}, but the app trusts ` +
        `${keyIdHex(publicKey.keyId)} — TAURI_SIGNING_PRIVATE_KEY and TAURI_UPDATER_PUBKEY are not a pair`,
    );
  }
  const message = sig.algorithm === "ED" ? await blake2b512(path) : readFileSync(path);
  if (!verify(null, message, publicKey.key, sig.signature)) throw new Error("signature does not match the file's contents");
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!verify(null, global, publicKey.key, sig.globalSignature)) throw new Error("trusted comment signature is invalid");
  const name = trustedFileName(sig.trustedComment);
  if (name !== basename(path)) throw new Error(`the signature names "${name}", not ${basename(path)}`);
  if (!nameCarriesVersion(name, version)) throw new Error(`the signed name "${name}" doesn't carry _${version}_`);
  return name;
}

async function main() {
  const argv = process.argv.slice(2);
  const files = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pubkey" || argv[i] === "--version") opts[argv[i].slice(2)] = argv[++i];
    else if (argv[i] === "--check-key") opts.checkKey = true;
    else files.push(argv[i]);
  }
  const error = (message) => console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `verify-update-signature: ${message}`);
  const checkKeyOnly = opts.checkKey && !opts.version && files.length === 0;
  if (!opts.pubkey || (!checkKeyOnly && (!opts.version || files.length === 0))) {
    error("usage: --pubkey <base64 public key> (--version <x.y.z> <file> [<file> ...] | --check-key)");
    process.exit(1);
  }
  let publicKey;
  try {
    publicKey = parsePublicKey(opts.pubkey);
  } catch (e) {
    error(`TAURI_UPDATER_PUBKEY: ${e.message}`);
    process.exit(1);
  }
  if (checkKeyOnly) {
    console.log(`OK  public key ${keyIdHex(publicKey.keyId)}`);
    process.exit(0);
  }
  let failed = false;
  for (const file of files) {
    try {
      const name = await verifyFile(file, publicKey, opts.version);
      console.log(`OK  ${basename(file)}  (signed as ${name})`);
    } catch (e) {
      failed = true;
      error(`${basename(file)}: ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
