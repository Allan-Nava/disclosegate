<p align="center"><img src="https://raw.githubusercontent.com/Allan-Nava/disclosegate/main/assets/logo.svg" width="96" height="96" alt="disclosegate"></p>

# disclosegate — internal detail stopped before the push

A public repository publishes more than its code: every commit carries an author and a
committer address, its message can name a private host or a client, and an added line
can hold the absolute path of someone's home directory. disclosegate is a **pre-push
hook** that reads what a push is about to send — the commits' metadata and messages, and
the lines each commit adds — and **refuses the push** when it finds what your own rule
says must not be public. It checks *before*, because after is too late: once a commit is
on a forge it stays reachable by its SHA even when a force-push has removed it from
every branch.

> **Status: 0.0.1, not released.** The hook, the four rules, the config with its trust
> order, `scan`, `install`, `init`, `doctor` and `check` are written and covered by
> tests that run real `git push` commands against a bare remote. What is still missing
> is evidence from real work: v0.1.0 — the first version on npm — waits for a week of the
> guard in `audit` mode on the maintainer's own repositories, every finding classified
> true or false and the result recorded here, dated (DG-14 in [BACKLOG.md](BACKLOG.md)).

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

From a checkout, until v0.1.0 is on npm:

```bash
git clone https://github.com/Allan-Nava/disclosegate
cd your-repository
node ../disclosegate/bin/disclosegate.mjs init      # ~/.disclosegate.json, placeholders only
node ../disclosegate/bin/disclosegate.mjs install   # .git/hooks/pre-push
node ../disclosegate/bin/disclosegate.mjs doctor
```

Once published, install it globally — `npm install -g disclosegate`, then
`disclosegate install` in each repository. Not through `npx`: the hook remembers the
script that installed it, and npm prunes its `npx` cache, after which the hook falls back
to a `disclosegate` on `PATH` and, finding none, refuses the push rather than silently
stop guarding.

Node 18 or later. No runtime dependency.

## The hook

`disclosegate install` writes `.git/hooks/pre-push` — or into `core.hooksPath` when that
is set, so a global `core.hooksPath` covers every repository at once. The file carries a
marker comment; `install` never overwrites a hook without it unless given `--force`, which
moves the other hook to `pre-push.before-disclosegate` (it then no longer runs), and
`uninstall` removes only its own hook and puts the moved one back.

git runs the hook with the remote's name and URL, and one line per ref on stdin:

| The push | What is read |
|---|---|
| deletes a branch | nothing — a deletion publishes nothing |
| creates a branch | every commit no ref of that remote already has: `git rev-list <local> --not --remotes=<remote>` |
| updates a branch | `<remote-sha>..<local-sha>`; if this repository lacks the remote tip, the new-branch rule |

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
so on every run, and `doctor` lists it.

`mode` is `block` (the default: a finding refuses the push) or `audit` (findings are
printed and the push goes through). `remotes.enforce` and `remotes.skip` are globs, `*`
the wildcard, matched against the remote URL normalised to `host/path` — so
`github.com/*` covers the SSH and HTTPS forms alike; skip wins, and no `enforce` list
means every remote. A missing user file is not an error: the path rule needs no list and
still runs, and `doctor` says what is missing.

## The rules

| Rule | Reads | A finding when |
|---|---|---|
| `email` | author, committer, every trailer address (`Co-authored-by:`, `Signed-off-by:`, any `Token: … <address>`) | the address is not in `publicEmails` (off while that list is empty); or its domain, or a parent of it, is in `blockedDomains` — whatever `publicEmails` says |
| `term` | commit messages, added lines, the names of files with added lines | an entry of `terms` matches: a plain string case-insensitively, `/source/flags` as a regular expression |
| `path` | commit messages, added lines | `/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\` or a `file:///` URL naming a path. Built in, always on; a URL such as `https://example.com/home/about/` is not a home |
| `name` | author, committer and trailer names | the name is in `blockedNames` |

Findings are listed worst first: a blocked domain, an address outside the allowlist, a
term, a name, a path. A file whose *name* carries a term is never printed by name; its
lines are shown under a masked one.

## Output

Every finding has the commit's short sha, where it is (`author`, `committer`,
`trailer Co-authored-by`, `message`, `file:line`, `file name`), the rule, and the match
**masked** — its first two characters, an ellipsis and its length. The output of a hook
lands in terminals, CI logs and pasted issues, and a guard that printed what it found
would publish it itself. `--show` prints matches in full, and only when stdout is a
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
disclosegate scan --history          # every commit reachable from any ref — the audit of a repository
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
