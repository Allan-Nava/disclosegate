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

Findings are listed worst first: a blocked domain, an address outside the allowlist, a
term, a name, a path. A file whose *name* carries a term is never printed by name; its
lines are shown under a masked one.

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
  hooks; disclosegate installs its own and does not require it.

## License

MIT
