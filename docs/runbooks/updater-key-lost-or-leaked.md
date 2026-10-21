# Runbook: updater signing key lost or leaked

**Severity:** leaked (or possibly leaked) — **SEV1**. Lost — **SEV2**: no
user is at risk, but in-app updates stop until a release with a new key.

**What the key is.** The in-app updater uses a minisign key pair, made with
`tauri signer generate` (DEPLOYMENT.md → "In-app updates"):

| Half | Where it lives | What it does |
| --- | --- | --- |
| Private key + password | GitHub secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (repository, or the `release` environment), and your offline escrow copies | Signs every update file in release.yml's `sign-updates` job — the only job that reads it |
| Public key | Repository variable `TAURI_UPDATER_PUBKEY`; **compiled into every installed copy** built with in-app updates | Installed copies install a file only if its signature verifies against it and the signed file name carries the version (`CoreTools_<version>_…`) |

The public key can't be changed in copies that are already installed. That
decides everything below: **after a key rotation, every copy installed
before the first release with the new key must be updated by hand once.**

**What each case allows.**

| Case | Consequence |
| --- | --- |
| Private key and password leaked | Whoever has them can sign a file that installed copies accept as a genuine update. To deliver it they also need the manifest copies poll — `coretools-latest/updater.json` (and `coretools/releases/updater.json`) in `jaychandra1/artifacts`, i.e. `ARTIFACTS_REPO_TOKEN` or the GitHub account — and a user who clicks **Update now**. Key + token together = a silent, valid update to every installed copy that has in-app updates. The `_<version>_` name check doesn't help here: the thief signs whatever name they like. |
| Private key leaked, password not | Brute-forcing the password is the only way in (scrypt-protected). Treat as leaked anyway: rotate. |
| Key or password lost | Nothing new can be signed with it. Installed copies keep working and keep showing update notifications (latest.json), but the next release can't be installed through **Update now** by them — not until they install a release with a new key by hand. |

## Detection

- GitHub secret scanning (or anyone) reports the key; the key text shows up
  in a log, a repository, a paste or a backup you don't control.
- A `Release` run — above all a `Sign in-app updates` job — you didn't start
  (Actions → Release); unknown entries in Settings → Security log.
- An `updater.json` or `*.sig` in `jaychandra1/artifacts` that no release run
  produced, or a release canary failure about `updater.json` (Actions →
  Release canary).
- Lost: the escrow copy is gone or the password doesn't work; `sign-updates`
  fails with "not a pair" after someone set a different key.

## Immediate actions — leaked

Contain first. Run the commands in Git Bash.

1. **Stop offering in-app updates.** Installed copies then find no manifest,
   so **Update now** has nothing to install; the website's installers still
   work.

   ```bash
   gh release delete-asset coretools-latest updater.json -R jaychandra1/artifacts --yes
   git clone https://github.com/jaychandra1/artifacts && cd artifacts
   git rm coretools/releases/updater.json && git commit -m "CoreTools: stop in-app updates (key rotation)" && git push origin main
   cd ..
   ```

   Both copies matter: installed copies try the repository-tree copy first
   and fall back to the release asset. Actions → *Stop in-app updates*
   (`stop-updates.yml`) deletes both in one click while
   `ARTIFACTS_REPO_TOKEN` still works. The next publish writes
   `updater.json` again, so rotate (step 4) before releasing anything.
2. **Assume the publishing token is exposed too** unless you know how the
   key leaked: both live in the same repository's secrets. Run
   [Release pipeline or publishing token compromised](release-pipeline-compromise.md)
   steps 1–6 (revoke, stop the pipeline, inventory, verify, pull).
3. **Remove the old key from GitHub:**

   ```bash
   gh secret delete TAURI_SIGNING_PRIVATE_KEY -R jaychandra1/coretools
   gh secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R jaychandra1/coretools
   # if they were moved into the environment:
   gh secret delete TAURI_SIGNING_PRIVATE_KEY -R jaychandra1/coretools --env release
   gh secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R jaychandra1/coretools --env release
   gh variable delete TAURI_UPDATER_PUBKEY -R jaychandra1/coretools
   ```

   Destroy every copy of the old private key except one sealed copy for the
   incident record.
