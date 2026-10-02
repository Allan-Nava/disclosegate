# Changelog

All notable changes to disclosegate. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). Items reference their `DG-n` backlog id.

## [Unreleased]

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
