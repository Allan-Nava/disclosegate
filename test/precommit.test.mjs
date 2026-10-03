// DG-24: the pre-commit framework. Its pre-push stage reads git's stdin itself and
// hands a hook the first ref that sends anything, through environment variables —
// PRE_COMMIT_FROM_REF / PRE_COMMIT_TO_REF, or only PRE_COMMIT_LOCAL_BRANCH when the
// branch starts at a root commit, and PRE_COMMIT_REMOTE_NAME / PRE_COMMIT_REMOTE_URL
// (pre_commit/commands/hook_impl.py `_pre_push_ns` and run.py, main, read 2026-10-03).
// `disclosegate pre-push --pre-commit` reads those, and .pre-commit-hooks.yaml calls it.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { preCommitHooksProblems } from '../bin/lib/check.mjs'
import { ALICE, BIN, BOB, sandbox } from './helpers.mjs'

const fw = (sb, env, args = []) => sb.run(['pre-push', '--pre-commit', ...args], { extraEnv: { PRE_COMMIT_REMOTE_NAME: 'origin', PRE_COMMIT_REMOTE_URL: sb.remote, ...env } })

const history = () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email] })
  const c1 = sb.commit()
  const c2 = sb.commit()
  const c3 = sb.commit({ author: BOB })
  return { sb, c1, c2, c3 }
}

test('--pre-commit reads PRE_COMMIT_FROM_REF..PRE_COMMIT_TO_REF, and nothing outside it', () => {
  const { sb, c1, c2, c3 } = history()
  const clean = fw(sb, { PRE_COMMIT_FROM_REF: c1, PRE_COMMIT_TO_REF: c2 })
  assert.equal(clean.code, 0, clean.out)
  assert.match(clean.stdout, /1 commit checked — clean/)
  const dirty = fw(sb, { PRE_COMMIT_FROM_REF: c2, PRE_COMMIT_TO_REF: c3 }, ['--json'])
  assert.equal(dirty.code, 1, dirty.out)
  const j = JSON.parse(dirty.stdout)
  assert.equal(j.context, 'pre-push')
  assert.equal(j.commits, 1)
  assert.deepEqual(j.findings.map((f) => [f.rule, f.where, f.match]), [
    ['email', 'author', 'bo… (20 chars)'],
    ['email', 'committer', 'bo… (20 chars)'],
  ])
})

