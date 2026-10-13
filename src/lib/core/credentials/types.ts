/**
 * Credential Manager data model.
 *
 * Credentials live in the SAME vault as the Authenticator: one master
 * password (and optional Windows Hello unlock), one AES-256-GCM key. Searchable
 * metadata (platform, URL, username, category, owner, tags) is stored in the
 * clear — the same model as authenticator entries — while the password and
 * the notes are always encrypted. There is no unencrypted mode.
 */

import type { EncryptedBlob } from "../authenticator/vault-crypto";

/** The searchable, non-secret part of a credential. */
export interface CredentialFields {
  platform: string;
  /** Login URL (normalized http/https) or "". */
  url: string;
  username: string;
  /** Single category such as "Cloud" or "Banking"; "" when unset. */
  category: string;
  /** Free-text owner (person/team the login belongs to); "" when unset. */
  owner: string;
  tags: string[];
}

/** As persisted in IndexedDB. */
export interface StoredCredential extends CredentialFields {
  id: string;
  password: EncryptedBlob;
  /** Encrypted notes, or null when there are none. */
  notes: EncryptedBlob | null;
  createdAt: number;
  updatedAt: number;
  passwordUpdatedAt: number;
  /** Set while the credential sits in the trash (soft delete). */
  deletedAt: number | null;
}

/** Plaintext form carried inside the (encrypted) cloud backup payload. */
export interface BackupCredential extends CredentialFields {
  password: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
  passwordUpdatedAt: number;
  deletedAt: number | null;
}

export type AuditAction =
  | "created"
  | "updated"
  | "password-changed"
  | "deleted"
  | "restored"
  | "purged"
  | "revealed"
  | "copied-password"
  | "restored-from-backup";

/** One audit-log record. Never contains a secret. */
export interface AuditEvent {
  id: string;
  at: number;
  action: AuditAction;
  credentialId: string;
  platform: string;
}

/** Trashed credentials are purged automatically after this long. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Oldest audit events are dropped beyond this many. */
export const AUDIT_LIMIT = 2000;

/** Identity used to avoid duplicates on restore: platform + URL + username. */
export function credentialKey(c: Pick<CredentialFields, "platform" | "url" | "username">): string {
  return [c.platform, c.url, c.username].map((s) => s.trim().toLowerCase()).join(" ");
}
