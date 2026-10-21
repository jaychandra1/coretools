# Runbook: publishing token or release pipeline compromised

**Severity:** SEV1 until shown otherwise. Users may be installing
tampered binaries.

**What each compromise allows.**

| Compromised | Attacker can | Signature check |
| --- | --- | --- |
| `ARTIFACTS_REPO_TOKEN` (PAT, Contents read/write on `jaychandra1/artifacts`) | Replace release assets, rewrite `coretools/releases/*` and the root README, push to (or force-push) `main` of the artifacts repo | **Fails** for anything they upload: they can't get a Sigstore certificate for `jaychandra1/coretools/.github/workflows/release.yml` |
| GitHub account, or the ability to run `release.yml` in `jaychandra1/coretools` (pushed tag, edited workflow) | Build and sign their own code as a real release | **Passes.** Find bad releases by tag, commit and run history instead |
| `ARTIFACTS_REPO_TOKEN` **and** the updater key (`TAURI_SIGNING_PRIVATE_KEY` + password) | Publish an `updater.json` that installed copies accept and install on **Update now** | Sigstore fails, but installed copies only check the updater signature — which passes. Follow [Updater signing key lost or leaked](updater-key-lost-or-leaked.md) too |
| Sigstore itself | Outside our control | Follow Sigstore's own incident notice |

## Detection

- A release, asset, tag or commit in `jaychandra1/artifacts` you didn't
  make (watch its releases, or the Atom feed
  `https://github.com/jaychandra1/artifacts/releases.atom`).
- A `Release` or `Promote or roll back latest` run you didn't start, or a
  `v*` tag you didn't push, in `jaychandra1/coretools`.
- The release canary (Actions → Release canary, every 6 hours) fails: the
  stable links, `latest.json` and `updater.json` disagree, or a download
  changed size.
- A report that `cosign verify-blob` or `sha256sum --check` fails.
- GitHub security log (Settings → Security log) entries you don't
  recognise: `personal_access_token.*`, `repository_ruleset.*`, `oauth_authorization.*`, new SSH keys.
- GitHub's secret scanning or a third party telling you the token leaked.

## Immediate actions

Contain first, then investigate. Run the `gh` commands in Git Bash.

1. **Revoke the token.** GitHub → Settings → Developer settings → Personal
   access tokens → Fine-grained tokens → the artifacts token → **Revoke**.
   Revoke any other token with access to `jaychandra1/artifacts`.
2. **Stop the pipeline.**

   ```bash
   gh secret delete ARTIFACTS_REPO_TOKEN -R jaychandra1/coretools
   gh workflow disable release.yml -R jaychandra1/coretools
   gh workflow disable promote-latest.yml -R jaychandra1/coretools
   gh run list -R jaychandra1/coretools --workflow release.yml --limit 20
   gh run cancel <run id> -R jaychandra1/coretools     # for anything in progress
   # in-app updates: stop installed copies from being offered anything —
   # BOTH manifests: copies try the repository-tree copy first, then the
   # coretools-latest asset, so deleting only one changes nothing
   gh release delete-asset coretools-latest updater.json -R jaychandra1/artifacts --yes
   git clone https://github.com/jaychandra1/artifacts && cd artifacts
   git rm coretools/releases/updater.json && git commit -m "CoreTools: stop in-app updates (incident)" && git push origin main
   cd ..
   ```

   (Actions → *Stop in-app updates* does the last part in one click, but it
   needs `ARTIFACTS_REPO_TOKEN`, revoked in step 1 — here, use your own
   credentials as above.)

   If the updater key may be exposed as well (same repository's secrets),
   follow [Updater signing key lost or leaked](updater-key-lost-or-leaked.md)
   in parallel.

3. **If the GitHub account may be compromised:** change the password,
   check 2FA and recovery codes, sign out all sessions (Settings →
   Sessions), remove unknown SSH/GPG keys, PATs, OAuth apps and GitHub App
   authorizations. Then check the repositories:

   ```bash
   for r in coretools artifacts; do
     gh api repos/jaychandra1/$r/keys --jq '.[].title'          # deploy keys
     gh api repos/jaychandra1/$r/hooks --jq '.[].config.url'    # webhooks
     gh api repos/jaychandra1/$r/collaborators --jq '.[].login'
   done
   git ls-remote --tags https://github.com/jaychandra1/coretools 'v*'   # unknown tags?
   git log --all --since=<date> -- .github/                            # workflow changes
   ```

   Run `terraform plan` in `infra/terraform/github`: any change it proposes
   is drift in the rulesets or the `release` environment. Delete unknown
   `v*` tags (you're the tag ruleset's only bypass actor).
4. **Inventory what's published.**

   ```bash
   gh api --paginate repos/jaychandra1/artifacts/releases \
     --jq '.[] | select(.tag_name | startswith("coretools-"))
           | "\(.tag_name)\t\(.published_at)\t\(.author.login)\t\([.assets[] | "\(.name)@\(.updated_at)"] | join(" "))"'
   git clone https://github.com/jaychandra1/artifacts && git -C artifacts log --since=<date> --stat
   ```

5. **Verify every release** that could have been touched (at least
   `coretools-latest` and each version updated in the window):

   ```bash
   tag=coretools-vX.Y.Z
   mkdir "$tag" && cd "$tag"
   gh release download "$tag" -R jaychandra1/artifacts
   cosign verify-blob SHA256SUMS.txt --bundle SHA256SUMS.txt.sigstore.json \
     --certificate-identity-regexp '^https://github\.com/jaychandra1/coretools/\.github/workflows/release\.yml@refs/(tags/v.+|heads/master)$' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   sha256sum --check SHA256SUMS.txt
   ```

   `SHA256SUMS.txt` lists every file of releases made by this pipeline
   version on — the in-app update files (`*.sig`, `updater.json`,
   `CoreTools-macOS.app.tar.gz`) included — so a file the check doesn't
   cover, or that isn't listed, didn't come from the pipeline. (Older
   releases list only the installers and the SBOM.)
   To pin a signature to one specific release run, add
   `--certificate-github-workflow-ref refs/tags/vX.Y.Z` and
   `--certificate-github-workflow-sha <commit of that tag>`.
   Releases from before signing was added (v1.1.0 and earlier) have no
   `.sigstore.json`. Compare their `SHA256SUMS.txt` with the sums the
   publish job printed in its "Generate SHA-256 checksums" step (Actions
   logs, kept 90 days). Don't trust `coretools/releases/index.json` for this,
   since the token could rewrite it.
6. **Pull everything that fails or that you didn't publish.**

   ```bash
   gh release delete-asset coretools-vX.Y.Z <asset> -R jaychandra1/artifacts --yes
   gh release delete coretools-vX.Y.Z -R jaychandra1/artifacts --yes   # a release that shouldn't exist
   ```

   Revert unauthorized commits on the artifacts repo's `main` (`git revert`,
   pushed with your own credentials). If `main` was force-pushed, restore it
   from your clone or the last good publish. If `coretools-latest` is
   tampered with, delete its assets so the download buttons fail rather than
   serve them; step 8 republishes it.
