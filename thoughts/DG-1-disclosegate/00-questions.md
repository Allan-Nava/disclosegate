# 00 · Questions — DG-1 Internal detail stopped before the push

**Written against:** `d6b3372`

The default assumption is what makes this phase non-blocking: work can proceed
without waiting for answers, and the assumptions are on the record.

---

## Ticket

**ID:** DG-1
**Link:** `BACKLOG.md` (item DG-1, milestone "v0.1.0 — A week in audit mode", lines 73-96); full brief in `thoughts/DG-1-disclosegate/00-brief.md`
**Title:** Internal detail stopped before the push

A `pre-push` hook that reads what a push is about to publish — author, committer and
trailer addresses, commit messages, added lines, file names — and refuses the push when
they carry internal detail from a list only the maintainer holds (addresses outside
`publicEmails`, `blockedDomains`, `terms`, `blockedNames`) or a home-directory path
(built in). Output masked, `--json`, exit codes 0 / 1 / 2, fail closed, a repository
file that can tighten and never loosen, no network, no dependency. v0.0.1 (the code) is
on `main`; this task's open part is the v0.1.0 gate: a week in `audit` mode on the
maintainer's own repositories, every finding classified true or false, the result
dated in the README (DG-14), the false classes fixed or documented (DG-15), then the
switch to `block` (DG-17). Out of scope by the brief: secrets, server-side
enforcement, rewriting history, annotated tags and merges' own changes (DG-18, DG-19),
any network request or shared list.

---

## Questions

Ordered by descending risk. Every path is repository-root-relative; line numbers are
at the commit above.

### Q1 · Where does the audit week's evidence come from, when the hook prints each finding once, masked, and keeps nothing?

- **Risk if unresolved:** DG-14 (`BACKLOG.md:80-86`) needs every finding classified,
  but the pre-push path never reveals a match (`bin/disclosegate.mjs:72-86` passes no
  `show`; `report()` at `bin/disclosegate.mjs:62-70` reveals only with `--show` on a
  TTY), never prints the range it read (`pushRevSets` in `bin/lib/git.mjs:128-145`
  returns the rev sets, `formatText` in `bin/lib/report.mjs:13-30` drops them), and
  writes nothing to disk ("reads two files, and prints", `README.md:162-163`). In audit
  mode the push goes through and the remote-tracking ref moves, so the default `scan`
  (`bin/lib/git.mjs:168-172`) no longer covers those commits. A week of scrolled-away
  terminal output cannot be classified; the gate on v0.1.0 then has no data.
- **Options:** (a) the maintainer re-runs `scan --range … --show` by hand after each
  push, from shas he copies; (b) audit mode prints, per ref, the exact `scan --range
  <remote>..<local> --show` command that reproduces the findings, nothing stored;
  (c) a local audit log — JSON lines, masked, `0600`, in the home directory beside the
  user file — that the maintainer annotates true/false; (d) the same log unmasked.
- **Default assumption:** (b), plus (c) masked. The reproduce line makes each finding
  re-examinable in a terminal; the masked log makes the week countable without a new
  store of private matches. (d) is refused: an unmasked file of what must not be
  published is the thing the tool exists to prevent. The README's "reads two files,
  and prints" becomes "and appends to one, in audit mode", stated.
- **Answer:** _(to be filled — human)_

### Q2 · What is one finding for counting, and what makes it true or false?

- **Risk if unresolved:** the README table (findings per rule, true, false,
  false-positive rate — `BACKLOG.md:84-86`) depends on the unit, and the code inflates
  some classes: a term is reported once per line it appears on (`termsIn` in
  `bin/lib/rules.mjs:155-160`, called per message line at `:174-177` and per added line
  at `:187-191`), with no de-duplication across lines or commits, so one pasted config
  file can outweigh a week of real leaks. `scan --history` at the start reports
  commits that are already public — true, but no longer preventable. And an address
  that is correct on a work remote is "not in publicEmails" by construction.
