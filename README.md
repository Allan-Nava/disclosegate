<p align="center"><img src="https://raw.githubusercontent.com/Allan-Nava/disclosegate/main/assets/logo.svg" width="96" height="96" alt="disclosegate"></p>

# disclosegate — internal detail stopped before the push

A public repository publishes more than its code: every commit carries an author and a
committer address, its message can name a private host or a client, and an added line
can hold the absolute path of someone's home directory. disclosegate is a **pre-push
hook** that reads what a push is about to send — the commits' metadata and messages, the
lines each commit adds, and the tagger and message of an annotated tag — and **refuses
the push** when it finds what your own rule says must not be public. It checks *before*,
because after is too late: once a commit is on a forge it stays reachable by its SHA even
when a force-push has removed it from every branch.

> **Status: 0.0.3, on npm — run it in `audit` mode.** The hook, the four rules, the
> config with its trust order, `scan`, `install`, `init`, `doctor` and `check` are
> written and covered by tests that run real `git push` commands against a bare remote.
> What is still missing is evidence from real work: the false-positive rate on real
> pushes is unmeasured, so set `"mode": "audit"` — findings are printed, the push goes
> through — until 0.1.0. v0.1.0 waits for a week of the guard in `audit` mode on the
> maintainer's own repositories, every finding classified true or false and the result
> recorded here, dated (DG-14 in [BACKLOG.md](BACKLOG.md)).

## Why not gitleaks

