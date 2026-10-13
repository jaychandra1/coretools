# Runbook: Google Cloud project suspended or deleted

**Severity:** SEV2: backup and restore are down for every user. Raise to
SEV1 if the Google account that owns the project was compromised.

**Why it matters.** One Google Cloud project owns the OAuth client compiled
into every release (`CORETOOLS_GOOGLE_CLIENT_ID`) and the Drive API usage.
Each user's backups live in their Drive *appDataFolder*, which only OAuth
clients of **that project** can read. A replacement project can't read
them. Recovering the original project is worth far more than replacing it.

Local data is never affected: the Authenticator and Credential Manager keep
working offline. Only backup, restore and sign-in fail.

## Detection

- Email from Google to the project's Owners: suspension notice, or "project
  scheduled for deletion".
- Users report, all at once:
  - "Google sign-in isn't configured in this build of CoreTools" (the token
    endpoint answers `invalid_client`),
  - "Google access was revoked or has expired. Reconnect…", and reconnecting
    fails with a Google error page (`deleted_client`, `disabled_client`,
    "Access blocked"),
  - "Cloud backup failed. Try again." (an unrecognised 403 from a suspended
    project or disabled API).
- **The alert policies live in the same project.** A suspended or deleted
  project sends no alerts, so silence proves nothing.
- Check state directly:

  ```bash
  gcloud projects describe <project_id> --format="value(lifecycleState)"   # ACTIVE / DELETE_REQUESTED
  gcloud alpha resource-manager liens list --project <project_id>
  gcloud services list --enabled --project <project_id> | grep -E "drive|monitoring"
  ```

  In the console, also open **Google Auth Platform → Clients** and confirm
  the Desktop client whose id is in `CORETOOLS_GOOGLE_CLIENT_ID` exists.

## Immediate actions

1. **Don't create a replacement project yet.** A new project means a new
   client id, a new release, and every user's existing backups becoming
   unreachable.
2. **Project deleted (`DELETE_REQUESTED`, within 30 days):**

   ```bash
   gcloud projects undelete <project_id>
   ```

   The OAuth client, APIs and settings come back with the project. Then
   find out how it was deleted. The lien (F-24) should have blocked it, so
   someone removed the lien first. In Logs Explorer for the project:

   ```text
   protoPayload.methodName:("DeleteProject" OR "DeleteLien")
   ```

   If it wasn't you, treat the Google account as compromised: change its
   password, review 2-Step Verification and recovery options, sign out other
   sessions (Google Account → Security), and remove unknown members under
   IAM & Admin → IAM. Escalate to SEV1.
3. **Only the OAuth client is gone, project ACTIVE** (Google deletes clients
   with no token exchange for six months; or deleted by hand): Google Auth
   Platform → Clients → restore the deleted client. Restore keeps the same
   client id, so installed copies recover with no release. It's possible for
   30 days.
4. **Project suspended:** read the suspension email for the reason and the
   appeal link (also shown as a console banner). Fix what it cites (for
   example consent-screen details, privacy policy link, requested scopes,
   billing), then appeal through that link. Keep the project and its
   client untouched while the appeal is open.
5. **Unrecoverable** (past 30 days, or appeal refused). Only then:
   1. Create a new project. Set `project_id` in
      `infra/terraform/google/terraform.tfvars` to it and `terraform apply`
      (APIs, lien, alerts).
   2. Recreate the consent screen and Desktop client:
      `infra/terraform/README.md` → "Google OAuth consent screen and client".
   3. Update the `CORETOOLS_GOOGLE_CLIENT_ID` / `CORETOOLS_GOOGLE_CLIENT_SECRET`
      Actions secrets and cut a release: Actions → Prepare release → merge
      its pull request → approve the publish.
   4. Users install it and click *Connect Google Account* again. The first
      backup re-uploads everything from their device. Their old backups
      stay in their Drive's hidden app data, where nothing can read them.

## Verification

- `gcloud projects describe <project_id>` → `ACTIVE`; the lien is listed;
  `drive.googleapis.com` and `monitoring.googleapis.com` are enabled.
- `terraform plan` in `infra/terraform/google` shows no changes (or apply it
  to restore the lien and alerts).
- With a release build: connect, back up now, list versions, restore into a
  test profile. All succeed.
- APIs & Services → Google Drive API → Metrics shows 2xx traffic again
  (allow up to 30 minutes for metrics).

## Communication

- **Site banner** and a notice at the top of the `jaychandra1/artifacts`
  root README while it's down. Suggested text: "Google Drive backup in
  CoreTools is currently unavailable. Your accounts on this device are safe
  and codes keep working. Please don't wipe data or uninstall until backup
  is back."
- **Replacement project:** release notes for the new version say that
  users must reconnect, that old backups can't be restored by the new
  version, and to keep their local data (or export an encrypted backup:
  Authenticator → Export) before changing anything.
- A security advisory only if the account was compromised. The project
  owner can't read users' backups: Drive tokens live on users' devices,
  and the backups are end-to-end encrypted. State that.

## Follow-up

- Re-apply `infra/terraform/google` so the lien and alerts exist.
- Add a second Owner (another Google account you control, with 2-Step
  Verification) so one locked account can't strand the project.
- If a client was deleted for inactivity, find out why it saw no token
  exchanges for six months.
- Write the incident review (README.md → "After every incident").
