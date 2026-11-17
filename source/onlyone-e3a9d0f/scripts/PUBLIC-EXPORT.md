# Preparing a public source export

This is the operator checklist for `scripts/export-public.cjs`. It prepares a clean source
directory for a future public repository. It does not publish anything, does not choose a
license holder and does not clear third-party rights.

**Verifying an old revision is not readiness for a future one.** A manifest, a
`readiness.json` or a green log only describe the exact revision they were produced from.
After any change — source, docs, dependencies, build files, tooling — export again from the
new revision and repeat every step. Never reuse a manifest, a run record or a log across
revisions.

## 1. Freeze the revision

Work from a committed revision, not from a dirty working tree.

```sh
git status --porcelain          # must print nothing
git rev-parse HEAD              # full commit sha -> <revision>
git rev-parse HEAD^{tree}       # full tree sha -> <tree>
```

## 2. Export

```sh
node scripts/export-public.cjs --revision <revision> --out <export-dir> --internal-docs=public
```

- The exporter reads Git objects, not the working tree, so bytes and line endings are exact.
- `<export-dir>` is prepared in a staging directory and swapped in only when complete. An
  existing directory is moved to a backup and returned if anything fails; the old `--force`
  behaviour that deleted a previous export on error is not used.
- A manifest is written next to the directory (`<export-dir>.manifest.json`). It records the
  commit sha, the tree sha, and `sha256`, `gitBlob` and `gitMode` for every exported file.
- `--internal-docs=public` keeps `README.md`, `PROJECT-MAP.md` and `SELF-DEVELOPMENT.md` and
  drops internal instruction files. Sanitize those documents in the revision itself.

## 3. Integrity check (before any install)

```sh
node scripts/export-public.cjs --verify <export-dir> --manifest <export-dir>.manifest.json
```

Exit code 0 means: every exported file matches its `sha256` and its Git blob id, the tree and
revision have the expected shape, no excluded path is present and no extra file was added.
An injected file (for example a copied browser profile, a log or a file with a key) makes the
check fail.

Then confirm that the manifest belongs to the revision you exported:

```sh
node -e "console.log(require('<export-dir>.manifest.json').tree)"
git rev-parse <revision>^{tree}
```

Both values must be equal. This is a copy-integrity check, not a secret audit and not a
license review.

## 4. Install and targeted checks in the copy

Run these in the exported directory, in this order, and keep the exit codes:

```sh
npm ci
node tests/test-suite-hygiene.cjs
node tests/test-project-map.cjs
node tests/test-build-integrity.cjs
node tests/test-no-phone-home.cjs
node tests/test-app-split.cjs
node --check scripts/export-public.cjs
node --check scripts/verify-public-readiness.cjs
node --check scripts/run-public-tests.cjs
```

Notes:

- `npm ci` writes `node_modules` into the directory, so run the checks in step 3 and the
  readiness step 5 against a **pristine** export (a second copy without `node_modules`).
- `tests/test-line-ending-churn.cjs` needs Git history and cannot run in a directory without
  `.git`. It becomes applicable only after the copy is imported into a Git repository
  (step 5); it is not a pass before that.
- `node tests/run-smoke.cjs` and the full `npm test` are separate acceptance steps. Run them
  on the final revision before publishing, not on an intermediate copy.

## 5. Record a full test run and readiness

Import a copy into a fresh Git repository (`.git` of the source repository is never exported),
commit it, then record the full suite:

```sh
npm run test:public-record -- --checkout <imported-checkout> --manifest <manifest> --out <evidence-dir>
```

This runs `npm test` once, records the commit sha, manifest hash, source hashes before/after,
exit code, signal, duration and the log hash, and refuses a dirty or changed checkout.

Finally verify the evidence against a pristine export:

```sh
node scripts/verify-public-readiness.cjs \
  --export <pristine-export> --manifest <manifest> \
  --run <evidence-dir>/run.json --revision <revision> \
  --out <readiness.json>
```

The report must have `technicalReady: true`. It also contains the revision tree, the number of
attribution-scanned files, and `legal: { status: "unresolved", publicationAllowed: false }` —
the last one is by design and stays unresolved until a human decides.

## Readiness criteria

All of the following must hold for the same revision:

1. `git status --porcelain` is empty in the source repository.
2. Export exit code is 0; `--verify` exit code is 0.
3. `manifest.tree` equals `git rev-parse <revision>^{tree}`.
4. The manifest lists every required file: entry points, `package.json` and
   `package-lock.json`, `electron-builder.config.cjs`, `build/installer.nsh`, the icon and
   `resources/cli/*`, `THIRD-PARTY-NOTICES.md`, `LICENSES/OFL-1.1.txt`, vendored React license
   files, and the `mobile/` and `server/relay/` package files.
5. `mobile/capacitor.config.json` keeps `appId: best.pkwobler.onlyone`, and
   `electron-builder.config.cjs` keeps `appId: com.onecode.workspace` — these are working
   integration identifiers, not branding to rename.
6. No exported text file contains an authorship formula for a development model. The
   readiness check reports such files; clean them only in the revision, not in the copy.
7. `npm ci` and every targeted check above exit 0 in the copy.
8. `readiness.json` has `technicalReady: true` and refers to the same commit sha and manifest
   hash as the export.

## What this checklist does not decide

- A license holder and a `LICENSE` file: not invented here.
- Rights to prompts, mockups, fonts, icons and other assets, and notices for vendored code:
  a human decision per file.
- The secret audit of the revision: still pending unless a separate audit was performed on
  this exact revision.
- Publication, pushing or release: only on an explicit owner request.
