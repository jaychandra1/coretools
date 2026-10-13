# Runbook: bad release shipped

**Severity:** SEV1 if it loses or corrupts user data or is a security hole;
SEV2 if a core function is broken (won't start, can't unlock, backup
broken); SEV3 otherwise.

**How downloads find the latest version.** The website's buttons point at
the `coretools-latest` release in `jaychandra1/artifacts`, and the page
shows the version from `coretools/releases/latest.json`. The publish step
moves `coretools-latest` and rewrites `latest.json` **only when the version
it publishes is the newest one listed in `coretools/releases/index.json`**.
Re-publishing an older version therefore does nothing to `coretools-latest`
until the bad version is out of `index.json`.

## Detection

- Users report crashes, a vault that won't unlock, failing backups, or wrong
  data after updating.
- Drive API alerts (403/429 or 5xx ratio, quota usage) firing shortly after
  a release can mean a client bug, such as a request loop.
- Your own smoke test of the published installers fails.

## Immediate actions

1. **Decide: fix forward or roll back.** Fix forward (step 5) when the fix
   is small and can ship within a few hours. Roll back (steps 2–3) when it
   can't, or when the release harms data. Doing both is fine: roll back now,
   fix forward later.
2. **Warn on the bad release.** Prepend a line to its notes, and to
   `coretools-latest`'s:

   ```bash
   gh release view coretools-vX.Y.Z -R jaychandra1/artifacts --json body --jq .body > notes.md
   # add at the top: "**Withdrawn:** <one-line reason>. Use vA.B.C instead."
   gh release edit coretools-vX.Y.Z -R jaychandra1/artifacts --notes-file notes.md
   ```

3. **Roll the installers back** (moves `coretools-latest` to the previous
   version, vA.B.C):
   1. Drop the bad version from the index, using your own git credentials:

      ```bash
      git clone https://github.com/jaychandra1/artifacts && cd artifacts
      jq --arg v X.Y.Z '.versions |= map(select(.version != $v))' \
        coretools/releases/index.json > index.tmp && mv index.tmp coretools/releases/index.json
      git commit -am "CoreTools: withdraw vX.Y.Z from the index"
      git push origin main
      ```

   2. Re-publish the previous version through the release workflow, from
      its tag:

      ```bash
      gh workflow run release.yml -R jaychandra1/coretools --ref vA.B.C
      ```

      (Or Actions → Release → Run workflow → *Use workflow from* → Tags →
      `vA.B.C`.) The `release` environment accepts this because it's a
      `v*` tag. A run from `master` would be refused. The run rebuilds vA.B.C,
      checks that the tag matches its `package.json` and that the commit is
      on `master`, signs, replaces the assets of `coretools-vA.B.C`, and
      (since vA.B.C is now newest in the index) moves `coretools-latest`
      and rewrites `latest.json` and the READMEs.
   3. Approve the publish in the `release` environment.

   Caveats:
   - The rebuild produces new installer bytes, so `coretools-vA.B.C` gets new
     SHA-256 sums. Say so in its notes.
   - **Tags v1.1.0 and earlier run their own older `release.yml`**, which
     doesn't sign, doesn't build an SBOM and doesn't use the `release`
     environment. Republishing one of those leaves the bad version's
     `SHA256SUMS.txt.sigstore.json` (which then fails verification) and
     `CoreTools-sbom.cdx.json` on `coretools-latest`. Delete every asset
     there that `coretools-vA.B.C` doesn't have:
     `gh release delete-asset coretools-latest <asset> -R jaychandra1/artifacts --yes`.
   - Without a rebuild, you can instead copy the original files:
     `gh release download coretools-vA.B.C -R jaychandra1/artifacts -D prev`,
     then `gh release upload coretools-latest prev/* --clobber`, delete any
     asset `prev/` lacks, and edit `latest.json` by hand from the vA.B.C
     entry in `index.json`. More manual steps, but the original signed
     files stay intact.
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
   CI tags the merge commit and starts the release. Approve the publish. A
   version newer than everything in the index moves `coretools-latest` by
   itself. (`npm version` + `git push origin HEAD --follow-tags` doesn't
   work once the `master` rulesets are active, because it pushes straight
   to `master`.)

## Verification

```bash
curl -s https://raw.githubusercontent.com/jaychandra1/artifacts/main/coretools/releases/latest.json | jq -r .version
curl -sL https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/SHA256SUMS.txt
```

- `latest.json` names the version you meant (raw.githubusercontent.com can
  cache for about 5 minutes).
- Download from `coretools-latest` and run the `cosign verify-blob` +
  `sha256sum --check` pair from DEPLOYMENT.md → "Verifying a download".
- The site's download section shows that version. Vercel's current
  production deployment is the commit you expect, and `/` and `/app` load.
- Install it on one platform and smoke-test the broken feature.

## Communication

- Notes of the withdrawn release say why and which version to use
  (step 2). The fix release's `CHANGELOG.md` section explains what was
  wrong and whether users need to do anything.
- Site banner (README.md → "Telling users") if users must act, for
  example "If you installed vX.Y.Z and use Drive backup, update to vX.Y.W
  before restoring".
- Security advisory on `jaychandra1/artifacts` if it's a security issue.

## Follow-up

- Add a test that fails on the bug. Ask why CI and the smoke test missed it.
- Never reuse X.Y.Z: the next version must be higher (`v*` tags can't be
  moved anyway).
- Decide what happens to `coretools-vX.Y.Z`: keep it with the *Withdrawn*
  note (transparent), or delete it if it's harmful. It's gone from the
  version table either way, because the index no longer lists it.
- Incident review for SEV1/SEV2.