[gitleaks](https://github.com/gitleaks/gitleaks), git-secrets and trufflehog find
**secrets**: keys, tokens, passwords — strings with a shape and an entropy, the same for
everyone. Use one of them; disclosegate does not try to.

What they do not find is **internal detail**, because it has no shape and differs per
person: your work address as the author of a commit to a personal project, a
`Co-authored-by:` trailer naming a colleague's corporate address, the name of a private
service or a client in a commit message, a home-directory path pasted into a README. None
of these is a credential, and every one of them is something a maintainer's own rule
forbids in public. disclosegate checks that rule — from a list only you hold — at the
last moment it can still be applied.

## Install

```bash
npm install -g disclosegate
cd your-repository
disclosegate init      # ~/.disclosegate.json, placeholders only
disclosegate install   # .git/hooks/pre-push
disclosegate doctor
```

Then set `"mode": "audit"` in `~/.disclosegate.json` until 0.1.0 (see the status above).
`disclosegate install` once in each repository, or once into a global `core.hooksPath`.
Install it globally, not through `npx`: the hook remembers the script that installed
it, and npm prunes its `npx` cache, after which the hook falls back to a `disclosegate`
on `PATH` and, finding none, refuses the push rather than silently stop guarding.

Node 18 or later. No runtime dependency.

## The hook

`disclosegate install` writes `.git/hooks/pre-push` — or into `core.hooksPath` when that
is set, so a global `core.hooksPath` covers every repository at once. The file carries a
marker comment; `install` never overwrites a hook without it unless given `--force`, which
moves the other hook to `pre-push.before-disclosegate`, and `uninstall` removes only its
own hook and puts the moved one back.

A hook moved aside keeps running: disclosegate goes first, and when it passes the push the
other hook runs with the same arguments and the same stdin, byte for byte, and its exit
code is the hook's — so either of the two can refuse the push. A push disclosegate refuses
never reaches the other hook. It runs from its new name, so a hook that dispatches on its
own file name (`$0`) sees `pre-push.before-disclosegate`; one that is not executable is
skipped with a warning, as git skips it. `disclosegate doctor` says when a hook is chained.
A hook installed by 0.0.3 or earlier does not chain: run `disclosegate install` again to
update it.

git runs the hook with the remote's name and URL, and one line per ref on stdin:

| The push | What is read |
|---|---|
| deletes a branch | nothing — a deletion publishes nothing |
| creates a branch | every commit no ref of that remote already has: `git rev-list <local> --not --remotes=<remote>` |
| updates a branch | `<remote-sha>..<local-sha>`; if this repository lacks the remote tip, the new-branch rule |
| pushes an annotated tag | the tag object — its tagger and message, and those of a tag it points at — and its commits by the two rules above |

A finding refuses the whole push, and nothing reaches the remote:

```text
disclosegate: 2 findings in 1 of 3 commits — push refused

  email  4e1f0a2  author        bo… (20 chars)  not in publicEmails
  term   4e1f0a2  deploy.txt:2  ni… (13 chars)  term

Nothing has left this machine. Rewrite the commits, then push again:
  ...
```

`git push --no-verify` skips the hook, as it skips every pre-push hook — knowingly, once.

## With the pre-commit framework

A repository whose hooks are managed by [pre-commit](https://pre-commit.com) can run
disclosegate from its config instead — `.pre-commit-hooks.yaml` defines it as a
`pre-push` stage hook (pre-commit 3.2 or later):

```yaml
repos:
  - repo: https://github.com/Allan-Nava/disclosegate
    rev: disclosegate--vX.Y.Z   # a release tag — the first after 0.0.3 carries the definition
    hooks:
      - id: disclosegate
```

```bash
pre-commit install --hook-type pre-push
```

It reads the same user file and applies the same rules, modes and remote enforcement.
pre-commit reads git's stdin itself, so its entry, `disclosegate pre-push --pre-commit`,
reads what pre-commit passes instead: `PRE_COMMIT_REMOTE_NAME` and `PRE_COMMIT_REMOTE_URL`,
and either `PRE_COMMIT_FROM_REF..PRE_COMMIT_TO_REF` or, for a branch that starts at a root
commit, everything `PRE_COMMIT_LOCAL_BRANCH` has that no ref of the remote has. A missing
variable or a file name on the command line is a usage error, and refuses the push.

That interface is narrower than git's, and the difference is pre-commit's: it hands its
hooks **one ref — the first that sends anything**. A push of several refs at once is
checked on that one only, and a tag pushed onto commits the remote already has runs no
hook at all, so its tagger and message go unread. The git hook reads every ref. For the
whole push and pre-commit's other hooks, install both: `disclosegate install --force`
moves pre-commit's `pre-push` hook aside and chains it after disclosegate.

## Configuration

Two files, in a trust order.

**The user file**, `~/.disclosegate.json` (or the path in `DISCLOSEGATE_CONFIG`), holds
the private lists. It **must never live in a repository** — what it lists is exactly
what must not be published — and disclosegate refuses to run with a user file inside the
repository it is checking. `disclosegate init` writes a template of placeholders with
comments, and never overwrites an existing file:

```jsonc
{
  "publicEmails": ["you@personal.example", "*@users.noreply.example"],
  "blockedDomains": ["work.example"],
  "terms": ["internal-host.example", "/client-[a-z]+\\.example/i"],
  "blockedNames": [],
  "allowPaths": [],
  "mode": "block",
  "remotes": { "enforce": ["github.com/*"], "skip": [] }
}
```

**The repository file**, `.disclosegate.json` at the top of a repository, can be written
by anyone with commit access, so it may only **tighten**: add `terms` and
`blockedDomains`. It may also set `allowPaths`, globs such as `test/fixtures/**` for files
that have to quote a path. `allowPaths` exempts files from the path rule only — never from the email or term rules.
Every other key in it — `publicEmails`, `mode`, `remotes` — is ignored, a warning says
so on every run, and `doctor` lists it. The file's own lines are exempt from the terms
it adds — or the commit that adds it would be refused by it — but not from a term in the
user file or from any other rule; a term written there is public, so it fits a name that
is already out, never a private one.

`mode` is `block` (the default: a finding refuses the push) or `audit` (findings are
printed and the push goes through). `remotes.enforce` and `remotes.skip` are globs, `*`
the wildcard, matched against the remote URL normalised to `host/path` — so
`github.com/*` covers the SSH and HTTPS forms alike; skip wins, and no `enforce` list
means every remote. A missing user file is not an error: the path rule needs no list and
still runs, and `doctor` says what is missing.

## The rules

| Rule | Reads | A finding when |
|---|---|---|
| `email` | author, committer, tagger, every trailer address (`Co-authored-by:`, `Signed-off-by:`, any `Token: … <address>`); any address in a commit or tag message or an added line | the address is not in `publicEmails` (off while that list is empty, and never applied to an address in a message or a line); or its domain, or a parent of it, is in `blockedDomains` — whatever `publicEmails` says, wherever the address is |
| `term` | commit and tag messages, added lines, the names of files with added lines | an entry of `terms` matches: a plain string case-insensitively, `/source/flags` as a regular expression |
| `path` | commit and tag messages, added lines | `/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\` or a `file:///` URL naming a path. Built in, always on; a URL such as `https://example.com/home/about/` is not a home |
| `name` | author, committer, tagger and trailer names | the name is in `blockedNames` |

An added line is one a commit adds to its parent. A merge's are the lines new to every
parent — what resolving a conflict writes — read from its combined diff (`git log --cc`);
a line one side already had was read in that side's own commit, or is already public.

Nothing a commit carries can change where the reading thinks one commit ends and the
next begins: a control byte, a NUL that git still prints as text, a line shaped like a
commit header, in a file, a message or a name, is read as what it is. If the output of
`git` is ever not in the shape disclosegate reads, that is an error — exit 2, and in the
hook a refused push — never a shorter scan.

**Nothing is binary to the reading.** git prints `Binary files … differ` instead of the
lines of a file marked `-diff` or `binary` — in `.gitattributes`, in
`.git/info/attributes` or in the file your `core.attributesFile` names — of a file whose
diff driver says `binary`, of one larger than `core.bigFileThreshold`, and of one with a
NUL in its first 8,000 bytes. Lock files are often marked that way. disclosegate reads all
of them as text (`git log --text`), byte for byte: an image, an archive or a compiled
binary goes through every rule line by line, a line being whatever ends in a newline
byte. A `textconv` or external diff driver in your config is never run — the bytes are
read, not a rendering of them. A merge's own lines in such a file, where git's combined
diff ignores `--text`, are read through one diff per parent. What a binary holds
compressed — a zip entry, a PDF stream, a PNG text chunk — is bytes to the rules, not
text.

One finding is about the reading itself rather than a rule: **`unread`**. A file's added
lines are read up to 100 MiB in one commit — the size GitHub refuses a file at — and a
commit's up to 512 MiB in all, so a commit of large binaries costs bounded time and
memory. A file past either is read up to there and then named as an `unread` finding:
nothing is skipped without saying so. It refuses the push in block mode like any other
finding — the guard cannot vouch for what it did not read — and is printed in audit mode
and in `--json`. Read the file yourself; if it is clean, `git push --no-verify` is your
decision to make.

Findings are listed worst first: a blocked domain, an address outside the allowlist, a
term, a name, a path, a file not read in full. A file whose *name* carries a term is never
printed by name; its lines are shown under a masked one.

## Output

Every finding has the commit's short sha — or the tag object's — where it is (`author`,
`committer`, `tagger`, `trailer Co-authored-by`, `message`, `tag message`, `file:line`,
`file name`), the rule, and the match **masked** — its first two characters, an ellipsis
and its length. The output of a hook lands in terminals, CI logs and pasted issues, and a
guard that printed what it found would publish it itself. `--show` prints matches in full, and only when stdout is a
terminal; elsewhere it is ignored with a note. Paths under your home directory are shown
with `~`.

`--json` gives the same findings for machines, masked by the same rule. Exit codes: `0`
clean, or any result in audit mode; `1` findings in block mode; `2` a usage or
configuration error — which, in the hook, also refuses the push.

## Commands

```bash
disclosegate scan                    # what a push would send now: @{upstream}..HEAD, or what no remote has
disclosegate scan --range main..HEAD
disclosegate scan --staged           # the index, and the identity the next commit would carry
disclosegate scan --history          # every commit and annotated tag reachable from any ref — the audit of a repository
disclosegate install [--force] | uninstall
disclosegate init                    # the template user file; refuses to overwrite
disclosegate doctor                  # config found, rules active, hook installed, remotes enforced
```

Every reading — the hook's, `scan`'s, `scan --history`'s — is a stream: each commit goes
through the rules as git writes it and only its findings are kept, so a push or a history
of any size is read in about the memory of its largest commit — on a synthetic
4,000-commit history with 250 MB of patches, a peak of 209 MB against 1.1 GB when it was
read whole, with the same output. Reading binary files costs time where there are large
ones: a synthetic history with 336 MiB of random blobs under `-diff` takes 5.5 s, where
0.2 s read none of them.

## Limits

- **Git LFS content is not read.** A file tracked by Git LFS is a pointer in the commit,
  and the pointer is what disclosegate reads. The content goes to the forge's LFS store
  through git-lfs's own pre-push hook, beside the push and unread: an address inside an
  LFS-tracked file reaches that store, and no `unread` finding names the file (DG-32).
- **What a binary holds compressed** — a zip entry, a PDF stream, a PNG text chunk — is
  bytes to the rules, not text.
- **A file past the read limits** is read up to there and reported as `unread`, never
  skipped silently.
- **A `/regex/` term runs as you wrote it.** The built-in rules take time in proportion
  to a line — a minified bundle or a base64 line of several MB is read in milliseconds —
  but a term written as a regular expression is yours, and one with nested quantifiers,
  such as `/(a+)+b/`, can take minutes on a long line. That costs time, never coverage:
  a hook that is interrupted refuses the push. A plain-string term is a literal search
  and stays fast. The same holds for a term the repository file adds.

## What it never does

- It **never sends** anything anywhere. No network request, no telemetry, no update
  check: it runs `git`, reads two files, and prints.
- It never prints an unmasked match into anything that is not a terminal.
- It never prints the values of your lists — not in errors, not in `doctor`, which
  shows counts and key names.
- It never overwrites or removes a hook it did not write, and never overwrites your
  user file.
- It never lets a repository loosen your rules.
- It does not look for secrets. Run gitleaks for that, beside it.

## Prior art

- [gitleaks](https://github.com/gitleaks/gitleaks) — secrets in git history and in
  changes, by rule and entropy; the tool to run for credentials.
- [git-secrets](https://github.com/awslabs/git-secrets) — prohibited patterns in commits
  and messages through git hooks; the closest in mechanism, aimed at keys.
- [trufflehog](https://github.com/trufflesecurity/trufflehog) — secrets across many
  sources, with live verification of what it finds.
- [pre-commit](https://pre-commit.com) — the framework many repositories use to manage
  hooks; disclosegate installs its own and does not require it, and ships a definition for
  it (see [With the pre-commit framework](#with-the-pre-commit-framework)).

## License

MIT
