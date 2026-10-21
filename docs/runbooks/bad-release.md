# Runbook: bad release shipped

**Severity:** SEV1 if it loses or corrupts user data or is a security hole;
SEV2 if a core function is broken (won't start, can't unlock, backup
broken); SEV3 otherwise.

**How people get the latest version.** In `jaychandra1/artifacts`:

- The website's buttons point at the `coretools-latest` release, and the page
  shows the version from `coretools/releases/latest.json`.
- Installed copies with update notifications read `latest.json` about once an
  hour; with in-app updates, **Update now** reads `updater.json` and installs
  the file it names from the versioned release — after checking its
  signature. There are **two** copies of `updater.json`, tried in this order
  (`src-tauri/tauri.conf.json` → `plugins.updater.endpoints`), and the first
  that answers wins: `coretools/releases/updater.json` in the repository
  tree (next to `latest.json`, served by raw.githubusercontent.com), then
  the `updater.json` asset of `coretools-latest`. Stopping updates means
  removing both.

The publish step moves `coretools-latest`, `latest.json` and `updater.json`
**only when the version it publishes is the newest one listed in
`coretools/releases/index.json`**, and it never overwrites a published
`coretools-v<version>` release. Rolling back therefore means: take the bad
version out of the index and re-point `coretools-latest` at the previous
version's original files — **Actions → Promote or roll back latest**
(`promote-latest.yml`) does exactly that, without rebuilding anything.

**The updater never downgrades.** Copies that already installed the bad
version stay on it after a rollback; only a newer version (fix forward)
reaches them. A staged rollout (`rollout` on the release, DEPLOYMENT.md →
"Rollback, staged rollout and update back-off") limits how many copies get
that far.

## Detection

- Users report crashes, a vault that won't unlock, failing backups, or wrong
  data after updating.
- Drive API alerts (403/429 or 5xx ratio, quota usage) firing shortly after
  a release can mean a client bug, such as a request loop.
- Your own smoke test of the published installers fails.
- The release canary (Actions → Release canary) fails. (A `v*` tag whose
  release never published keeps it red without anything being wrong with
  what is published — v1.2.6 is one; see DEPLOYMENT.md → "Release canary"
  for the two ways out.)

## Immediate actions

1. **Stop in-app updates to the bad version (SEV1/SEV2, in-app updates on).**
   Copies poll about hourly; do this first, it takes a minute. Delete
   **both** copies of `updater.json` — deleting only the `coretools-latest`
   asset changes nothing, because installed copies try the repository-tree
   copy first:

   Actions → **Stop in-app updates** → Run workflow (`stop-updates.yml`), or
   `gh workflow run stop-updates.yml -R jaychandra1/coretools -f reason="vX.Y.Z breaks …"`.
   It deletes both copies and doesn't wait for a release that is running or
   waiting for approval (step 3 deals with that one).

   Without the workflow (Actions down, or `ARTIFACTS_REPO_TOKEN` revoked),
   with your own credentials, in Git Bash:

   ```bash
   gh release delete-asset coretools-latest updater.json -R jaychandra1/artifacts --yes
   git clone https://github.com/jaychandra1/artifacts && cd artifacts
   git rm coretools/releases/updater.json && git commit -m "CoreTools: stop in-app updates" && git push origin main
   cd ..
   ```

   raw.githubusercontent.com may serve the tree copy for up to ~5 minutes
   more. Step 3 (or the next release) writes `updater.json` again for the
   version it publishes; until then the release canary reports it missing.
2. **Decide: fix forward or roll back.** Fix forward (step 5) when the fix
   is small and can ship within a few hours. Roll back (step 3) when it
   can't, or when the release harms data. Doing both is fine — and usual:
   roll back now, fix forward later.
