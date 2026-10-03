# Changelog

All notable changes to disclosegate. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). Items reference their `DG-n` backlog id.

## [Unreleased]

### Added
- `.pre-commit-hooks.yaml`: the pre-commit framework can run disclosegate as a `pre-push`
  stage hook (pre-commit 3.2 or later). Its entry, `disclosegate pre-push --pre-commit`,
  reads the ref pre-commit passes in `PRE_COMMIT_*` variables, since pre-commit has read
  git's stdin itself; a missing variable or a file name is a usage error that refuses the
  push. pre-commit passes only the first ref that sends anything, so the README says
  where the git hook reads more; `check` holds the definition's load-bearing keys (DG-24).

### Changed
- `scan --history` streams the log: each commit goes through the rules as git writes it
  and only its findings are kept, so the history is never in memory whole — and no longer
  limited by the 1 GiB buffer the collected read had. The output, the masking and the
  exit codes are those of the collected reading, held to it by a test on a fixture
  repository; on a synthetic 4,000-commit history the peak resident memory fell from
  1.1 GB to 209 MB (DG-22).
- A pre-push hook that `install --force` moved aside keeps running: the hook script runs
  it after disclosegate passes the push, with the same arguments and the same stdin, and
  its exit code counts — either can refuse the push; one disclosegate refuses never
  reaches it. `doctor` reports the chain, and `uninstall` still restores the hook. A hook
  written by 0.0.3 or earlier chains once `disclosegate install` updates it (DG-21).

### Fixed
- **Security:** a 0x01 byte in an added line no longer hides the rest of its commit. The
  log was cut into commits at every 0x01 and its header at the first 0x03, and git prints
  a file holding those bytes as text and takes them in a message or an author name: the
  lines after such a line went unread — a home path after it passed the hook, `scan`,
  `scan --history` and `--pre-commit` in 0.0.3 — the commit was counted twice, a line
  shaped like a header was read as a commit of its own, and a 0x03 in a message hid the
  rest of the message. No byte frames the reading any more: the patches come from a
  `git log --format=%H` whose only framing is a sha line outside every hunk, each hunk
  consumed by its own counts, and the author, committer and message from the commit
  object through `git cat-file --batch`, which states each object's length. Output that
  is not in that shape is an error — exit 2, a refused push — never a shorter scan.
  `diff.relative` and `diff.submodule` are pinned too: the first, run from a
  subdirectory, hid every file outside it. Same readings as before on histories without
  such bytes; `scan --history` on a synthetic 4,000-commit history with 250 MB of patches
  took 3.4 s against 4.05 s, at the same peak memory (DG-29).

## [0.0.3] — 2026-10-03

0.0.3 adds DG-18, DG-19 and DG-20 and moves the backlog tooling to backlogsync; 0.1.0
still waits on the audit week (DG-14).

### Added
- An annotated tag is read: its tagger is checked like a committer (`email`, `name`) and
  its message like a commit message (`term`, `path`, trailers), in the hook and in `scan
  --history` — and so is a tag it points at. A tag is counted apart from the commits, and
  `--json` carries a `tags` count (DG-18).
- A merge's own lines are read: `git log` runs with `--cc`, and the parser reads its
  combined hunks by their counts, so a line new to every parent — what resolving a
  conflict writes — goes through the term and path rules; a line one side already had is
  not read twice (DG-19).
- `blockedDomains` applies in text: an address at a blocked domain in a commit or tag
  message (outside a trailer, which was already read) or in an added line is an `email`
  finding, ranked first like any blocked domain — `allowPaths` does not exempt it, and
  `publicEmails` is never applied there. The domain stops where a host name does, so an
  SSH remote such as `git@host/group/repo.git` is at its host (DG-20).

### Changed
- The backlog check, the roadmap, the issue sync and the release-drift check are
  [backlogsync](https://github.com/Allan-Nava/backlogsync) 0.1.0, configured in
  `package.json#backlogsync`; `scripts/backlog.mjs`, its test and fixtures are gone, and
  `npm run roadmap` regenerates `ROADMAP.md` (DG-28).
- `repository.url` takes the form npm normalises it to (`git+https://….git`), so `npm
  publish` no longer rewrites it and warns. `check` expects that form.

## [0.0.2] — 2026-10-01

Not yet measured on a week of real pushes — run it in `audit` mode until 0.1.0 (DG-14).
The first version on npm, published by hand so that npm's trusted publisher can be
configured (DG-16).

### Fixed
- A user config that is a symlink into the repository being pushed — a dotfiles
  repository — is now refused like one that lives there: the file itself is resolved,
  not only its directory, and `init` follows a dangling link before writing (DG-25).
- A repository's `.disclosegate.json` no longer refuses the push that adds it: its own
  lines are exempt from the terms it defines, and from nothing else — a term from the
  user file and the email, name and path rules still read them (DG-26).
- The release job closes only the milestone named for its version — `v<version>`, or
  `v<version> — Theme` — not one whose title merely starts with it, so a tag can no
  longer close a later milestone such as `v0.0.20` (DG-16).

## [0.0.1] — 2026-10-01 — not released

Not released. The first version, written test-first from the brief (DG-1); it goes to
npm as 0.1.0 after a week in audit mode on real repositories (DG-14).

### Added
- `disclosegate pre-push <remote> <url>`: the git hook protocol — a deletion is skipped,
  a new branch is read against everything the remote already has, an update as
  `remote..local`, and a remote tip this repository lacks as a new branch (DG-3).
- Four rules: `email` (author, committer and trailer addresses against `publicEmails`;
  `blockedDomains` whatever the allowlist), `term` (plain or `/regex/flags`, in
  messages, added lines and file names), `path` (built in, always on: home directories
  and `file:` URLs) and `name` (`blockedNames`) (DG-2).
- A user config that holds the private lists and is refused inside the repository being
  scanned, and a repository config that may only tighten — `terms`, `blockedDomains` —
  plus `allowPaths`, which exempts files from the path rule only (DG-4). `mode` (`block`
  or `audit`) and `remotes.enforce` / `remotes.skip` from the user file (DG-5).
- Findings worst first, matches masked; `--show` only on a terminal; `--json`; exit
  codes 0, 1 and 2 (DG-6).
- `scan [--range | --staged | --history]`, `install [--force]`, `uninstall`, `init`,
  `doctor`, `check` (DG-7, DG-8, DG-9).
- The end-to-end suite of real pushes into a bare remote (DG-10); CI, release by tag over
  OIDC, the Pages site, the backlog tooling (DG-11, DG-12, DG-13).
