# Backlog — disclosegate

The single source of truth for planned work. Every item has a stable `DG-n` id that
commits, pull requests and the CHANGELOG reference, and a trailing
`<!-- dg: prio= size= labels= [ver=] -->` comment. [ROADMAP.md](ROADMAP.md) is generated
from this file (`npm run roadmap`, backlogsync) and the GitHub issues are synced from
it one way, on every push to `main` that touches it. Ticking an item ships it; closing
an issue on GitHub changes nothing.

Labels: `rules`, `hook`, `config`, `release`, `docs`, `project`, `tests`, `enhancement`.
A shipped item that is on `main` but in no release yet carries `ver=main`; the release
that ships it turns that into its version.

## v0.0.1 — The guard, test-first <!-- ms: phase=now -->

Everything the brief (`thoughts/DG-1-disclosegate/00-brief.md`) asks of a first version,
written against tests that build real repositories and run a real `git push`. Not
published: 0.0.1 is the code, v0.1.0 is the evidence.

- [x] **DG-1 — The brief**: `thoughts/DG-1-disclosegate/00-brief.md` — goal, done when,
  in scope, out of scope, constraints. No QRSPI phase has been run on it; the build
  followed the brief directly. <!-- dg: prio=high size=S labels=project ver=0.0.2 -->
- [x] **DG-2 — The rules**: `bin/lib/rules.mjs`, pure — `email` (author, committer and
  every trailer address against `publicEmails`, `blockedDomains` whatever the
  allowlist), `term` (plain or `/regex/flags`, in messages, added lines and file names),
  `path` (built in, always on: home directories on three systems, `file:` URLs naming a
  path), `name` (`blockedNames`). Worst first. <!-- dg: prio=high size=M labels=rules ver=0.0.2 -->
- [x] **DG-3 — Reading what leaves**: `bin/lib/git.mjs` — one `git log -p -U0` pass
  with every output-changing setting pinned; the pre-push protocol (deletion skipped,
  new branch against `--remotes=<name>`, update `remote..local`, a remote tip this
  repository lacks read as a new branch); `--staged` with the identity the next commit
  would carry. <!-- dg: prio=high size=M labels=hook ver=0.0.2 -->
- [x] **DG-4 — Config with a trust order**: the user file holds the private lists and is
  refused inside the repository being scanned; the repository file may only add `terms`
  and `blockedDomains` and set `allowPaths`, every other key ignored and reported; JSON
  with comments; errors name the key, never the value. <!-- dg: prio=high size=M labels=config ver=0.0.2 -->
- [x] **DG-5 — Remote enforcement**: `remotes.enforce` / `remotes.skip` globs against
  the remote URL normalised to `host/path`; skip wins; no list means every remote.
  <!-- dg: prio=med size=S labels=config ver=0.0.2 -->
- [x] **DG-6 — Output that is safe to log**: findings worst first with short sha, where,
  rule and the match masked (two characters, an ellipsis, the length); `--show` in full
  only on a TTY; `--json`; exit codes 0 / 1 / 2; paths shown with `~`.
  <!-- dg: prio=high size=S labels=rules ver=0.0.2 -->
- [x] **DG-7 — install and uninstall**: the hook into `.git/hooks` or `core.hooksPath`,
  marked by a comment line; a foreign hook is never overwritten without `--force`, which
  moves it aside, and `uninstall` puts it back; a hook whose binary has gone refuses the
  push. <!-- dg: prio=high size=S labels=hook ver=0.0.2 -->
- [x] **DG-8 — init and doctor**: a template of placeholders with comments, never
  overwritten, mode 0600; `doctor` reports the config, the active rules, the hook, the
  remotes, and a repository file trying to loosen — counts and key names, never values.
  <!-- dg: prio=med size=S labels=config ver=0.0.2 -->
- [x] **DG-9 — check, the repository's own invariants**: manifest and CHANGELOG
  versions, `[Unreleased]`, the README's "never sends" and `allowPaths` statements, and
  the tool's own rules on its own tree — no home path, no address outside the reserved
  example domains. <!-- dg: prio=high size=S labels=tests ver=0.0.2 -->
