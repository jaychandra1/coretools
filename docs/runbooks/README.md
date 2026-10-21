# Incident response

How CoreTools handles incidents (audit F-27). CoreTools has no servers and
no telemetry, so incidents come from the things it depends on: the release
pipeline, the public artifacts repository, the Google Cloud project behind
Drive backup, and the Vercel site.

| Runbook | Use when |
| --- | --- |
| [Google project suspended or deleted](google-project-suspended-or-deleted.md) | Sign-in or every backup fails for everyone; Google emails about the project |
| [Release pipeline or publishing token compromised](release-pipeline-compromise.md) | A release, asset or index commit you didn't make; `ARTIFACTS_REPO_TOKEN` or the GitHub account exposed; a release fails `cosign verify-blob` |
| [Bad release shipped](bad-release.md) | A published version is broken or harmful; the site deploy is broken; the release canary reports a withdrawn build still offered |
| [Updater signing key lost or leaked](updater-key-lost-or-leaked.md) | `TAURI_SIGNING_PRIVATE_KEY` or its password exposed, or lost; an `updater.json` or `.sig` nobody published |
| [Drive API outage or quota exhaustion](drive-api-outage-or-quota.md) | Drive API alerts fire; users report backups stuck on "retrying" |

## Severity

| Level | Meaning | Examples | Response |
| --- | --- | --- | --- |
| **SEV1** | Users' secrets or devices are at risk, or users are losing data | Tampered or malicious installer; publishing token or GitHub account compromised; exploited vulnerability; a release that corrupts or deletes vaults or backups | Start now, any hour. Pull the affected downloads first, investigate second. Security advisory required. |
| **SEV2** | A core function is broken for most users, no workaround | Google project suspended (backup and restore down); a release that won't start; site or downloads down | Same day. Banner and release-note warning. |
| **SEV3** | Degraded, with a workaround or self-healing | Drive API outage or throttling (the app retries); one platform's installer broken; restore slow | Within 2 business days. Communicate only if it lasts more than a day or users must act. |
| **SEV4** | Cosmetic or docs | Wrong text on the site; a stale link | Next normal release. |

When unsure, pick the higher level and lower it later. Anything involving
installer integrity, signing (including the in-app updater key), tokens or
users' secrets is SEV1 until shown otherwise.

**Early warning.** Actions → *Release canary* runs every 6 hours and fails
(GitHub emails the maintainer) when `latest.json`, the `coretools-latest`
downloads, `updater.json` or the website disagree with the newest release.
An external uptime monitor watches the site independently of GitHub
(DEPLOYMENT.md → "Manual steps").

## Who decides

The maintainer (**@jaychandra1**, coretools.works@gmail.com) is the
incident lead: sets the severity, decides rollback versus fix-forward,
approves releases in the `release` environment, and publishes every user
communication. CoreTools has one maintainer, so there is no escalation path
and no second approver. If a co-maintainer is added, list them here with
what they may do alone (revoking tokens, pulling releases) and what needs
the lead (publishing advisories, cutting releases).

Anyone can report a problem: security issues through the [disclosure
policy](https://coretools-chi.vercel.app/security.html), everything else as
an issue or by email.

## Telling users

There is no telemetry, so the project can't contact installed copies
directly. Copies with update notifications turned on read
`coretools/releases/latest.json` in `jaychandra1/artifacts` about once an
hour (less often while its `checkAfterHours` back-off is set), and show its
optional one-line `notice` in the update banner. The publish script doesn't
write that field: add it by hand after publishing a fix (the next publish,
or a *Promote or roll back latest* run, overwrites the file). Everyone else is reached only
where they look when downloading or updating. Use every channel that
applies.

1. **GitHub Security Advisory on
   [`jaychandra1/artifacts`](https://github.com/jaychandra1/artifacts/security/advisories)**
   (the public repository; the source repository is private, so
   advisories there are invisible). Required for SEV1 and for any
   security fix. Draft it privately while you work (*Security → Advisories →
   New draft advisory*), add the reporter as a collaborator if there is
   one, and publish when users can act (a fixed version exists or the bad
   one is pulled). State: affected versions, what to do, the fixed
   version, and SHA-256 sums of affected files when integrity is at stake.
   Request a CVE when the issue is a vulnerability in CoreTools.
2. **Release notes** in `jaychandra1/artifacts`. Edit the notes of the
   affected `coretools-v<version>` release (and `coretools-latest`) so they
   open with a warning line: `gh release edit coretools-v<version> -R
   jaychandra1/artifacts --notes-file notes.md`. The fix release's
   `CHANGELOG.md` section says what changed and what users should do.
   Watchers of the artifacts repository get these.
3. **Root README of `jaychandra1/artifacts`.** Text *outside* the
   `<!-- apps:start -->`/`<!-- apps:end -->` markers survives every publish,
   so a short notice at the top stays until you remove it.
   (`coretools/releases/README.md` is regenerated on each publish, so don't
   put notices there.)
4. **Site banner** on <https://coretools-chi.vercel.app>. Add this right
   after `<main id="main">` in `website/index.html` (static, no script; the
   site's CSP allows no inline scripts), merge through a pull request, and
   CI's `promote-web` deploys it once the checks pass:

   ```html
   <aside class="container" role="status" style="margin-top:24px">
     <p class="smartscreen-note" style="margin-top:0">
       <strong>Security notice (DATE):</strong> CoreTools vX.Y.Z was
       withdrawn. If you installed it, install vX.Y.W and
       <a href="https://github.com/jaychandra1/artifacts/security/advisories">read the advisory</a>.
     </p>
   </aside>
   ```

5. **Direct reply** to whoever reported it.

Message rules: say what happened, who is affected (versions, platforms,
only users of Drive backup, …), what they should do, and when you'll
update next. Never post exploit details before a fixed version is out. Say
plainly when local data is unaffected; for CoreTools it usually is.

## After every incident

Within a week of resolving a SEV1 or SEV2, write a short review in the
private source repository (`docs/incidents/YYYY-MM-DD-<slug>.md`): timeline,
impact, root cause, what worked, follow-up issues. Update the runbook you
used where it was wrong or slow. Remove banners and README notices once
they've served their purpose.
