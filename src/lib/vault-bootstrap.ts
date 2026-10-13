/**
 * Wires every vault collection to the vault before anything else runs
 * (audit F-18). Called once from main.ts, before the app mounts.
 *
 * Collections used to register themselves as a side effect of being
 * imported, so vault correctness depended on which modules the UI happened
 * to import. Registration is explicit now — and the vault additionally
 * refuses to re-key while stored credentials exist that no registered
 * collection could re-encrypt.
 */

import { authStore } from "./components/authenticator/store.svelte";
import { credentialStore } from "./components/credentials/credentials.svelte";

let done = false;

export function bootstrapVault(): void {
  if (done) return;
  done = true;
  authStore.registerCredentials(credentialStore.vaultHooks());
}
