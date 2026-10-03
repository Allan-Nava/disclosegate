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
bin/lib/               rules (pure: the four rules and `unread`, masking, ordering — no fs,
                       no git), git (one `git log -p --cc --text -U0 --format=%H` pass for
                       the patches and one `cat-file --batch` for the commit objects,
                       settings pinned — streamed a commit at a time on every path;
                       annotated tags through `cat-file --batch` too; the pre-push
                       protocol; the patch parser, a byte reader with a read limit, a
                       merge's combined hunks included),
                       config (user file → repository file, the trust order, remotes,
                       the init template), report (text and JSON, masked),
                       hook (hooks dir, the hook script, the marker, install/uninstall,
                       the moved-aside hook chained after disclosegate),
                       doctor, check (this repository's invariants), changelog
test/                  node:test suites — rules.test.mjs (units; the only file that spells
                       the path shapes out; DG-31's timing tests and the replaced patterns
                       kept as references), config, cli (scan/install/init/doctor/exit
                       codes), push (real `git push` through the hook into a bare remote),
                       history (the streamed `--history` held to the collected reading,
                       byte for byte), precommit (`--pre-commit` and a real push through a
                       caller modelled on pre-commit's), framing (a history built to forge
                       the log's framing, read on every path; output that cannot be
                       framed exits 2), attributes (DG-30: `-diff`, `binary`, drivers,
                       real binaries, the read limit — on every path), lfs (DG-32: pointers
                       read as their content, a real git-lfs push skipped without it),
                       changelog;
                       helpers.mjs builds the sandbox
.disclosegate.json     this repository's own repo config: allowPaths for rules.test.mjs only
.github/workflows/     ci.yml (npm test on Node 18/20/22/24 without npm install; the tool on
                       its own history; a refused push by hand; pack; backlog), release.yml
                       (tag disclosegate--v*: npm over OIDC, release notes from the
                       CHANGELOG, close the milestone), release-drift.yml, pages.yml,
                       codeql.yml, backlog-issues.yml (one-way sync)
site/build.mjs         generates site/dist/index.html FROM README.md; adds only the command
                       inventory read off bin/disclosegate.mjs
assets/                logo.svg (single source for favicon, site, README), social-preview.html
                       and the social-preview.png rendered from it — the page's og:image
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
   refuses too. So does a file the guard did not read in full: `unread` is a finding. The
   only way past is `--no-verify`, which is the user's decision.
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
   hook's; a push disclosegate refuses never reaches it. Every step is one operation that
   fails where it would replace something — the move is a hard link (a copy of the link
   for a symbolic one, since macOS `link()` follows it) then an unlink, the write is `'wx'`
   unless the hook read was ours — and the config files are read once, `ENOENT` meaning
   absent: no `existsSync` before an act on the same path (DG-34, DG-35).
7. **What git shows is what is read.** `bin/lib/git.mjs` pins the settings that change
   `git log -p` output — pager, signatures, external diff, textconv, binary detection
   (`--text`), quoted paths, root diffs, `diff.relative`, `diff.submodule` — and parses
   hunks by their counts, so an added line that begins with `++ ` is content. A merge is
   read through `--cc`, its combined hunks by the same counts, and only a line new to
   every parent is its own. Every reading — the hook, `--pre-commit`, `scan`, `scan
   --history` — streams the same pass (`streamCommits`, `streamSets`, `splitLog`) and
   holds findings, never commits; whatever it reads must print exactly what the
   collected reading (`logCommits`) would — `history.test.mjs` says so.
8. **No byte frames the log.** Content can hold anything — 0x01, a NUL (every file is
   printed as text, invariant 9), a CR, a fake header, a bare sha — in a line, a message
   or a name, so nothing a commit carries may delimit anything; a line ends at the
   newline byte and nowhere else. The log
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
9. **Nothing is binary to the reading.** git prints `Binary files … differ`, and no
   line, for a file marked `-diff` or `binary` (`.gitattributes`, `.git/info/attributes`,
   the user's `core.attributesFile`), one whose diff driver sets `binary`, one over
   `core.bigFileThreshold`, and one with a NUL in its first 8,000 bytes — so a lock file
   marked `-diff` carried a work address past 0.0.3 (DG-30). Every diff runs with
   `--text`, which ignores all of these at once. Chosen over overriding attributes:
   `-c core.attributesFile=/dev/null` loses to the in-tree `.gitattributes` and to
   `info/attributes`, `--attr-source` (git 2.40) still leaves `info/attributes`, and
   neither touches the NUL sniff or `bigFileThreshold`. `--no-textconv` and
   `--no-ext-diff` stay: the bytes are read, never a driver's rendering. The one place
   git ignores `--text` is the combined diff of a merge (measured on git 2.54); there a
   `Binary files differ` sends the file to `mergeOwn` — one `diff-tree --text` per
   parent, a line the merge's own when every parent's diff adds it. A real binary is
   read as text by every rule, line by line — chosen over extracting strings (a regex
   over the line already finds what a strings pass would) and over reporting it unread
   (a home path in a compiled binary, an address in an image's metadata are leaks).
   Read, it is bounded: `READ_LIMIT` (100 MiB of one file's added text in a commit,
   where GitHub refuses a file) and `COMMIT_LIMIT` (512 MiB of a commit's, about where
   the 0.0.3 collected reading failed on a string too long for V8). Past either, a line
   is consumed by its marker byte and not decoded, so the framing holds, and the file
   is an `unread` finding — refusing in block mode, never a silent skip; a `Binary files`
   line in a two-sided diff, which `--text` should never let git write, is `unread` too.
   A line outside a hunk longer than 1 MiB is not git's: a `GitError`. Cost on a
   synthetic history with 336 MiB of random `-diff` blobs and a 6 MiB lock file:
   `scan --history` 0.16 s before (reading none of them), 5.5 s and 1.1 GB peak RSS
   after; `--text` alone, without the byte reader, took 9.3 s and crashed the hook path
   on a string over V8's limit. Unchanged on six real histories.
10. **The built-in rules are linear in the line.** Every pattern disclosegate itself runs
   on content — the addresses in text and in trailers, the trailer shape, a trailer's
   name, the path patterns, an author name and a tagger header, a `publicEmails`
   wildcard, `check`'s own address pattern — costs time in proportion to the line, so a
   minified bundle, a base64 blob or a binary read as text (invariant 9) costs
   milliseconds; a hook nobody waits for gets `--no-verify` (DG-31). A regex of the shape
   `[class]+@…` is not linear: it starts a match at every character of a run and reads to
   the run's end, n²/2 steps on a line of n letters. So addresses are found from each `@`
   outwards (`addressesIn` in `bin/lib/rules.mjs`), every class a table filled by the
   class's own regex; the trailer shape takes the blanks after its colon atomically
   (`(?=(\s+))\2`), where `\s+(.*)$` gave them back one at a time before a CR; angle
   brackets, a name's trailing blanks and a tagger's `Name <email>` are cut with
   `indexOf`; a wildcard with two stars or more is matched part by part. The results are
   the old patterns' exactly — save one CR at a line's end, which the trailer shape drops
   first, as git does (DG-33): `test/rules.test.mjs` keeps each replaced pattern as the
   reference and holds the scan to it on 20,000 generated inputs, and its timing tests
   run in a child process with a hard stop, because a regex cannot be interrupted in the
   thread that runs it. A new pattern that reads content comes with its timing test. A
   `/regex/` term is not held to this: it is the user's — or, from the repository file,
   its committers' (invariant 4) — a budget per line would refuse every minified file for
   anyone with a regex term, and a time budget cannot stop a regex mid-run without a
   worker per line. A slow term costs time, never coverage, since an interrupted hook
   refuses the push (invariant 2); the README's Limits section says so. Measured: a
   commit adding lines of 25k, 50k and 100k letters, 8.5 s before and 0.12 s after; a
   5.3 MB base64url line, stopped at 300 s before and 0.15 s after; same output on
   57 real histories.
11. **An LFS file is read as its content** (DG-32). The commit holds a pointer; the
   content reaches the forge's LFS store through git-lfs's own pre-push hook, which
   `install --force` chains after disclosegate's, so a refusal uploads nothing (a real
   git-lfs push in `test/lfs.test.mjs` shows both sides). `lfsContent` in
   `bin/lib/git.mjs` takes a file whose added lines hold an `oid sha256:` line, confirms
   the blob at the path is a whole pointer (version line first, under 1024 bytes — a doc
   quoting one is left alone), and reads the object from where git-lfs reads it,
   `<common git dir>/lfs/objects/aa/bb/<oid>` or under `lfs.storage`, as the file's lines
   from 1, within the same budgets. Content not on this machine is `unread`: git-lfs
   cannot upload it either, but the guard cannot vouch for it — so a `--history` scan of
   a clone with only the current objects names every older one; `git lfs fetch --all`
   first. No git-lfs is needed to read: the pointer and the object are plain files.

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
- **The social card is rendered, never drawn.** `assets/social-preview.png` (the page's
  `og:image`, and what goes under Settings → General → Social preview) comes from
  `assets/social-preview.html`; re-render it whenever the card's text goes stale:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
  --disable-gpu --hide-scrollbars --allow-file-access-from-files --window-size=1280,640
  --screenshot=assets/social-preview.png --virtual-time-budget=2500
  "file://$PWD/assets/social-preview.html"` (DG-23).
- Prose: British-leaning spelling, em-dashes, no marketing filler, no decorative emoji.
- **Nothing private in any file**: no real address, hostname, client or repository
  name, no path under a real home directory. Run `scan --history` before pushing.
