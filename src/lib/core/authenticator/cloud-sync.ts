/**
 * Cloud backup policy: naming, version retention, multi-device conflict
 * detection, retry back-off, error classification and the backup routine
 * itself — all framework-free and transport-agnostic so it is unit-tested
 * against a fake transport.
 *
 * Model: this is a BACKUP, not a live sync. Each module backs up as its own
 * series of immutable version files, named by kind:
 *   coretools-authenticator-<time>-<device>.json   2FA accounts + settings
 *   coretools-credmanager-<time>-<device>.json     Credential Manager logins
 * and the newest `MAX_VERSIONS` of EACH series are kept for rollback. A
 * device remembers, per series, which remote version its data is based on.
 * If the newest remote version came from ANOTHER device and isn't the one
 * we're based on, uploading would silently bury that device's changes under
 * ours — so the routine stops and reports a conflict for the user to resolve
 * (merge, or keep this device's data).
 */

import { md5 } from "./md5";

/** The two backup series. */
export type BackupKind = "authenticator" | "credmanager";

export const BACKUP_KINDS: readonly BackupKind[] = ["authenticator", "credmanager"];

export const BACKUP_PREFIXES: Readonly<Record<BackupKind, string>> = {
  authenticator: "coretools-authenticator-",
  credmanager: "coretools-credmanager-",
};

/** Human name of a series, for the UI. */
export const BACKUP_KIND_LABELS: Readonly<Record<BackupKind, string>> = {
  authenticator: "Authenticator",
  credmanager: "Credential Manager",
};

/** Versions kept per series. */
export const MAX_VERSIONS = 10;

/** Which series a backup file belongs to, by its name; null = not ours. */
export function backupKindOf(name: string): BackupKind | null {
  for (const kind of BACKUP_KINDS) {
    if (name.startsWith(BACKUP_PREFIXES[kind])) return kind;
  }
  return null;
}

export function ofKind(list: RemoteBackup[], kind: BackupKind): RemoteBackup[] {
  return list.filter((file) => backupKindOf(file.name) === kind);
}

/** A backup version as listed by the transport (no content). */
export interface RemoteBackup {
  id: string;
  name: string;
  /** RFC 3339 timestamp assigned by the provider. */
  createdTime: string;
  size: number;
  /** Provider-computed MD5 of the stored bytes (hex), "" if unknown. */
  md5Checksum: string;
  deviceId: string;
  deviceLabel: string;
}

/** The subset of the platform bridge the backup routine needs. */
export interface BackupTransport {
  list(): Promise<RemoteBackup[]>;
  upload(file: {
    name: string;
    content: string;
    deviceId: string;
    deviceLabel: string;
  }): Promise<RemoteBackup>;
  remove(id: string): Promise<void>;
}

/** e.g. coretools-credmanager-20261011T103000123Z-1a2b3c4d.json */
export function backupFileName(kind: BackupKind, date: Date, deviceId: string): string {
  const stamp = date.toISOString().replace(/[-:.]/g, "");
  const device = deviceId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "device";
  return `${BACKUP_PREFIXES[kind]}${stamp}-${device}.json`;
}

export function sortNewestFirst(list: RemoteBackup[]): RemoteBackup[] {
  return [...list].sort(
    (a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime) || b.name.localeCompare(a.name),
  );
}

/** Ids of every version beyond the newest `keep`. */
export function planPrune(list: RemoteBackup[], keep = MAX_VERSIONS): string[] {
  return sortNewestFirst(list)
    .slice(keep)
    .map((file) => file.id);
}

/**
 * The remote version that would be overwritten by uploading now, or null
 * when uploading is safe: nothing remote yet, the newest version is the one
 * this device is based on, or it was made by this device itself.
 */
export function detectConflict(
  list: RemoteBackup[],
  lastSyncedRemoteId: string | null,
  deviceId: string,
): RemoteBackup | null {
  const newest = sortNewestFirst(list)[0];
  if (!newest) return null;
  if (newest.id === lastSyncedRemoteId) return null;
  if (newest.deviceId === deviceId) return null;
  return newest;
}

/** Back-off between automatic retries: 15 s, 30 s, 1 m, 2 m, 5 m, 10 m, 15 m… */
export function retryDelayMs(attempt: number): number {
  const steps = [15, 30, 60, 120, 300, 600, 900];
  return steps[Math.min(Math.max(attempt, 0), steps.length - 1)] * 1000;
}

