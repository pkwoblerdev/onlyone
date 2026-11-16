# Contributing

## Setup

```bash
npm ci
npm run dev
```

## Before you open a pull request

- Run the tests that cover your change. Before merging, run the full suite: `npm test` must exit with code 0
  (about 15 minutes). An interrupted run is not a pass.
- After changes to the top of `src/main/main.js` or `src/renderer/app.js`, run `node tests/run-smoke.cjs`, which
  opens a real Electron window.
- For UI changes, check both themes and both languages. `node tests/audit-design.cjs [folder] [screen...]` takes
  screenshots of a screen in a fresh profile.
- Describe what changed, which commands you ran, and what remains unverified. Do not claim more than the tests show.

There is no linter or formatter configured. Match the style of the surrounding code and keep comments to the "why"
that the code cannot show.

## Rules the test suite enforces

- **Register new tests.** A new `tests/test-*.cjs` or `tests/run-*.cjs` file must be added to `package.json`;
  `tests/test-suite-hygiene.cjs` fails otherwise. Tests that need the network or a live key stay out of `npm test`.
- **Keep the project map current.** `node scripts/project-map.cjs` regenerates the generated tables in
  `PROJECT-MAP.md`; add a description for a new `src/` file in `DESCRIPTIONS` of that script.
  `tests/test-project-map.cjs` fails while the map is stale.
- **Respect the `app.js` limit.** `src/renderer/app.js` must stay at or below 12,100 lines; put new renderer code in
  its own module under `src/renderer/`.
- **Do not normalize line endings.** Line endings are mixed per file and `.gitattributes` uses `* -text`.
  `tests/test-line-ending-churn.cjs` fails if a diff contains lines changed only by their ending.
- **Use the design system.** Colors, spacing and radii come from tokens in `src/renderer/tokens.css`, not from
  literal values.
- **Route user-visible text through `t(...)`.** The dictionary is `src/renderer/i18n.js`; the key is the Russian
  string.

## Secrets and personal data

Do not commit API keys, tokens, personal paths, logs with user content, or screenshots of real conversations. The
repository ignores `.env*` files, but the check is yours: keys belong in the app's encrypted profile, never in the
tree, tests, issue reports or pull requests.

## Pull requests

Keep a pull request focused on one change. Include the tests you ran with their exit codes, and list known
limitations instead of hiding them.