test('--pre-commit with only PRE_COMMIT_LOCAL_BRANCH reads what no ref of the remote has', () => {
  const { sb } = history()
  const r = fw(sb, { PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/main' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.stdout, /2 findings in 1 of 3 commits — push refused/)
})

test('--pre-commit reads an annotated tag at PRE_COMMIT_TO_REF', () => {
  const { sb, c1, c2 } = history()
  sb.git(['tag', '-a', 'v1', '-m', 'Release 1', c2], { extraEnv: { GIT_COMMITTER_NAME: BOB.name, GIT_COMMITTER_EMAIL: BOB.email } })
  const tag = sb.git(['rev-parse', 'v1']).stdout.trim()
  const r = fw(sb, { PRE_COMMIT_FROM_REF: c1, PRE_COMMIT_TO_REF: tag })
  assert.equal(r.code, 1, r.out)
  assert.match(r.stdout, /email\s+[0-9a-f]{7}\s+tagger/)
})

test('--pre-commit honours remote enforcement and audit mode', () => {
  const { sb, c2, c3 } = history()
  sb.userConfig({ publicEmails: [ALICE.email], remotes: { skip: ['*/remote.git'] } })
  const skipped = fw(sb, { PRE_COMMIT_FROM_REF: c2, PRE_COMMIT_TO_REF: c3 })
  assert.equal(skipped.code, 0)
  assert.match(skipped.stderr, /remote origin is not enforced/)
  sb.userConfig({ publicEmails: [ALICE.email], mode: 'audit' })
  const audit = fw(sb, { PRE_COMMIT_FROM_REF: c2, PRE_COMMIT_TO_REF: c3 })
  assert.equal(audit.code, 0)
  assert.match(audit.stdout, /audit mode, nothing refused/)
})

test('--pre-commit fails closed: no remote, no refs, file names, an option for a ref', () => {
  const { sb, c2, c3 } = history()
  const noUrl = sb.run(['pre-push', '--pre-commit'], { extraEnv: { PRE_COMMIT_REMOTE_NAME: 'origin', PRE_COMMIT_FROM_REF: c2, PRE_COMMIT_TO_REF: c3 } })
  assert.equal(noUrl.code, 2)
  assert.match(noUrl.stderr, /PRE_COMMIT_REMOTE_URL/)
  const noRefs = fw(sb, {})
  assert.equal(noRefs.code, 2)
  assert.match(noRefs.stderr, /PRE_COMMIT_TO_REF/)
  const files = fw(sb, { PRE_COMMIT_FROM_REF: c2, PRE_COMMIT_TO_REF: c3 }, ['file-1.txt'])
  assert.equal(files.code, 2)
  assert.match(files.stderr, /pass_filenames: false/)
  assert.equal(fw(sb, { PRE_COMMIT_LOCAL_BRANCH: '--all' }).code, 2, 'a ref cannot smuggle an option into git')
  assert.equal(fw(sb, { PRE_COMMIT_FROM_REF: '--all', PRE_COMMIT_TO_REF: c3 }).code, 2)
})

// A real push through a pre-push hook that does what pre-commit's does for the first
// ref: read git's stdin, set the variables, call the entry with no stdin.
test('a real push through a pre-commit-style caller is refused, and a clean one lands', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email] })
  const hook = join(sb.work, '.git', 'hooks', 'pre-push')
  writeFileSync(
    hook,
    `#!/bin/sh
read -r lref lsha rref rsha || exit 0
export PRE_COMMIT_REMOTE_NAME="$1" PRE_COMMIT_REMOTE_URL="$2" PRE_COMMIT_LOCAL_BRANCH="$lref" PRE_COMMIT_REMOTE_BRANCH="$rref"
if [ "$rsha" != ${'0'.repeat(40)} ] && git cat-file -e "$rsha^{commit}" 2>/dev/null; then
  export PRE_COMMIT_FROM_REF="$rsha" PRE_COMMIT_TO_REF="$lsha"
else
  first=$(git rev-list "$lsha" --topo-order --reverse --not --remotes="$1" | head -n 1)
  [ -n "$first" ] || exit 0
  if ! git rev-list --max-parents=0 "$lsha" | grep -qx "$first"; then
    export PRE_COMMIT_FROM_REF=$(git rev-parse "$first^") PRE_COMMIT_TO_REF="$lsha"
  fi
fi
exec '${process.execPath}' '${BIN}' pre-push --pre-commit </dev/null
`,
    { mode: 0o755 },
  )
  sb.commit()
  const first = sb.push()
  assert.equal(first.code, 0, first.out)
  assert.ok(sb.remoteHas('refs/heads/main'))
  sb.commit({ author: BOB })
  const refused = sb.push()
  assert.notEqual(refused.code, 0)
  assert.match(refused.out, /push refused/)
  assert.doesNotMatch(refused.out, /bob@example/)
  sb.git(['checkout', '-q', '-b', 'topic', 'HEAD~1'])
  sb.commit({ file: 'topic.txt' })
  const topic = sb.push(['origin', 'topic'])
  assert.equal(topic.code, 0, topic.out)
  assert.match(topic.out, /1 commit checked — clean/)
})

test('.pre-commit-hooks.yaml defines a pre-push stage hook that calls --pre-commit', () => {
  const text = readFileSync(new URL('../.pre-commit-hooks.yaml', import.meta.url), 'utf8')
  assert.deepEqual(preCommitHooksProblems(text), [])
  assert.match(preCommitHooksProblems(text.replace('pass_filenames: false', 'pass_filenames: true')).join('\n'), /pass_filenames: false/)
  assert.match(preCommitHooksProblems(text.replace('always_run: true', '')).join('\n'), /always_run: true/)
  assert.match(preCommitHooksProblems(text.replace('stages: [pre-push]', 'stages: [pre-commit]')).join('\n'), /stages: \[pre-push\]/)
})