- **Options for the unit:** each finding row as printed; distinct (commit, rule,
  match); distinct (rule, match) across the week; per refused push.
- **Default assumption:** the unit is the distinct (commit, rule, match); the rate is
  reported per rule. **True** = would have published internal detail to a public
  remote that was not already public. **False** carries a reason from a fixed list
  (URL, CI or container path, placeholder, quoted documentation, intended
  publication). `--history` findings are a separate row — "already published" — not
  part of the rate, because the rate measures the hook, not the past.
- **Answer:** _(to be filled — human)_

### Q3 · Which repositories and remotes take part in the week, and how is the hook put there?

- **Risk if unresolved:** the template enforces every remote by default
  (`bin/lib/config.mjs:219-221`; `remoteVerdict` at `:179-185` — no `enforce` list
  means all), so on a work repository every commit authored with the work address is a
  finding, and the week measures configuration, not the rules. Coverage is also
  uneven: `install` is per repository unless `core.hooksPath` is set
  (`bin/lib/hook.mjs:13-21`, `README.md:57-61`), and a global `core.hooksPath` replaces
  `.git/hooks` for every repository, silencing hooks other tools installed there.
- **Options:** (a) `remotes.enforce` limited to the public forge(s), every repository
  installed one by one; (b) a global `core.hooksPath` with the same `enforce` list;
  (c) only personal repositories take part.
- **Default assumption:** (a). Enforce only public-forge patterns, skip the private
  forges explicitly, and `doctor` run in each repository on day one to record that it
  is guarded. A global hooks path is not used for the week: displacing other hooks
  silently would make the trial change the maintainer's tooling, and DG-21 (chaining)
  is not done.
- **Answer:** _(to be filled — human)_

### Q4 · Does an error still refuse the push when `mode` is `audit`?

- **Risk if unresolved:** fail-closed is a stated rule (`CLAUDE.md:55-57`, brief
  "Constraints"), and today a config error (`loadConfig` throws before `mode` is read,
  `bin/lib/config.mjs:125-134`), a `git log` failure (`bin/lib/git.mjs:117-121`) or a
  crash (`bin/disclosegate.mjs:206-220`) exits 2 and refuses the push in either mode.
  During a week meant to be non-blocking, one refused push on a bug is likely to be
  answered with `--no-verify`, which skips the guard entirely — the push is then
  neither checked nor counted.
- **Options:** (a) fail closed in both modes (as now); (b) fail open in audit mode
  only — print the error, exit 0; (c) fail closed, and record each error as its own
  class in the week's tally.
- **Default assumption:** (c). An audit that skips its own failures hides precisely
  the pushes it cannot read; the week should count them, and the mode switch (DG-17)
  should not be the first time an error blocks. Every `--no-verify` used during the
  week is noted by hand in the tally.
- **Answer:** _(to be filled — human)_

### Q5 · How must the user file be kept out of every repository, not only the one being checked?

- **Risk if unresolved:** the refusal checks the repository being scanned only
  (`bin/lib/config.mjs:129`), and `inside()` resolves the file's directory but not the
  file itself (`bin/lib/config.mjs:116-119`). A `~/.disclosegate.json` that is a
  symlink into a dotfiles repository passes: pushing that dotfiles repository
  publishes the list. Only `terms` would catch it, by matching their own lines; a file
  holding `publicEmails`, `blockedDomains` or `blockedNames` and no terms scans clean,
  because addresses and names are read only from metadata and trailers
  (`bin/lib/rules.mjs:147-151`, `:165-173`; DG-20 is v0.2.0). `DISCLOSEGATE_CONFIG`
  (`bin/lib/config.mjs:25`) can point anywhere, and the `0600` mode `init` sets
  (`bin/disclosegate.mjs:143`) is never checked afterwards.
