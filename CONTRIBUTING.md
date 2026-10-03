# Contributing

## Local loop

```bash
npm test                                     # node bin/disclosegate.mjs check && node --test
node bin/disclosegate.mjs scan --history     # this repository's history through its own rules
node bin/disclosegate.mjs doctor             # config, rules, hook, remotes
npm run backlog                              # BACKLOG lint + ROADMAP in step
npm install && npm run build:site && open site/dist/index.html
```

No dependency, no build: every file that matters is under `bin/`, and `npm test` on
Node 18 without `npm install` is the floor CI holds.

The end-to-end suite (`test/push.test.mjs`) builds temporary repositories under the
system temp directory, with `HOME`, `GIT_CONFIG_GLOBAL` and `DISCLOSEGATE_CONFIG` pointed
into the sandbox, so your own git configuration, hooks and user file are never read or
touched.

## What must not be published

This repository is public and it is the tool's own first customer. Install the hook in
your checkout (`node bin/disclosegate.mjs install`) with your own user file in place:
your work addresses, your private names. `check` turns those lists on the tree as well,
masked, so `npm test` on your machine catches what CI cannot know.

Fixtures use reserved values only — `example.com`, `example.internal`, `*.example`,
`/home/user` — and outside `test/rules.test.mjs` even those home paths are assembled at
runtime, so `check` can hold every other file to "no home path, no real address".

## Backlog, roadmap, issues

`BACKLOG.md` is the single source of truth; `ROADMAP.md` is generated from it and the
GitHub issues are synced from it one way on every push to `main` that touches the file.
Ticking an item ships it; closing an issue on GitHub changes nothing. Items carry a
stable `DG-n` id and a trailing `<!-- dg: prio= size= labels= [ver=] -->` comment. The check,
the roadmap and the sync are [backlogsync](https://github.com/Allan-Nava/backlogsync),
configured in `package.json#backlogsync` and pinned to its release in `package.json`
(`backlogsync@0.1.0`) and the workflows (`@backlogsync--v0.1.0`); bump them together.

## Pull requests

- `main` is protected: pull request, green CI, no direct pushes.
- Conventional subject, `DG-n` in it when the change belongs to an item, a CHANGELOG
  line under `[Unreleased]` — `check` fails without that section.

## Releasing

Releases run from GitHub Actions; pushing the tag is the manual step, and
`release-drift.yml` fails when `main` carries a version with no tag for two hours.

**One-time bootstrap — 0.0.2, published by hand.** No npm token lives here; the
release job authenticates over OIDC (npm Trusted Publishing). npm cannot configure a
trusted publisher for a package that does not exist, so the first version on npm —
0.0.2, decided 2026-10-01 (DG-16) — is published by hand, and every later version
releases from CI — 0.0.3 was the first, 2026-10-03. The audit-week gate on 0.1.0 (DG-14) does not move. In this
order, after the release pull request has merged:

```bash
# 1. publish from a clean checkout of main at the merged commit (nothing merged since)
git checkout main && git pull --ff-only
git status --short                      # must print nothing
npm test
npm login
npm publish --access public

# 2. bind the trusted publisher to release.yml (npm >= 11.15 for `npm trust`)
npm trust github disclosegate --repo Allan-Nava/disclosegate --file release.yml --allow-publish

# 3. tag the merged commit; release.yml skips the published version and cuts the release
git tag disclosegate--v0.0.2 && git push origin disclosegate--v0.0.2
```

Step 2 can be done on npmjs.com instead → package → Settings → Trusted Publisher →
GitHub Actions: owner `Allan-Nava` exactly, repository `disclosegate` (the name only, not
the URL), workflow `release.yml`, environment empty, "Allow npm publish" ticked.

`release-drift.yml` fails once the merged 0.0.2 has gone two hours without its tag —
the 0.0.2 CHANGELOG heading does not say "not released", so the check expects one. Run
the three steps inside that window, or expect a failing run (and an email) until the
tag is pushed. The tag's run verifies the version, runs `npm test`, skips the publish
because `disclosegate@0.0.2` is already on the registry, cuts the GitHub release and
closes no milestone: there is no `v0.0.2` milestone, and the milestone step matches
`v<version>` exactly or `v<version> — Theme`, so the v0.1.0 milestone stays open for
its audit week. Never give `actions/setup-node` a `registry-url`; never rename
`release.yml`.

**Per release:**

```bash
# 1. bump the version in package.json (and package-lock.json: npm install)
#    rename CHANGELOG's [Unreleased] to [x.y.z] — date, open a new empty [Unreleased]
#    turn every ver=main in BACKLOG.md into ver=x.y.z, regenerate the roadmap
npm test && npm run backlog
# 2. land the bump on main through a pull request, then tag that merge commit
git checkout main && git pull
git tag disclosegate--v{version} && git push origin disclosegate--v{version}
```

The tag triggers `release.yml`: version check, tests, publish, wait for the registry,
GitHub release, close the milestone named `v{version}` or `v{version} — Theme`. Re-run with
`gh workflow run Release -f tag=disclosegate--v{version}`; every step is idempotent.

The notes open with the version's CHANGELOG section (`scripts/release-notes.mjs`), then
the install lines, then GitHub's list of pull requests — so write the CHANGELOG for the
reader who is upgrading. A **Breaking** entry goes first under its heading; `npm test`
fails when it does not, and fails when `release.yml` stops calling the script.
