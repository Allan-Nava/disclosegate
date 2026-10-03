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
- [x] **DG-21 — Chain a moved-aside hook**: `install --force` moves a foreign pre-push
  hook aside and it stops running; run it after disclosegate with the same stdin
  instead. Done 2026-10-03: the hook script holds stdin in a variable, runs disclosegate on
  it, and on a pass runs `pre-push.before-disclosegate` with the same stdin and arguments,
  its exit code the hook's; real pushes show it running after a clean push (from a
  subdirectory, and under `core.hooksPath`), refusing one, and never reached by a refused
  one; `doctor` reports the chain. <!-- dg: prio=low size=S labels=hook,enhancement ver=0.0.4 -->
- [x] **DG-22 — Stream `--history`**: the log is read into memory whole; on a large
  repository read it as a stream. Done 2026-10-03: `streamCommits` spawns the same pinned
  `git log` and `splitLog` hands over each commit when the next begins; `scan --history`
  runs the rules per commit and keeps only findings. A test holds its text and JSON
  output, stderr and exit code, block and audit, to the collected reading on a fixture
  repository, and the splitter to `parseLog` split at every byte; 0.0.3 and the stream
  printed the same on two real histories and a synthetic 4,000-commit one (peak RSS
  1.1 GB → 209 MB). <!-- dg: prio=low size=S labels=enhancement ver=0.0.4 -->
- [ ] **DG-23 — The social card**: render `assets/social-preview.png` from
  `assets/social-preview.html` with headless Chrome and name it in the page's
  `og:image`. <!-- dg: prio=low size=S labels=docs -->
- [x] **DG-24 — A `pre-commit` framework definition**: `.pre-commit-hooks.yaml` with
  `stages: [pre-push]`, for repositories that manage hooks that way. Done 2026-10-03: the
  definition calls `disclosegate pre-push --pre-commit`, which reads `PRE_COMMIT_REMOTE_*`
  and `FROM_REF..TO_REF` (or `LOCAL_BRANCH` from a root) — pre-commit consumes git's stdin
  and passes the first ref only, per its `hook_impl.py` source; tests cover the variables,
  a tag at `TO_REF`, enforcement, audit mode, the fail-closed cases and a real push through
  a caller modelled on pre-commit's. pre-commit itself was not installed, so it never ran.
  <!-- dg: prio=low size=S labels=hook,enhancement ver=0.0.4 -->
- [x] **DG-29 — A control byte in a line splits the log**: `parseLog` and `splitLog` cut
  the log at every `\x01`, and git prints a file holding that byte (but no NUL) as text,
  so an added line containing it splits one commit in two — the lines after it in that
  commit go unread and the commit is counted twice. Found during DG-22: a home path after
  such a line passed `scan --history` in 0.0.3 and on `main`, and the hook reads through
  the same parser. Separate commits by a byte a text diff cannot carry (NUL, with `-z`)
  and add the case as a real push. Done 2026-10-03: not NUL — git prints a file whose NUL
  lies past its first 8,000 bytes as text, and a message or an author name takes 0x01 to
  0x03 too. No byte frames the reading now: `git log --format=%H` gives the patches, a sha
  line recognised only outside a hunk and every hunk consumed by its counts; the author,
  committer and message come from the commit object through `git cat-file --batch`, by
  its stated length; anything outside that shape is a `GitError`, exit 2, a refused push.
  `diff.relative` and `diff.submodule` are pinned. Tests on a history built to forge the
  framing, on every path (hook, real push, `--range`, `--history`, `--pre-commit`);
  readings identical to 0.0.3 on six real histories and three synthetic ones; `scan
  --history` on a synthetic 4,000 commits as fast as before, where one `git show` per
  commit would take 44 s. <!-- dg: prio=med size=S labels=rules,hook ver=0.0.4 -->
- [x] **DG-30 — A `-diff` attribute hides a file's lines**: a `.gitattributes` in the
  working tree that marks a path `-diff` or `binary` (lock files often are) makes
  `git log -p` print `Binary files … differ` for it, so its added lines are never read —
  an internal registry host in a lock file passes. `--text` would read real binaries as
  lines too; decide between that with a cap, ignoring the `diff` attribute for text git
  would otherwise print, or saying so in the README. Found during DG-29. Done 2026-10-03:
  `--text` on every diff — it also beats `info/attributes`, the user's
  `core.attributesFile`, a driver set to `binary`, `core.bigFileThreshold` and the NUL
  sniff, none of which an attribute override reaches — with `--no-textconv` and
  `--no-ext-diff` kept; a merge's combined diff ignores `--text`, so a file it calls
  binary is read through one `diff-tree --text` per parent. Real binaries are read as
  text by every rule; the parser reads bytes, splits on the newline byte only, and reads
  a file's added text up to 100 MiB in a commit and a commit's up to 512 MiB, a file past
  either being a new `unread` finding. The hook, `--pre-commit` and `scan` stream like
  `--history`. Tests on every path, each shown failing before the fix; same output on
  six real histories; a synthetic one with 336 MiB of random `-diff` blobs takes 5.5 s
  against 0.16 s. <!-- dg: prio=med size=S labels=rules,hook ver=0.0.4 -->
