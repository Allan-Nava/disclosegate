# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

`disclosegate` is a **git pre-push hook** and the CLI around it: before a push leaves,
it reads the commits' metadata and messages, the lines each commit adds — a merge's
own included — and the tagger and message of an annotated tag, and refuses the push when
they carry internal detail — a work address as author, committer, tagger or trailer, or
at a blocked domain anywhere in a message or a line; a private host, service, repository
or client name; a home-directory path, a `file:` URL. It is not a secret scanner;
gitleaks is, and the README says so. It is modelled on its sibling projects:
dependency-free, releases by tag over OIDC, BACKLOG.md as the single source of truth,
the same prose conventions. It is not a Claude Code or Codex plugin and has no plugin
manifests.

`thoughts/DG-1-disclosegate/00-brief.md` is the task definition. No QRSPI phase has been
run on it.

## Layout

```
bin/disclosegate.mjs   the CLI: pre-push · scan · install · uninstall · init · doctor · check;
                       its header comment is the usage text and the site's command list
bin/lib/               rules (pure: the four rules, masking, ordering — no fs, no git), git
                       (one `git log -p --cc -U0 --format=%H` pass for the patches and one
                       `cat-file --batch` for the commit objects, settings pinned —
                       streamed a commit at a time for `scan --history`; annotated tags
                       through `cat-file --batch` too; the pre-push protocol; the patch
                       parser, a merge's combined hunks included),
                       config (user file → repository file, the trust order, remotes,
                       the init template), report (text and JSON, masked),
                       hook (hooks dir, the hook script, the marker, install/uninstall,
                       the moved-aside hook chained after disclosegate),
                       doctor, check (this repository's invariants), changelog
test/                  node:test suites — rules.test.mjs (units; the only file that spells
                       the path shapes out), config, cli (scan/install/init/doctor/exit
                       codes), push (real `git push` through the hook into a bare remote),
                       history (the streamed `--history` held to the collected reading,
                       byte for byte), precommit (`--pre-commit` and a real push through a
                       caller modelled on pre-commit's), framing (a history built to forge
                       the log's framing, read on every path; output that cannot be
                       framed exits 2), changelog; helpers.mjs builds the sandbox
.disclosegate.json     this repository's own repo config: allowPaths for rules.test.mjs only
.github/workflows/     ci.yml (npm test on Node 18/20/22/24 without npm install; the tool on
                       its own history; a refused push by hand; pack; backlog), release.yml
                       (tag disclosegate--v*: npm over OIDC, release notes from the
                       CHANGELOG, close the milestone), release-drift.yml, pages.yml,
                       codeql.yml, backlog-issues.yml (one-way sync)
site/build.mjs         generates site/dist/index.html FROM README.md; adds only the command
                       inventory read off bin/disclosegate.mjs
assets/                logo.svg (single source for favicon, site, README), social-preview.html
.pre-commit-hooks.yaml the pre-commit framework's definition: a pre-push stage hook calling
                       `pre-push --pre-commit`, which reads PRE_COMMIT_* instead of stdin;
                       `check` holds its six load-bearing keys
BACKLOG.md             single source of truth: stable DG-n ids, `<!-- dg: ... -->` metadata
ROADMAP.md             GENERATED from BACKLOG.md — never edit
scripts/release-notes.mjs  the CHANGELOG section for a version — the top of its release notes
CHANGELOG.md           Keep a Changelog with DG-n ids; `check` wants [Unreleased] and the version
CONTRIBUTING.md        local loop, release runbook with the first-publish bootstrap
```

## The rules the code encodes

1. **Before, never after.** The guard runs where a push can still be stopped. A commit
   on a forge stays reachable by SHA after a force-push; nothing downstream undoes it.
2. **Fail closed.** A finding in block mode, a configuration error and an internal error
   all exit non-zero, so the hook refuses the push. A hook that cannot find its binary
   refuses too. The only way past is `--no-verify`, which is the user's decision.
3. **The output is public.** Matches are masked — two characters, an ellipsis, the
   length — everywhere but a terminal with `--show`. Config errors name the key, never
   the value. Paths under the home directory print as `~`. `doctor` prints counts.
