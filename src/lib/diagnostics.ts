import { getPlatform } from "./platform";

/** How many recent failures this session keeps in memory. */
const SESSION_LIMIT = 100;
const session: string[] = [];

/**
 * Record a failure the app recovered from, so "Copy diagnostics" can explain
 * it later: in the local diagnostics log on the desktop, and in memory for
 * this session everywhere (the browser build has no log file). The cause is
 * a fixed token chosen by the caller plus the error's class
 * (QuotaExceededError, OperationError…) — never its message, which can carry
 * account names, paths or file content.
 *
 * The rule for `catch` blocks: recover and note it here, or rethrow.
 */
export function noteFailure(source: string, token: string, error?: unknown): void {
  const kind = error instanceof Error && error.name !== "Error" ? ` (${error.name})` : "";
  session.push(`${new Date().toISOString()} ${source}: ${token}${kind}`);
  if (session.length > SESSION_LIMIT) session.shift();
  void getPlatform()
    .diagnostics?.record(source, token + kind)
    .catch(() => {}); // the log itself is best effort
}

/** This session's recorded failures, oldest first (the browser's diagnostics). */
export function sessionFailures(): string {
  return session.join("\n");
}