- [x] **DG-10 — The end-to-end suite**: temporary repositories, a bare remote, the hook
  installed, real `git push` runs that must be refused and ones that must land — new
  branch, update, deletion, trailers, terms, a regex term, a home path, an exempted
  fixture, a loosening repository file, audit mode, masking, `--json`, a foreign hook.
  <!-- dg: prio=high size=M labels=tests ver=0.0.2 -->
- [x] **DG-11 — CI and release**: `ci.yml` (Node 18/20/22/24 without `npm install`,
  the tool on its own history, a refused push by hand, pack, backlog), `release.yml`
  (tag `disclosegate--v*`, npm over OIDC, notes opening with the CHANGELOG section),
  `release-drift.yml`, `pages.yml`, `codeql.yml`, `backlog-issues.yml`.
  <!-- dg: prio=med size=M labels=release ver=0.0.2 -->
- [x] **DG-12 — Site, mark and documents**: `site/build.mjs` generates the page from the
  README and lists the commands off the CLI's usage comment; `assets/logo.svg`; README,
  CLAUDE.md, CONTRIBUTING, CHANGELOG. <!-- dg: prio=med size=M labels=docs ver=0.0.2 -->
- [x] **DG-13 — Backlog tooling**: `scripts/backlog.mjs` lint, roadmap, check, stats and
  the one-way issue sync, with its planner asserted against a fixture.
  <!-- dg: prio=low size=S labels=project ver=0.0.2 -->

## v0.1.0 — A week in audit mode <!-- ms: phase=next -->

**The measurement is the gate on this milestone.** No `disclosegate--v0.1.0` before the
guard has run on the maintainer's own repositories for a week in `audit` mode, every
finding classified true or false, and the result recorded, dated, in the README. Counts
and rates are published, the matches are not.

- [ ] **DG-14 — The audit week**: `disclosegate install` in every repository the
  maintainer pushes to, `"mode": "audit"` in the user file, `disclosegate scan --history`
  once per repository at the start. Each finding classified true (would have published
  internal detail) or false (and why: a URL, a CI path, a placeholder the rule did not
  know). The README gets a dated table — findings per rule, true, false, the
  false-positive rate — and the default list of what the path rule leaves alone moves
  only on that evidence. <!-- dg: prio=high size=M labels=rules,project -->
- [ ] **DG-15 — Fix what the week finds false**: each false-positive class from DG-14
  becomes a unit test in `test/rules.test.mjs` first, then a rule change; a class that
  cannot be fixed without missing a true finding is documented instead.
  <!-- dg: prio=high size=M labels=rules,tests -->
- [x] **DG-16 — First publish, by hand**: npm cannot bind a trusted publisher to a
  package that does not exist, so the first version on npm is 0.0.2, published by hand —
  decided 2026-10-01 — with `npm publish --access public` from a clean checkout of `main`
  at the merged release commit; then the trusted publisher is configured and the tag
  `disclosegate--v0.0.2` pushed, which `release.yml` releases without publishing again.
  From 0.1.0 on every version publishes from CI. The audit-week gate (DG-14) is
  unchanged. Open until the maintainer has published 0.0.2 and configured the trusted
  publisher — the maintainer ticks it then, with the date. Done 2026-10-03: 0.0.2 published by hand on 2026-10-01;
  the trusted publisher is confirmed by 0.0.3, which `release.yml` published over OIDC.
  <!-- dg: prio=high size=S labels=release ver=0.0.2 -->
- [ ] **DG-17 — Switch to block**: after the week, `"mode": "block"` on the maintainer's
  machine; the README status line says when. <!-- dg: prio=med size=S labels=docs -->

- [x] **DG-25 — A symlinked user file can publish the private list**: found by the DG-1
  Questions phase (Q5), 2026-10-01. `inside()` in `bin/lib/config.mjs` resolves the
  directory of the user file but not the file itself, so a `~/.disclosegate.json` that is
  a symlink into a dotfiles repository is not refused when that repository is pushed —
  and if the list holds only `publicEmails` and `blockedDomains`, the scan of the commit
  adding it comes back clean. Resolve the file with `realpathSync` before comparing, and
  add a push test with the symlink. Done 2026-10-01: `inside()` resolves the file itself,
  and follows a dangling link for `init`; push tests for a file and a directory symlink.
  <!-- dg: prio=high size=S labels=config,tests ver=0.0.2 -->
