# Changelog

All notable changes to disclosegate. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). Items reference their `DG-n` backlog id.

## [Unreleased]

### Fixed
- A user config that is a symlink into the repository being pushed — a dotfiles
  repository — is now refused like one that lives there: the file itself is resolved,
  not only its directory, and `init` follows a dangling link before writing (DG-25).

## [0.0.1] — 2026-10-01

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
