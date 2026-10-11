/**
 * Cloud backup policy: naming, version retention, multi-device conflict
 * detection, retry back-off, error classification and the backup routine
 * itself — all framework-free and transport-agnostic so it is unit-tested
 * against a fake transport.
 *
 * Model: this is a BACKUP, not a live sync. Every backup is a new immutable
 * version file; the newest `MAX_VERSIONS` are kept for rollback. A device
 * remembers which remote version its data is based on
 * (`lastSyncedRemoteId`). If the newest remote version came from ANOTHER
 * device and isn't the one we're based on, uploading would silently bury
 * that device's changes under ours — so the routine stops and reports a
 * conflict for the user to resolve (merge, or keep this device's data).
 */

import { md5 } from "./md5";

export const BACKUP_FILE_PREFIX = "coretools-authenticator-";
export const MAX_VERSIONS = 10;

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

/** e.g. coretools-authenticator-20261011T103000123Z-1a2b3c4d.json */
export function backupFileName(date: Date, deviceId: string): string {
  const stamp = date.toISOString().replace(/[-:.]/g, "");
  const device = deviceId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "device";
  return `${BACKUP_FILE_PREFIX}${stamp}-${device}.json`;
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
  | { kind: "uploaded"; file: RemoteBackup; pruned: string[] }
  | { kind: "conflict"; remote: RemoteBackup };

export interface BackupRequest {
  transport: BackupTransport;
  /** Produce the sealed backup file (called only once we know it's safe). */
  seal: () => Promise<string>;
  deviceId: string;
  deviceLabel: string;
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
  const { transport } = request;
  const remote = await transport.list();

  if (!request.force) {
    const conflict = detectConflict(remote, request.lastSyncedRemoteId, request.deviceId);
    if (conflict) return { kind: "conflict", remote: conflict };
  }

  const content = await request.seal();
  const uploaded = await transport.upload({
    name: backupFileName(request.now ?? new Date(), request.deviceId),
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
  for (const id of pruned) {
    // Best effort: a failed prune only leaves an extra old version behind.
    await transport.remove(id).catch(() => {});
  }
  return { kind: "uploaded", file: uploaded, pruned };
}