- [x] **DG-26 — A repository's own terms refuse the push that adds them**: found by the
  DG-1 Questions phase (Q7). A plain-string term in a committed `.disclosegate.json`
  matches its own added line, so the commit that introduces the file is refused by it;
  `test/push.test.mjs` never commits the file with a term. Exempt the term rule on the
  lines of `.disclosegate.json` itself (the email and path rules still apply), with a test.
  Done 2026-10-01: the root `.disclosegate.json` is exempt from the terms it adds only; a
  user term and every other rule still read it.
  <!-- dg: prio=med size=S labels=rules,tests ver=0.0.2 -->
- [x] **DG-27 — Release drift fails on a version that is not meant to be tagged**: 0.0.1 is
  the scaffold — its CHANGELOG section says "Not released", the first published version is
  0.1.0 — but `.github/workflows/release-drift.yml` reads no such marker, so two hours after
  the version landed every run fails asking for a tag nobody should push. Found by the
  backlogsync compatibility pass. Done 2026-10-01: the check skips a version whose CHANGELOG
  heading ends "not released", as skilltrigger's does; the 0.0.1 heading carries it.
  <!-- dg: prio=high size=S labels=release ver=0.0.2 -->
- [x] **DG-28 — The backlog tooling is backlogsync's**: `scripts/backlog.mjs` was one of
  seven diverged copies of the same script, and its `release-drift.yml` the copy that read
  no not-released marker (DG-27). Replace them, the script's test and fixtures with
  backlogsync 0.1.0 — the CI `backlog` job and `backlog-issues.yml` through its action,
  `release-drift.yml` through its reusable workflow, `npm run backlog` / `npm run roadmap`
  through `npx backlogsync@0.1.0` — keeping the label set. Done 2026-10-02 (backlogsync
  BS-14). <!-- dg: prio=med size=S labels=project ver=0.0.3 -->

## v0.2.0 — What the first version does not read <!-- ms: phase=later -->

- [x] **DG-18 — Annotated tags**: a pushed annotated tag carries a tagger identity and a
  message; neither is checked yet — only the commits it points at are. Done 2026-10-03:
  the pushed tips that are tag objects, and a tag they point at, are read through one
  `git cat-file --batch`; the tagger goes through the email and name rules, the message
  through terms, paths and trailers; `scan --history` reads every annotated tag a ref
  points at. <!-- dg: prio=med size=S labels=rules,hook ver=0.0.3 -->
- [x] **DG-19 — A merge's own changes**: `git log -p` shows no diff for a merge, so a
  line added while resolving a conflict is not read. `--cc` shows only those lines;
  parse its combined format. Done 2026-10-03: `git log` runs with `--cc`; `parsePatch`
  consumes a combined hunk by its per-parent and result counts and takes a line as added
  only when every parent column is `+`; a conflict resolved with new text is refused in a
  real push, an octopus hunk parses. <!-- dg: prio=med size=M labels=rules,hook ver=0.0.3 -->
- [x] **DG-20 — blockedDomains in text**: an address at a blocked domain in an added
  line or a message body (outside a trailer) is a term today only if listed as one;
  make the domain list apply there too. Done 2026-10-03: every address in a commit or tag
  message and in an added line is held to `blockedDomains` — not to `publicEmails` — and
  found as an `email` / `blocked domain` finding, masked, `allowPaths` no exemption; a
  trailer's address is read once. <!-- dg: prio=med size=S labels=rules ver=0.0.3 -->
- [ ] **DG-21 — Chain a moved-aside hook**: `install --force` moves a foreign pre-push
  hook aside and it stops running; run it after disclosegate with the same stdin
  instead. <!-- dg: prio=low size=S labels=hook,enhancement -->
- [ ] **DG-22 — Stream `--history`**: the log is read into memory whole; on a large
  repository read it as a stream. <!-- dg: prio=low size=S labels=enhancement -->
- [ ] **DG-23 — The social card**: render `assets/social-preview.png` from
  `assets/social-preview.html` with headless Chrome and name it in the page's
  `og:image`. <!-- dg: prio=low size=S labels=docs -->
- [ ] **DG-24 — A `pre-commit` framework definition**: `.pre-commit-hooks.yaml` with
  `stages: [pre-push]`, for repositories that manage hooks that way.
  <!-- dg: prio=low size=S labels=hook,enhancement -->