- [x] **DG-31 — A long run of letters makes the address rule quadratic**: `TEXT_EMAIL` in
  `bin/lib/rules.mjs` starts a match at every character of a run of `[A-Za-z0-9._%+-]`
  and backtracks to its end looking for `@`, so a line of n such characters costs n²/2
  steps whenever `blockedDomains` is set. A commit adding lines of 25k, 50k and 100k
  letters took 8 s on main; a minified bundle or a base64 blob with a line of a few
  hundred kilobytes stalls the hook for minutes — fail closed, since an interrupted hook
  refuses the push, but a guard nobody waits for gets `--no-verify`. DG-30 widens the
  exposure: binary files are read now. Anchor the match on the `@` (find each `@`, then
  extend left and right) and add a timing test on a long line. Found during DG-30.
  Done 2026-10-03: addresses are found from each `@` outwards (`addressesIn`), every
  class a table filled by its own regex. The audit of every pattern that reads content
  found six more quadratic ones, all linear now: the trailer address, the trailer shape
  (`\s+(.*)$` before a CR, now an atomic run), a trailer name's `<…>`, an author name's
  trailing blanks, a tagger's `Name <email>` and a `publicEmails` wildcard with two
  stars or more — plus `check`'s own address pattern; the path patterns were linear.
  Findings are the old patterns' exactly: tests keep each one as the reference on 20,000
  generated inputs, and 57 real histories give byte-identical output. Timing tests in
  a child process with a hard stop, each shown failing or killed on main: 25k/50k/100k
  letters 8.5 s → 0.12 s, a 5.3 MB base64url line killed at 300 s → 0.15 s. A `/regex/`
  term stays the user's — documented in a new README Limits section, with LFS (DG-32).
  <!-- dg: prio=med size=S labels=rules ver=0.0.4 -->
- [ ] **DG-32 — Git LFS content is not read**: a file tracked by Git LFS is a pointer in
  the commit, and its content goes to the LFS server through git-lfs's own pre-push
  hook, beside the push disclosegate reads — so a work address in an LFS-tracked file
  reaches the forge's LFS store unread, and `unread` does not name it either. Read the
  objects `git lfs pre-push` would upload (`git lfs ls-files` over the pushed range, the
  local `.git/lfs/objects`), or at least report each pointer as `unread`; and check that
  the chained-hook order lets disclosegate run before git-lfs uploads. Found during DG-30.
  The README's Limits section states it meanwhile. <!-- dg: prio=med size=M labels=rules,hook -->
- [ ] **DG-33 — A trailer that ends in a CR is not read as a trailer**: `trailers()` in
  `bin/lib/rules.mjs` takes a line as `Token: value` only when `.*$` reaches its end, and
  `.` stops at a CR, so a message kept with CRLF line endings (`git commit
  --cleanup=verbatim`, `commit-tree`, a tool writing the object) has no trailers to the
  guard — while `git log --format=%(trailers)` reads a `Co-authored-by:` there, and a
  forge may show it. An address in it is still read as text, so `blockedDomains` holds,
  but `publicEmails` and `blockedNames` never see it: a co-author outside the allowlist
  passes. Strip one trailing CR before matching, as git's trailer parser does, and test
  it on a real verbatim commit. Changes findings, so it was kept out of DG-31, whose
  results had to stay byte-identical. Found during DG-31.
  <!-- dg: prio=med size=S labels=rules -->
- [x] **DG-34 — `init` checks for the user file, then writes it**: CodeQL's
  `js/file-system-race`, alerts 2 and 3, 2026-10-03. `init` in `bin/disclosegate.mjs`
  asked `existsSync` whether the user file was there and then called `writeFileSync`,
  which follows a link: a link put at the path between the two — or a dangling one
  already there that points outside the repository, which `existsSync` reports absent —
  took the write wherever it pointed. `test/cli.test.mjs` stat-ed the installed hook and
  read it later through the path. Create the file in one call that fails if anything is
  there, and read the hook's text and mode through one descriptor. Done 2026-10-03: `init`
  opens the user file with `'wx'` (`O_CREAT | O_EXCL`), which never opens an existing file
  and never follows a link at the path, dangling or not, and writes the template through
  that descriptor; the check that the path is not inside the repository (DG-25) still
  runs first. A link at the path is refused as one and nothing is written through it — a
  test shown failing on main, where a dangling link was written through. The CLI tests read
  a file's text and mode through one descriptor, and a file that may be absent through
  one read that handles `ENOENT`. <!-- dg: prio=med size=S labels=config,tests ver=0.0.4 -->
