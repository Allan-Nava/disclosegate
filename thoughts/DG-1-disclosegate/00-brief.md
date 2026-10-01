# DG-1 — Brief: internal detail stopped before the push

**Repository:** https://github.com/Allan-Nava/disclosegate · **Ticket:** DG-1 in `BACKLOG.md`
**Date:** 2026-10-01 · **Author:** Allan Nava, with Claude

## Goal

A maintainer who works on private and public code from the same machine publishes
internal detail by accident, and not through secrets: a work address as the author of a
commit to a personal project, a `Co-authored-by:` trailer naming a colleague's corporate
address, a private host or client in a commit message, a home-directory path in a README.
Secret scanners do not look for these — they have no shape and differ per person — and
once a commit is on a forge it stays reachable by SHA even after a force-push. The rule
"never publish internal detail" has to be applied before the push, from a list only the
maintainer holds. disclosegate is a `pre-push` hook that reads what is about to leave —
commit metadata, messages and added lines — and refuses the push with a list of masked
findings. No model, no network, no dependency.

## Done when

- `disclosegate install` in a repository: a `git push` whose commits carry an author,
  committer or trailer address outside `publicEmails`, a listed term, a blocked domain,
  a blocked name or a home path is refused and the remote does not get the ref; a clean
  push lands. A deletion is never refused.
- The output names commit, location, rule and a masked match, worst first; `--json`
  exists; exit codes 0 / 1 / 2; `--show` only on a terminal.
- A repository file can tighten and cannot loosen, and `doctor` reports an attempt.
- `npm test` runs `check` (manifest, CHANGELOG, README statements, the tool's own rules on
  its own tree) and an end-to-end suite of real pushes; CI on Node 18/20/22/24 without
  `npm install`; release by tag over OIDC.
- v0.1.0 additionally: a week in audit mode on the maintainer's own repositories, every
  finding classified true or false, the result dated in the README.

## In scope

- `pre-push`, `scan [--range | --staged | --history] [--json] [--show]`, `install
  [--force]`, `uninstall`, `init`, `doctor`, `check`.
- Rules: `email` (allowlist and blocked domains, author/committer/trailers), `term`
  (string or regex; messages, added lines, file names), `path` (built in: home
  directories on macOS, Linux and Windows, `file:` URLs), `name`.
- The user file with the private lists, refused inside the repository being checked;
  the repository file limited to `terms`, `blockedDomains`, `allowPaths`; `mode`;
  `remotes.enforce` / `skip`.
- The repository operating model of the sibling projects: BACKLOG with `DG-n` ids and a
  generated ROADMAP, CI, release by tag, release drift, Pages from the README, CodeQL.

## Out of scope

- Secrets — keys, tokens, passwords, entropy. gitleaks, git-secrets and trufflehog do
  it; the README points at them.
- Server-side or CI enforcement: by the time CI sees a commit it has been pushed, which
  is the event the guard exists to prevent.
- Rewriting history for the user. The guard says what and where; the user rewrites.
- Annotated tag objects and the own changes of merge commits (v0.2.0, DG-18, DG-19).
- Any network request, telemetry, or a shared list of "known internal names".

## Constraints

- Zero runtime dependencies, Node 18+, ESM, `node --test`.
- The output is public by assumption — CI logs, pasted issues — so no match is printed
  unmasked outside a terminal, and no list value appears in an error.
- Fail closed: an error refuses the push; only `--no-verify` bypasses, by the user.
- Every fixture neutral: `example.com`, `example.internal`, `/home/user`,
  `alice@personal.example`. Nothing private in any file of the repository.

## Decisions taken

- **pre-push, not pre-commit.** A commit can be amended until it is pushed; the push is
  the irreversible step. `scan --staged` covers the earlier check for those who want it.
- **Allowlist for addresses, blocklist for everything else.** A maintainer knows the few
  addresses they publish under; they cannot enumerate every corporate one.
- **The path rule is built in.** It needs no list and is the commonest leak; it is the
  one rule a repository file can relax, per file, through `allowPaths`.
- **Masking by default, everywhere.** Two characters and the length tell two findings
  apart without republishing either.

## Assumptions (proceeding this way unless corrected)

- The remote tip of an update is normally present locally; when it is not (a force-push
  over someone else's work), reading the push as a new branch is the safe choice even if
  it rescans commits already published.
- A trailer is any `Token: value` line carrying an address, not only the two common ones.
- `/home/<name>/` preceded by a word character, dot or hyphen is part of a URL or a name,
  not a path.

## Open risks

- **False positives in the path rule** — CI runner paths, documentation that quotes a
  real-looking home path, URL paths that look like homes. The audit week measures it.
- **A term list that is too short** gives a false sense of safety; the guard is only as
  good as the user file, and `doctor` can say a list is empty but not that it is
  incomplete.
- **`--no-verify` and other clients.** A push from a GUI that skips hooks, or from another
  machine without the hook, is not checked.