- **Options:** (a) resolve the file's real path as well as its directory; (b) refuse a
  user file that sits inside *any* git work tree (ask git from the file's own
  directory); (c) `doctor` warns on a symlink, a work tree or permissions wider than
  `0600`, without refusing.
- **Default assumption:** (a) and (b) refuse, (c) warns on permissions. Leaking the
  list is the worst leak this tool can cause — it publishes every private name at
  once — and the check costs one `git rev-parse` per run.
- **Answer:** _(to be filled — human)_

### Q6 · Is anything the tool itself prints outside the masking rule, and is two characters plus the length enough for short values?

- **Risk if unresolved:** the output is public by assumption (brief "Constraints",
  `CLAUDE.md:58-60`). An internal error prints `e.stack` unfiltered
  (`bin/disclosegate.mjs:217`), whose frames carry the absolute path of the installed
  script — a home path, not passed through `tildify` (`bin/lib/config.mjs:29-34`). A
  `GitError` carries the first line of git's stderr verbatim (`bin/lib/git.mjs:119`,
  `:162`). And `mask` (`bin/lib/rules.mjs:29-32`) keeps two characters of any match:
  for a three- or four-letter client code that is most of it, and `--json` adds the
  exact length (`bin/lib/report.mjs:41`).
- **Options:** (a) as now; (b) every line the tool writes to stderr passes through
  `tildify` and the path rule before printing; (c) matches under a threshold (say
  eight characters) show the length only; (d) both (b) and (c).
- **Default assumption:** (d). The threshold is small and keeps two findings apart in
  the common case; a stack trace is the one place the tool would leak a home path by
  itself, in the very CI logs the README warns about.
- **Answer:** _(to be filled — human)_

### Q7 · What is the repository file's `terms` list for, when committing it publishes the terms and refuses itself?

- **Risk if unresolved:** a plain-string term in a committed `.disclosegate.json`
  matches its own added line (the term rule reads every added line,
  `bin/lib/rules.mjs:187-190`; repository terms merge at `bin/lib/config.mjs:147`), so
  the push that adds the file is refused by the file — reproduced on a scratch
  repository at this commit. Only a regex term whose source does not match itself
  escapes. The existing push test (`test/push.test.mjs:106-117`) writes the file but
  never commits it with a term. And a term written into a public repository is public
  by definition, so the list can only hold names that are already known.
- **Options:** (a) the repository file is exempt from the term rule for the terms it
  defines itself; (b) repository terms must be regexes; (c) repository `terms` and
  `blockedDomains` are dropped, leaving the repository file `allowPaths` only; (d) as
  now, documented.
- **Default assumption:** (a), with the README stating that repository terms are
  public and fit names that are already out — a former product name, a retired host —
  never a private one. Dropping the key (c) changes the trust model the brief fixed
  ("Decisions taken"), which belongs to the human.
- **Answer:** _(to be filled — human)_

### Q8 · Which home-path shapes are legitimate, and are they exempted per file, per shape or per match?

- **Risk if unresolved:** the path rule matches any account name
  (`bin/lib/rules.mjs:17-21`), including the generic ones a public repository quotes
  honestly — a CI runner's home, a container's default user, and the `/home/user`
  placeholder the project's own conventions use (`CLAUDE.md:95-98`, which is why
  fixtures assemble it). DG-14 speaks of "the default list of what the path rule leaves
  alone" (`BACKLOG.md:85-86`), but no such list exists: the only exception is the
  look-behind. The only escape is `allowPaths`, per file, read from one file at the
  repository root (`bin/lib/config.mjs:136`), globs relative to that root
  (`bin/lib/rules.mjs:40-61`), with the user file's globs applied to every repository
  alike (`bin/lib/config.mjs:153`) — so a monorepo cannot scope it per package, and
  messages are never exempt (`bin/lib/rules.mjs:174-177`).