3. **Roll back.** First, **reject or cancel any Release run that is
   pending**: a release waiting for approval in the `release` environment
   (or still building) holds the `coretools-release` concurrency group, so
   the rollback would queue behind it — and starting yet another run while
   one waits cancels the waiting one.

   ```bash
   gh run list -R jaychandra1/coretools --workflow release.yml --limit 5
   gh run cancel <run id> -R jaychandra1/coretools   # or Actions → the run → Review deployments → Reject
   ```

   Then Actions → **Promote or roll back latest** → Run workflow
   (from `master`):
   - *version*: the last good version, vA.B.C;
   - *withdraw*: the bad version, X.Y.Z;
   - *reason*: one line for the withdrawn release's notes.

   Or: `gh workflow run promote-latest.yml -R jaychandra1/coretools -f version=A.B.C -f withdraw=X.Y.Z -f reason="…"`.

   The run downloads `coretools-vA.B.C`'s files, checks them against its
   `SHA256SUMS.txt` and Sigstore signature (and leaves out any file the
   checksums don't list), drops X.Y.Z from the index,
   rewrites `latest.json` / `updater.json` / the READMEs for vA.B.C, deletes
   every file on `coretools-latest` that vA.B.C doesn't have (the bad
   build's `updater.json`, signatures, …), uploads vA.B.C's original files
   there, and prepends "**Withdrawn:** …" to `coretools-vX.Y.Z`'s notes. It
   refuses if anything newer than vA.B.C would still be listed — withdraw
   those in the same run (`withdraw=X.Y.Z,X.Y.W`).

   Then add the warning to `coretools-latest`'s notes if you like; the run
   already rewrote them for vA.B.C.

   Don't roll back by re-running the Release workflow on an old tag: it
   rebuilds (new checksums), and tags before this pipeline version run their
   own older `release.yml`, which overwrites `coretools-vA.B.C` and leaves
   the bad build's `updater.json` and signatures on `coretools-latest`.
4. **Roll the website back** if the site or `/app` is what broke. Installer
   rollbacks don't need this, because the page reads `latest.json` live.
   - Vercel → project → Deployments → the last good **Production**
     deployment → ⋯ → **Instant Rollback** (CLI: `vercel rollback <deployment url>`).
     Hobby plans can only go back to the previous production deployment.
   - After an Instant Rollback, Vercel stops putting new production
     deployments on the domain. Once the fix has deployed from
     `production`, **Promote** that deployment (`vercel promote <url>`) to
     resume normal deploys.
   - Git-only alternative: point `production` at the last good commit
     (`git push --force origin <good sha>:refs/heads/production`). The next
     green push to `master` moves it forward again.
5. **Fix forward.** Merge the revert or fix through a pull request (CI must
   pass). Then **Actions → Prepare release → Run workflow** with the next
   version (higher than X.Y.Z) and merge the release pull request it opens.
   CI tags the merge commit and starts the release. Approve the jobs in the
   `release` environment. A version newer than everything in the index
   moves `coretools-latest` by itself, and copies stuck on X.Y.Z are offered
   it. The 24-hour soak rule (DEPLOYMENT.md) doesn't apply to the fix of a
   SEV1/SEV2; consider a staged rollout (`rollout` input) for it anyway.
   (`npm version` + `git push origin HEAD --follow-tags` doesn't work once
   the `master` rulesets are active, because it pushes straight to
   `master`.)

### Without the workflow (manual fallback)

Only if Actions is unavailable. Use your own git credentials.

```bash
git clone https://github.com/jaychandra1/artifacts && cd artifacts
jq --arg v X.Y.Z '.versions |= map(select(.version != $v))' \
  coretools/releases/index.json > index.tmp && mv index.tmp coretools/releases/index.json
# latest.json: rebuild from the vA.B.C entry of index.json (same shape as today's file)
git rm -q --ignore-unmatch coretools/releases/updater.json   # or copy vA.B.C's updater.json there
git commit -am "CoreTools: withdraw vX.Y.Z" && git push origin main
cd .. && mkdir prev && gh release download coretools-vA.B.C -R jaychandra1/artifacts -D prev
(cd prev && sha256sum --check SHA256SUMS.txt)
# delete every coretools-latest asset that prev/ lacks — updater.json first:
gh release view coretools-latest -R jaychandra1/artifacts --json assets --jq '.assets[].name'
gh release delete-asset coretools-latest <asset> -R jaychandra1/artifacts --yes
gh release upload coretools-latest prev/* -R jaychandra1/artifacts --clobber
```

## Verification

```bash
curl -s https://raw.githubusercontent.com/jaychandra1/artifacts/main/coretools/releases/latest.json | jq -r .version
curl -sL https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/SHA256SUMS.txt
curl -sL https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/updater.json | jq -r .version   # vA.B.C, or 404 if vA.B.C had no in-app updates
curl -s https://raw.githubusercontent.com/jaychandra1/artifacts/main/coretools/releases/updater.json | jq -r .version   # the copy tried first: the same answer
```

- Actions → **Release canary** → Run workflow is green (it checks all of
  this, and that no `updater.json` offers the withdrawn version).
- `latest.json` names the version you meant (raw.githubusercontent.com can
  cache for about 5 minutes).
- Download from `coretools-latest` and run the `cosign verify-blob` +
  `sha256sum --check` pair from DEPLOYMENT.md → "Verifying a download".
- The site's download section shows that version. Vercel's current
  production deployment is the commit you expect, and `/` and `/app` load.
- Install it on one platform and smoke-test the broken feature.

## Communication

- Notes of the withdrawn release say why and which version to use (step 3
  writes the first line). The fix release's `CHANGELOG.md` section explains
  what was wrong and whether users need to do anything.
- Site banner (README.md → "Telling users") if users must act, for
  example "If you installed vX.Y.Z and use Drive backup, update to vX.Y.W
  before restoring". Copies that already installed X.Y.Z only leave it
  through the fix release — say when it is coming.
- Security advisory on `jaychandra1/artifacts` if it's a security issue.

## Follow-up

- Add a test that fails on the bug. Ask why CI and the smoke test missed it.
- Never reuse X.Y.Z: the next version must be higher (`v*` tags can't be
  moved anyway, and published releases are never overwritten).
- Decide what happens to `coretools-vX.Y.Z`: keep it with the *Withdrawn*
  note (transparent; the release canary recognises the note), or delete it
  if it's harmful — then list X.Y.Z in the `RELEASE_CANARY_IGNORE_VERSIONS`
  repository variable, or the canary keeps reporting the unpublished tag.
  It's gone from the version table either way, because the index no longer
  lists it.
- Incident review for SEV1/SEV2.