7. **Issue a new token.** Fine-grained PAT, *Only select repositories →
   `jaychandra1/artifacts`*, *Contents: Read and write*, expiry 30 days.

   ```bash
   gh secret set ARTIFACTS_REPO_TOKEN -R jaychandra1/coretools    # paste when prompted
   gh workflow enable release.yml -R jaychandra1/coretools
   gh workflow enable promote-latest.yml -R jaychandra1/coretools
   ```

8. **Republish the good version** on `coretools-latest` from its original,
   signature-checked files: Actions → **Promote or roll back latest** with
   *version* = the newest good version and *withdraw* = any tampered
   version that is newer (it verifies `SHA256SUMS.txt` and the Sigstore
   signature before re-publishing anything, re-publishes only files the
   checksums list, and never touches `coretools-vX.Y.Z` itself). It writes
   both `updater.json` copies again for the good version — or leaves them
   deleted if that version has none. A versioned release whose files were
   tampered with can't be repaired in place — published versions are never
   overwritten: delete it (step 6) and ship a new patch release. Re-running
   the Release workflow on an old tag rebuilds with that tag's own, older
   `release.yml` (v1.1.0 and earlier neither sign nor wait for approval);
   prefer a new release.

The Google OAuth client secret is compiled into every installer, so this
incident doesn't expose it any further. Rotate it only if the Google
account itself was compromised, and only together with a new release
(rotating breaks token refresh for every installed copy built with the old
secret).

## Verification

- Step 5 passes for `coretools-latest` and every remaining `coretools-v*`
  release; nothing unknown is left in the inventory from step 4.
- `curl -s https://raw.githubusercontent.com/jaychandra1/artifacts/main/coretools/releases/latest.json`
  names the version you expect, and its `sha256` values match the signed
  `SHA256SUMS.txt`.
- Security log quiet, old token revoked, new token works (`release.yml`'s
  "Publishing token is set and valid" step passes).
- `terraform plan` in `infra/terraform/github` shows no changes.

## Communication

- **Security advisory on `jaychandra1/artifacts`** (README.md → "Telling
  users"): affected tags and assets, the time window, the bad SHA-256 sums,
  the good version, and what users must do.
- Notes of each affected release start with "Withdrawn: tampered files
  were published between <start> and <end> UTC. Do not install."
- Site banner and an artifacts README notice until the advisory has been
  out for a few weeks.
- What users should do:
  1. Check what they installed. Windows:
     `Get-FileHash .\CoreTools-Windows-Setup.exe -Algorithm SHA256`; macOS:
     `shasum -a 256 CoreTools-macOS.dmg`; Linux: `sha256sum CoreTools-Linux.AppImage`.
     Compare with the bad sums **in the advisory**. A `SHA256SUMS.txt` from
     the same compromised release proves nothing.
  2. Install the good version and verify it with the `cosign verify-blob`
     command above.
  3. If they ran a tampered build, treat everything it could read as
     exposed: change the passwords saved in the Credential Manager,
     re-enrol two-factor for important accounts, change the CoreTools
     encryption password, and in Google Account → Security → Third-party
     connections remove CoreTools' access, then reconnect from the good
     build.

## Follow-up

- Replace the long-lived PAT with a GitHub App installed only on
  `jaychandra1/artifacts`, minting a 1-hour token per run
  (`actions/create-github-app-token`).
- Protect the artifacts repo's `main` with a ruleset that blocks force
  pushes and deletion, and turn on immutable releases there (DEPLOYMENT.md
  → "Manual steps" — read the `coretools-latest` caveat first).
- The release canary checks every 6 hours that `coretools-latest`,
  `latest.json` and `updater.json` agree; it doesn't run `cosign
  verify-blob`. Adding that (cosign-installer is already pinned in
  release.yml) would catch a re-signed-looking but unsigned checksum file.
- Incident review (README.md → "After every incident").