4. **The private lists are the user's.** They live in the user file, which is refused
   inside the repository being checked. The repository file may only add `terms` and
   `blockedDomains` and set `allowPaths`; any other key is ignored and reported.
   `allowPaths` exempts files from the path rule only — never from the email or term rules.
   The repository file's own lines are exempt from the terms it adds, and from nothing
   else — the user's terms and the email, name and path rules still read them.
5. **Never sends.** No network call, no telemetry. `git`, two files, stdout and stderr.
6. **Only its own hook.** Marked by `MARKER` in `bin/lib/hook.mjs`; a foreign hook is left
   alone without `--force`, moved aside with it, restored by `uninstall`. Moved aside, it
   is chained, not dropped: the hook script runs it after disclosegate passes the push,
   with the same arguments and stdin (held in a shell variable), and its exit code is the
   hook's; a push disclosegate refuses never reaches it.
7. **What git shows is what is read.** `bin/lib/git.mjs` pins the settings that change
   `git log -p` output — pager, signatures, external diff, textconv, quoted paths, root
   diffs, `diff.relative`, `diff.submodule` — and parses hunks by their counts, so an
   added line that begins with `++ ` is content. A merge is read through `--cc`, its
   combined hunks by the same counts, and only a line new to every parent is its own.
   `scan --history` streams the same pass (`streamCommits`, `splitLog`) and holds
   findings, never commits; whatever it reads must print exactly what the collected
   reading (`logCommits`) would — `history.test.mjs` says so.
8. **No byte frames the log.** Content can hold anything — 0x01, a NUL past git's
   8,000-byte binary sniff (git prints that file as text), a fake header, a bare sha — in
   a line, a message or a name, so nothing a commit carries may delimit anything. The log
   format is `--format=%H`: the sha alone on its line, recognised only outside a hunk,
   while every line inside one is consumed by the hunk's counts. Author, committer and
   message come from the commit object through `git cat-file --batch`, framed by the byte
   length git states (one process kept open beside the streamed log, one request per
   commit). A line outside a hunk that git does not write, a hunk cut short, a sha
   `cat-file` does not return as a commit: each is a `GitError`, exit 2, a refused push —
   never a shorter reading. Chosen over a separator (NUL with `-z` is forgeable, above)
   and over one `git show` per commit, which costs 44 s instead of 0.4 s on a synthetic
   4,000-commit `--history` (DG-29). Do not put a format placeholder that prints commit
   content back into `FORMAT`.

## Verifying a change

```bash
npm test                  # == node bin/disclosegate.mjs check && node --test
npm run backlog           # BACKLOG lint + ROADMAP in step
node bin/disclosegate.mjs scan --history    # the tool on this repository's own history
npm run build:site && open site/dist/index.html
npm pack --dry-run        # the tarball carries bin/, README, CHANGELOG, LICENSE only
```

`check` validates `package.json` (name, version, engines, no runtime dependency,
repository), the CHANGELOG (`[Unreleased]`, a section for the version, Breaking entries
first), the README's load-bearing statements ("never sends" and the `allowPaths`
sentence), `release.yml`, `.disclosegate.json`, `.pre-commit-hooks.yaml` (pre-push stage,
the `--pre-commit` entry, `pass_filenames: false`, `always_run: true`), and turns the path rule and an address
rule on every tracked file except `test/rules.test.mjs`. With a user file present it also
turns your own terms and blocked domains on the tree, masked. Extend it whenever you add
an invariant.

## Conventions

- **Test first.** A rule change starts as a failing case in `test/rules.test.mjs`; a
  behaviour change of the hook as a real push in `test/push.test.mjs`.
- **Neutral fixtures only.** `example.com`, `example.internal`, `*.example`,
  `alice@personal.example`, `/home/user`. Outside `test/rules.test.mjs` a home path is
  assembled (`['', 'home', 'user'].join('/')`), never written, and an address that is
  not a placeholder is assembled too — `check` fails otherwise.
- **Zero runtime dependencies**, Node 18 floor, ESM. `marked` is a devDependency for the
  site and never reaches the tarball.
- **The site has no prose of its own.** Edit README.md and rebuild; the generator adds
  only the command list, from the CLI's header comment.
- Prose: British-leaning spelling, em-dashes, no marketing filler, no decorative emoji.
- **Nothing private in any file**: no real address, hostname, client or repository
  name, no path under a real home directory. Run `scan --history` before pushing.
