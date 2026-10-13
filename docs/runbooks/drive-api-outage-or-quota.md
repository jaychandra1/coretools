# Runbook: Google Drive API outage or quota exhaustion

**Severity:** SEV3 by default: the app heals itself and local data is
unaffected. SEV2 if restores fail for many users for more than a day, or
the cause is a CoreTools bug that keeps hammering the API.

The alert policies from `infra/terraform/google` link here.

## What users see

- Automatic backups show *retrying* and try again after 15 s, 30 s, 1 min,
  2 min, 5 min, 10 min, then every 15 min, and immediately when the OS
  reports the network is back. Nothing is lost while they wait. Every
  earlier backup version stays intact.
- A manual *Back up now* or *Restore* shows "Google Drive is temporarily
  unavailable — backup will retry automatically." That message covers
  Google 5xx, 408, 429, and 403s whose reason is `rateLimitExceeded`,
  `userRateLimitExceeded` or `dailyLimitExceeded`
  (`src-tauri/src/cloud.rs` → `status_error`).
- Authenticator codes and the Credential Manager keep working. They never
  need the network.
- Not this runbook: "Your Google Drive storage is full" is one user's full
  Drive (`storageQuotaExceeded`). "Cloud backup failed. Try again." for
  everyone means an unrecognised 403, such as a disabled API or a suspended
  project ([that runbook](google-project-suspended-or-deleted.md)).

## Detection

- Alerts: *Drive API 5xx ratio*, *Drive API 403/429 ratio*, *Drive API quota
  usage* (> 70% of a per-minute limit), *Drive API quota exceeded*.
- Users report backups stuck on *retrying*.
- Google's status pages: [Google Workspace Status
  Dashboard](https://www.google.com/appsstatus/dashboard/) (Drive) and
  [Google Cloud Service Health](https://status.cloud.google.com/).

`api/request_count` data can arrive up to 30 minutes late. Alerts and
charts lag reality.

## What to check in Cloud Monitoring

In the production project:

1. **APIs & Services → Enabled APIs & services → Google Drive API →
   Metrics:** traffic by response code, errors by method, latency.
2. **IAM & Admin → Quotas & System Limits**, filter *Google Drive API*:
   current usage against each limit, and which limit is near.
3. **Monitoring → Alerting → Incidents:** which policy fired, since when.
4. **Metrics Explorer → PromQL**, for detail:

   ```promql
   # requests per response code, last 30 min
   sum by (response_code) (increase({"serviceruntime.googleapis.com/api/request_count", monitored_resource="consumed_api", service="drive.googleapis.com"}[30m]))

   # which Drive method dominates (a loop shows up here)
   sum by (method) (increase({"serviceruntime.googleapis.com/api/request_count", monitored_resource="consumed_api", service="drive.googleapis.com"}[30m]))

   # rate-quota usage per quota metric, per minute
   sum by (quota_metric) (increase({"serviceruntime.googleapis.com/quota/rate/net_usage", monitored_resource="consumer_quota", service="drive.googleapis.com"}[1m]))
   ```

## Immediate actions

1. **Classify the failures** from the response codes:
   - mostly **5xx** → Google-side outage;
   - **429**, or **403** after a quota alert → the project's rate quota;
   - **403** without a quota alert → per-user limits (one user or one
     device looping), or something else ("Cloud backup failed" reports →
     check `gcloud services list --enabled --project <project_id>` lists
     `drive.googleapis.com`).
2. **Google outage:** confirm it on the status dashboards. Change nothing
   and ship nothing; installed copies retry by themselves. Watch until the
   5xx ratio alert closes.
3. **Project quota near or over the limit:**
   1. Quotas & System Limits → select the Drive API per-minute limit →
      **Edit quota** → new value and a justification (number of users,
      quota cost per backup, growth). Track the request on the same page.
      Approval isn't guaranteed and large increases take longer. Check
      Google's Drive API usage-limits page for current per-method costs and
      any daily usage threshold beyond which usage becomes billable.
   2. If you've pinned `quota_limit_name_regex` in
      `infra/terraform/google/terraform.tfvars`, check it still names the
      limit you raised.
4. **Usage jumped right after a release:** probably a client bug (retry
   loop, repeated listing). There is no remote switch to throttle installed
   copies, by design, so fix it in a release: [bad-release
   runbook](bad-release.md) (roll back or fix forward). The PromQL `method`
   breakdown shows which call to look at.
5. **Development traffic in production:** if local or preview builds use
   the production OAuth client, move them to the dev project
   (`create_dev_project`, F-25) so testing can't eat production quota.

## Verification

- The incident closes in Monitoring → Alerting (policies auto-close a day
  after the condition clears; close by hand once you're satisfied).
- The response-code query shows 2xx again, allowing for the 30-minute lag.
- With a release build: *Back up now* succeeds and the new version appears
  in the list.
- Users' *retrying* states clear without them doing anything.

## Communication

- Usually none: the app tells users it will retry, and it does.
- If it lasts more than a day, or restores fail: a site banner and an
  artifacts README notice: "Google Drive backup is delayed by a problem at
  Google. Your accounts on this device are unaffected, and backups resume
  automatically. No action needed."
- If a CoreTools bug caused it: release notes of the fix explain it.

## Follow-up

- Tune `error_window`, the ratio thresholds and `drive_min_error_count` in
  `infra/terraform/google` if the alert was noisy or late.
- Record any quota increase (date, old and new limit) in the incident
  review.
- If usage grows steadily, review how many Drive calls one backup makes
  (`cloud-sync.ts`: list, upload, verify, retention deletes).