- **Options:** (a) a built-in list of generic account names, shipped before the week;
  (b) the list starts empty and only the week's false findings add to it (DG-15);
  (c) a per-match allowance (a shape, not a file) in the repository file; (d) nested
  repository files for monorepos.
- **Default assumption:** (b), per-file `allowPaths` only, one root file, no nesting.
  `BACKLOG.md:86` already says the list "moves only on that evidence"; shipping
  guesses first would make the week measure the guesses. A monorepo uses
  root-relative globs (`packages/*/test/fixtures/**`).
- **Answer:** _(to be filled — human)_

### Q9 · Do merges and annotated tags stay unread in v0.1.0, or does the hook at least say it skipped them?

- **Risk if unresolved:** `git log -p` gives a merge no diff (`bin/lib/git.mjs:118`, no
  `-m` or `--cc`), and the format has no parent field (`bin/lib/git.mjs:13`), so a line
  added while resolving a conflict is invisible and nothing says so. A pushed
  annotated tag is peeled to its commit; the tagger and the tag message are never read.
  Both are v0.2.0 (DG-18, DG-19, `BACKLOG.md:100-105`), but a week that does not see
  them cannot say how often they matter, and "clean" on such a push overstates.
- **Options:** (a) silent until v0.2.0; (b) detect and warn — a merge commit, an
  annotated tag object — without reading their content, and count the warnings in the
  week; (c) pull DG-18 and DG-19 into v0.1.0.
- **Default assumption:** (b). Detection is cheap (a parent count in the format, one
  `cat-file -t` per pushed ref); the warning keeps "clean" honest and gives DG-18/19 a
  measured priority instead of a guessed one.
- **Answer:** _(to be filled — human)_

### Q10 · What push size must the hook handle, and what happens beyond it?

- **Risk if unresolved:** the first push of an existing repository to a new remote
  reads its whole history (`--not --remotes=<name>` with nothing to exclude,
  `bin/lib/git.mjs:141`), buffered in one string up to 1 GiB (`maxBuffer` at
  `bin/lib/git.mjs:16`); past that, `spawnSync` errors, the hook fails closed and the
  push is impossible without `--no-verify`. Every term runs on every added line, and
  every `allowPaths` glob is recompiled on every line (`matchesGlob` at
  `bin/lib/rules.mjs:61`, called at `:190`). Lockfiles and generated bundles are read
  like source. Nothing is measured today.
- **Options:** (a) no limit, measure during the week; (b) a size or time budget, with
  a clear refusal naming the budget; (c) stream the log now (DG-22, v0.2.0); (d) skip
  files over a size, reported as skipped.
- **Default assumption:** (a), with the obvious waste removed (globs compiled once
  per run) and each push's wall time recorded in the audit log from Q1. A push slower
  than about two seconds, or any `maxBuffer` failure, during the week is the evidence
  that promotes DG-22; skipping files (d) is a hole and is not done without it.
- **Answer:** _(to be filled — human)_

---

## Out of scope

Things the ticket might suggest but that we are **not** doing in this task:

- Secrets — keys, tokens, entropy; gitleaks and its kind do it (`README.md:21-33`).
- Server-side or CI enforcement, and rewriting history for the user.
- Reading annotated tags and merges' own changes (DG-18, DG-19) — Q9 asks only
  whether their presence is reported.
- `blockedDomains` in message bodies and added lines (DG-20), chaining a moved-aside
  hook (DG-21), streaming (DG-22, unless Q10's evidence promotes it), the social card
  (DG-23), a `pre-commit` framework definition (DG-24).
- Any network request, telemetry, or a shared list of "known internal names".
- Publishing the week's matches: counts and rates go in the README, the matches do not
  (`BACKLOG.md:75-78`).

---

## Status

- [x] Questions generated
- [ ] Reviewed by a human (<date>, <who>)
- [ ] Answers collected (or assumptions explicitly accepted)

> Next phase: **Research**. The ticket is **not** passed to Research — only the
> questions and their answers.