export function md5Hex(text: string): string {
  return [...md5(new TextEncoder().encode(text))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type CloudErrorKind =
  | "canceled"
  | "network"
  | "unavailable"
  | "auth"
  | "quota"
  | "not_found"
  | "not_configured"
  | "integrity"
  | "busy"
  | "other";

export interface CloudErrorInfo {
  kind: CloudErrorKind;
  message: string;
  /** Automatic backups should try again later. */
  retryable: boolean;
}

/** Raised by the backup routine itself (not the transport). */
export class CloudSyncError extends Error {
  constructor(
    readonly token: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudSyncError";
  }
}

/**
 * Map a failure — a Rust error token (Tauri rejects with plain strings) or
 * an Error — to a user-facing message. Never echoes raw provider responses.
 */
export function describeCloudError(error: unknown): CloudErrorInfo {
  const token =
    error instanceof CloudSyncError
      ? error.token
      : typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "";
  const code = token.split(":")[0].trim();

  switch (code) {
    case "oauth_canceled":
    case "hello_canceled":
      return { kind: "canceled", message: "", retryable: false };
    case "oauth_denied":
      return {
        kind: "canceled",
        message: "Google sign-in was canceled or access was denied.",
        retryable: false,
      };
    case "oauth_timeout":
      return {
        kind: "canceled",
        message: "Google sign-in timed out. Try again.",
        retryable: false,
      };
    case "oauth_no_refresh_token":
      return {
        kind: "auth",
        message:
          "Google didn't grant offline access. Remove CoreTools under your Google Account → Security → Third-party access, then connect again.",
        retryable: false,
      };
    case "oauth_scope_denied":
      return {
        kind: "auth",
        message:
          "CoreTools needs access to its own backup folder in your Google Drive. Connect again and leave that permission ticked.",
        retryable: false,
      };
    case "cloud_domain_policy":
      return {
        kind: "auth",
        message:
          "Your Google Workspace administrator doesn't allow CoreTools to use Google Drive. Ask them to allow it, or connect a personal Google account.",
        retryable: false,
      };
    case "cloud_keychain_unavailable":
      return {
        kind: "other",
        message: "Couldn't access the system keychain to store or read your Google sign-in.",
        retryable: false,
      };
    case "oauth_exchange_failed":
    case "oauth_listen_failed":
    case "oauth_browser_failed":
      return {
        kind: "other",
        message:
          code === "oauth_browser_failed"
            ? "Couldn't open your web browser for Google sign-in."
            : "Google sign-in failed. Try again.",
        retryable: false,
      };
    case "cloud_auth_revoked":
      return {
        kind: "auth",
        message: "Google access was revoked or has expired. Reconnect your Google account to resume backups.",
        retryable: false,
      };
    case "cloud_not_connected":
      return {
        kind: "auth",
        message: "No Google account is connected.",
        retryable: false,
      };
    case "cloud_network":
      return {
        kind: "network",
        message: "Can't reach Google Drive. Check your internet connection — backup will retry automatically.",
        retryable: true,
      };
    case "cloud_unavailable":
      return {
        kind: "unavailable",
        message: "Google Drive is temporarily unavailable — backup will retry automatically.",
        retryable: true,
      };
    case "cloud_quota":
      return {
        kind: "quota",
        message: "Your Google Drive storage is full. Free up space, then back up again.",
        retryable: false,
      };
    case "cloud_not_found":
      return {
        kind: "not_found",
        message: "That backup no longer exists in Google Drive.",
        retryable: false,
      };
    case "cloud_not_configured":
      return {
        kind: "not_configured",
        message: "Google sign-in isn't configured in this build of CoreTools.",
        retryable: false,
      };
    case "cloud_integrity":
      return {
        kind: "integrity",
        message: "The uploaded backup failed verification and was discarded — retrying.",
        retryable: true,
      };
    case "cloud_corrupt":
    case "cloud_too_large":
      return {
        kind: "integrity",
        message: "The backup file is damaged or too large to restore.",
        retryable: false,
      };
    case "cloud_busy":
      return {
        kind: "busy",
        message: "A Google sign-in is already in progress.",
        retryable: false,
      };
    default:
      return {
        kind: "other",
        message:
          error instanceof Error && !(error instanceof CloudSyncError) && error.message
            ? error.message
            : "Cloud backup failed. Try again.",
        retryable: false,
      };
  }
}

export type BackupOutcome =
  | {
      kind: "uploaded";
      file: RemoteBackup;
      pruned: string[];
      /** Versions remaining after this pass, newest first. */
      versions: RemoteBackup[];
    }
  | { kind: "conflict"; remote: RemoteBackup };

export interface BackupRequest {
  transport: BackupTransport;
  /** Which series this pass writes; other series are never touched. */
  series: BackupKind;
  /** Produce the sealed backup file (called only once we know it's safe). */
  seal: () => Promise<string>;
  deviceId: string;
  deviceLabel: string;
  /** The version of THIS series that the device's data is based on. */
  lastSyncedRemoteId: string | null;
  /** Upload even over another device's newer version (user chose "keep mine"). */
  force?: boolean;
  now?: Date;
}

/**
 * One backup pass: conflict check → seal → upload → verify → prune.
 *
 * Ordering guarantees: nothing is deleted until the new version is uploaded
 * AND its provider-side checksum matches what we sent, so an interruption at
 * any point leaves every previous version intact.
 */
export async function performBackup(request: BackupRequest): Promise<BackupOutcome> {
  const { transport, series } = request;
  const remote = ofKind(await transport.list(), series);

  if (!request.force) {
    const conflict = detectConflict(remote, request.lastSyncedRemoteId, request.deviceId);
    if (conflict) return { kind: "conflict", remote: conflict };
  }

  const content = await request.seal();
  const uploaded = await transport.upload({
    name: backupFileName(series, request.now ?? new Date(), request.deviceId),
    content,
    deviceId: request.deviceId,
    deviceLabel: request.deviceLabel,
  });

  if (uploaded.md5Checksum && uploaded.md5Checksum.toLowerCase() !== md5Hex(content)) {
    await transport.remove(uploaded.id).catch(() => {});
    throw new CloudSyncError("cloud_integrity", "Uploaded backup failed checksum verification");
  }

  // Retention never considers the version we just wrote for deletion.
  const others = remote.filter((file) => file.id !== uploaded.id);
  const pruned = planPrune(others, MAX_VERSIONS - 1);
  const removed = new Set<string>();
  for (const id of pruned) {
    // Best effort: a failed prune only leaves an extra old version behind.
    await transport
      .remove(id)
      .then(() => removed.add(id))
      .catch(() => {});
  }
  const versions = sortNewestFirst([
    uploaded,
    ...others.filter((file) => !removed.has(file.id)),
  ]);
  return { kind: "uploaded", file: uploaded, pruned, versions };
}