4. **Rotate** (next section), then release.
5. **Check what was signed.** For each `coretools-v*` release with an
   `updater.json`, confirm its update files are the ones the Sigstore-signed
   `SHA256SUMS.txt` and the release run describe (DEPLOYMENT.md → "Verifying
   a download"; releases from this pipeline version on list every file —
   `.app.tar.gz`, `*.sig` and `updater.json` included — in the checksums;
   for an older release that doesn't, compare those files with the build's
   artifacts in that Release run, kept 30 days). To check a
   signature against a public key, copy the file to the name it was signed
   as and run, e.g. for Windows:

   ```bash
   cp CoreTools-Windows-Setup.exe CoreTools_1.2.7_windows-x86_64-setup.exe
   cp CoreTools-Windows-Setup.exe.sig CoreTools_1.2.7_windows-x86_64-setup.exe.sig
   node scripts/verify-update-signature.mjs --pubkey "<old TAURI_UPDATER_PUBKEY>" \
     --version 1.2.7 CoreTools_1.2.7_windows-x86_64-setup.exe
   ```

## Immediate actions — lost

1. Search every escrow location (below) before rotating: a found key means
   no user has to do anything.
2. If it's really gone: `gh secret delete` / `gh variable delete` as in
   "leaked" step 3, so no release half-signs, then rotate.

## Rotating the key

1. On a trusted machine, offline if you can:

   ```bash
   npx tauri signer generate -w ~/.tauri/coretools-updater-<YYYY>.key
   ```

   Use a new, long password (a password manager's generator).
2. **Escrow it before it reaches GitHub** (next section).
3. Set the secrets and the variable — the signing secrets in the `release`
   environment where the repository is public or on Pro, else as repository
   secrets; the public key always as a **repository** variable:

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY -R jaychandra1/coretools [--env release] < ~/.tauri/coretools-updater-<YYYY>.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R jaychandra1/coretools [--env release]
   gh variable set TAURI_UPDATER_PUBKEY -R jaychandra1/coretools < ~/.tauri/coretools-updater-<YYYY>.key.pub
   ```

4. Release a new version (Actions → Prepare release → merge). Its
   `sign-updates` job verifies the new pair before anything is published.
   This first release with the new key — call it vN — has the new public
   key compiled in.
5. **Every copy installed before vN must install vN by hand once** (download
   from the website and run the installer over the old version; the vault
   and settings are kept). Their **Update now** can't install vN — its
   signature doesn't verify against the old key they carry. From vN on,
   in-app updates work again.

## Escrow (do this for every key, before you need it)

- Two offline copies of the private key file, in two places — for example
  a password-manager entry with the `.key` file attached, and an encrypted
  USB stick or a printout (the file is a few hundred characters of base64)
  in a drawer or safe. Keep the **password separately** from each copy.
- GitHub is not a backup: it never shows a secret again.
- Once a year: restore from one escrow copy, sign a scratch file with
  `npx tauri signer sign` and check it with
  `node scripts/verify-update-signature.mjs` against `TAURI_UPDATER_PUBKEY`.
- Record where the copies are (not the key) in your password manager.

## Verification

- `sign-updates` in the vN release passed ("Verify the signatures against
  the compiled-in public key").
- Actions → Release canary → Run workflow is green: `updater.json` offers vN
  and its signatures name `CoreTools_vN…` files.
- Install vN by hand on one machine; when vN+1 ships, **Update now** installs
  it.

## Communication

- **Leaked:** security advisory on `jaychandra1/artifacts` (README.md →
  "Telling users"): what could have been signed, the window, that copies
  installed before vN must be updated by hand, and how to verify a download.
- **Both cases:** the vN release notes and a site banner say "install vN
  from the website once — in-app update can't install it". Add a one-line
  `"notice"` to `coretools/releases/latest.json` after vN is published, so
  update notifications in installed copies say the same (the next publish
  overwrites it).

## Follow-up

- How did it leak or get lost? Fix that first (where it was generated,
  who could read the secrets, whether it ever touched a build job).
- Move the signing secrets into the `release` environment if they aren't
  there yet (DEPLOYMENT.md → "Manual steps").
- Incident review (README.md → "After every incident").
