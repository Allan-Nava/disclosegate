// DG-29: the framing of the log cannot be forged from what a commit carries. 0.0.3 cut
// the log at every 0x01 and its header at the first 0x03, and git prints a file holding
// those bytes (but no NUL in its first 8,000) as text, and takes them in a message or a
// name: an added line with 0x01 hid every line after it in that commit and counted the
// commit twice. Every path that reads the log — the hook, `scan --range`, `scan
// --history`, `--pre-commit` — is held here to a history built to break the framing.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { GitError, logArgs, logCommits, parseLog, parsePatch, splitLog, streamCommits } from '../bin/lib/git.mjs'
import { ALICE, BOB, HOME_PATH, sandbox } from './helpers.mjs'

const FAKE = 'f'.repeat(40)
const MALLORY = ['mallory', 'example.com'].join('@')

// A history whose content says everything the old framing used for itself: a 0x01 in a
// line, a whole fake header in a line, a line that is a bare sha, a message and an
// author name carrying the separators, a NUL past git's binary sniff, a binary file, a
// merge whose own line holds a 0x01, and an annotated tag by a work address. After
// each hostile line, on a later line, something a rule must find.
function hostile() {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email], terms: ['nimbus'] })
  const c = {}
  c.ctl = sb.commit({ file: 'ctl.txt', content: `one\n\x01two\n${HOME_PATH}\n`, message: 'Control byte' })
  c.header = sb.commit({
    file: 'header.txt',
    content: [`\x01${FAKE}\x02Mallory\x02${MALLORY}\x02Mallory\x02${MALLORY}\x02fake\x03`, c.ctl, `commit ${c.ctl}`, 'diff --git a/x b/x', '@@ -0,0 +1,99 @@', 'deploy to nimbus', ''].join('\n'),
    message: 'Header-shaped lines',
  })
  c.message = sb.commit({ message: `Subject\n\nbody \x01 one \x03 two\x02 after ${HOME_PATH}` })
  c.name = sb.commit({ author: { name: 'Ev\x02il', email: BOB.email }, committer: ALICE, message: 'A separator in a name' })
  c.bin = sb.commit({ file: 'bin.dat', content: `\0binary ${HOME_PATH}\n`, message: 'Binary' })
  c.nul = sb.commit({ file: 'late-nul.txt', content: `${'x'.repeat(9000)}\n\0nul\n${HOME_PATH}\n`, message: 'NUL past the sniff' })
  sb.git(['checkout', '-q', '-b', 'side'])
  sb.commit({ file: 'side.txt', content: 'side\n' })
  sb.git(['checkout', '-q', 'main'])
  sb.commit({ file: 'main.txt', content: 'main\n' })
  sb.git(['merge', '-q', '--no-ff', '--no-commit', 'side'])
  c.merge = sb.commit({ file: 'merge-note.txt', content: 'resolved\n\x01here\non nimbus\n', message: 'Merge side' })
  sb.git(['tag', '-a', 'v1', '-m', 'Release 1'], { extraEnv: { GIT_COMMITTER_NAME: BOB.name, GIT_COMMITTER_EMAIL: BOB.email } })
  c.count = Number(sb.git(['rev-list', '--count', '--all']).stdout.trim())
  return { sb, c }
}

const rows = (j) => j.findings.map((f) => [f.rule, f.sha, f.where, f.match]).sort((a, b) => a.join('\0').localeCompare(b.join('\0')))
const has = (j, rule, sha, where, match) => j.findings.some((f) => f.rule === rule && f.sha === sha && f.where === where && (match === undefined || f.match === match))

test('a 0x01 in an added line hides nothing after it — scan --range, --history, the hook and --pre-commit', () => {
  const { sb, c } = hostile()
  const range = JSON.parse(sb.run(['scan', '--range', 'main', '--json']).stdout)
  const history = JSON.parse(sb.run(['scan', '--history', '--json']).stdout)
  const tip = sb.git(['rev-parse', 'main']).stdout.trim()
  const pc = JSON.parse(sb.run(['pre-push', '--pre-commit', '--json'], { extraEnv: { PRE_COMMIT_REMOTE_NAME: 'origin', PRE_COMMIT_REMOTE_URL: sb.remote, PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/main' } }).stdout)
  const hook = JSON.parse(sb.run(['pre-push', 'origin', sb.remote, '--json'], { input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n` }).stdout)
  for (const [label, j] of [['--range', range], ['--history', history], ['--pre-commit', pc], ['pre-push', hook]]) {
    assert.ok(has(j, 'path', c.ctl, 'ctl.txt:3'), `${label}: the path after the 0x01 line`)
    assert.ok(has(j, 'term', c.merge, 'merge-note.txt:3'), `${label}: the merge's own line after its 0x01 line`)
  }
})

test('each commit is counted once, and the log yields each sha once', () => {
  const { sb, c } = hostile()
  for (const args of [['scan', '--range', 'main'], ['scan', '--history']]) {
    const j = JSON.parse(sb.run([...args, '--json']).stdout)
    assert.equal(j.commits, c.count, args.join(' '))
  }
  const shas = logCommits(sb.work, ['--all']).map((x) => x.sha)
  assert.equal(shas.length, c.count)
  assert.equal(new Set(shas).size, c.count)
  assert.ok(shas.every((s) => /^[0-9a-f]{40}$/.test(s)))
})

test('content that looks like a header is read as content: in a line, in a message, in a name', () => {
  const { sb, c } = hostile()
  const j = JSON.parse(sb.run(['scan', '--history', '--json']).stdout)
  assert.ok(has(j, 'term', c.header, 'header.txt:6'), 'the line after a fake header, a bare sha and a fake hunk')
  assert.ok(!j.findings.some((f) => f.sha === FAKE), 'no commit made of a line')
  assert.ok(has(j, 'path', c.message, 'message'), 'the message after its 0x01 and 0x03')
  assert.ok(has(j, 'email', c.name, 'author', 'bo… (20 chars)'), 'the address after a 0x02 in the author name')
  const [commit] = logCommits(sb.work, [`${c.name}^!`])
  assert.deepEqual(commit.author, { name: 'Ev\x02il', email: BOB.email })
  const [msg] = logCommits(sb.work, [`${c.message}^!`])
  assert.equal(msg.message, `Subject\n\nbody \x01 one \x03 two\x02 after ${HOME_PATH}\n`)
})

// Until DG-30 a binary file was not read at all; it is read as text now, NUL and all.
test('NUL bytes and binary files: a binary file is read as lines, a NUL past the sniff is a line', () => {
  const { sb, c } = hostile()
  const j = JSON.parse(sb.run(['scan', '--history', '--json']).stdout)
  assert.ok(has(j, 'path', c.bin, 'bin.dat:1'), 'the path in a file git calls binary')
  assert.ok(has(j, 'path', c.nul, 'late-nul.txt:3'), 'the line after a NUL git printed as text')
  const [nul] = logCommits(sb.work, [`${c.nul}^!`])
  assert.deepEqual(nul.added.map((a) => [a.line, a.text.length]), [[1, 9000], [2, 4], [3, HOME_PATH.length]])
})

test('scan --history, streamed, and the hook path read the same findings on the same repository', async () => {
  const { sb, c } = hostile()
  const history = JSON.parse(sb.run(['scan', '--history', '--json']).stdout)
  assert.equal(history.commits, c.count, 'agreeing on a short reading is not agreeing')
  assert.ok(has(history, 'path', c.ctl, 'ctl.txt:3'))
  const tip = sb.git(['rev-parse', 'main']).stdout.trim()
  const tag = sb.git(['rev-parse', 'v1']).stdout.trim()
  const z = '0'.repeat(40)
  const hook = JSON.parse(sb.run(['pre-push', 'origin', sb.remote, '--json'], { input: `refs/heads/main ${tip} refs/heads/main ${z}\nrefs/tags/v1 ${tag} refs/tags/v1 ${z}\n` }).stdout)
  assert.equal(hook.commits, history.commits)
  assert.equal(hook.tags, history.tags)
  assert.deepEqual(rows(hook), rows(history))
  process.env.GIT_CONFIG_GLOBAL = sb.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const streamed = []
  for await (const x of streamCommits(sb.work, ['--all'])) streamed.push(x)
  assert.deepEqual(streamed, logCommits(sb.work, ['--all']))
})

test('a merge read through --cc and an annotated tag still work, and a real push is refused', () => {
  const { sb, c } = hostile()
  assert.equal(sb.run(['install']).code, 0)
  const r = sb.push(['origin', 'main', 'v1'])
  assert.notEqual(r.code, 0, r.out)
  assert.ok(!sb.remoteHas('refs/heads/main') && !sb.remoteHas('refs/tags/v1'), 'nothing reached the remote')
  assert.match(r.out, new RegExp(`term\\s+${c.merge.slice(0, 7)}\\s+merge-note\\.txt:3\\s`))
  assert.match(r.out, /email\s+[0-9a-f]{7}\s+tagger\s+bo… \(20 chars\)/)
  assert.match(r.out, new RegExp(`in \\d+ of ${c.count} commits and 1 tag — push refused`))
  const [merge] = logCommits(sb.work, [`${c.merge}^!`])
  assert.deepEqual(merge.added.map((a) => [a.file, a.line, a.text]), [['merge-note.txt', 1, 'resolved'], ['merge-note.txt', 2, '\x01here'], ['merge-note.txt', 3, 'on nimbus']])
})

// The splitter, the collected parser and the patch parser refuse what they cannot
// frame: a scan that quietly reads less is the failure this item is about.
test('fail closed: a log the parser cannot frame is a GitError, never a shorter reading', () => {
  const sha = 'a'.repeat(40)
  const head = `${sha}\n\ndiff --git a/x b/x\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/x\n`
  const bad = {
    'a hunk cut short by the end of the log': `${head}@@ -0,0 +1,3 @@\n+one\n+two\n`,
    'a hunk cut short by the next commit': `${head}@@ -0,0 +1,3 @@\n+one\n${'b'.repeat(40)}\n`,
    'a line outside any hunk that git does not write': `${head}@@ -0,0 +1 @@\n+one\nnot git\n`,
    'text before the first commit': `stray\n${head}@@ -0,0 +1 @@\n+one\n`,
    'a combined hunk with a parent too few': `${sha}\n\ndiff --cc x\nindex 1,2..3\n--- a/x\n+++ b/x\n@@@ -1,0 +1 @@@\n++one\n`,
  }
  for (const [label, text] of Object.entries(bad)) {
    assert.throws(() => parseLog(text), GitError, `parseLog: ${label}`)
    assert.throws(() => {
      const s = splitLog()
      s.push(Buffer.from(text))
      s.end()
    }, GitError, `splitLog: ${label}`)
  }
  assert.throws(() => parsePatch(`diff --git a/x b/x\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+one\n`), GitError, 'parsePatch: a hunk cut short')
  assert.throws(() => parsePatch(`${sha}\n`), GitError, 'parsePatch: a commit line in a single diff')
})

// End to end: a `git` on PATH whose log claims one line more in a hunk than it prints.
// Every reading exits 2 — what the hook script turns into a refused push — instead of
// passing on what it did read. (git puts its own exec-path first on a hook's PATH, so
// the shim cannot reach a real push; the hook's entry point is run as git runs it.)
test('fail closed, end to end: a log that cannot be framed exits 2 on every path', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email] })
  const tip = sb.commit({ file: 'x.txt', content: 'one\ntwo\nthree\n' })
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  const shim = join(sb.base, 'shim')
  mkdirSync(shim)
  writeFileSync(join(shim, 'git'), `#!/bin/sh\ncase " $* " in *" log "*) "${real}" "$@" | sed 's/^@@ -0,0 +1,3 @@$/@@ -0,0 +1,4 @@/'; exit 0 ;; esac\nexec "${real}" "$@"\n`)
  chmodSync(join(shim, 'git'), 0o755)
  const extraEnv = { PATH: `${shim}:${process.env.PATH}` }
  const pc = { PRE_COMMIT_REMOTE_NAME: 'origin', PRE_COMMIT_REMOTE_URL: sb.remote, PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/main' }
  for (const [label, args, opts] of [
    ['scan --range', ['scan', '--range', 'main'], {}],
    ['scan --history', ['scan', '--history'], {}],
    ['scan', ['scan'], {}],
    ['pre-push', ['pre-push', 'origin', sb.remote], { input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n` }],
    ['--pre-commit', ['pre-push', '--pre-commit'], { extraEnv: pc }],
  ]) {
    const r = sb.run(args, { ...opts, extraEnv: { ...extraEnv, ...opts.extraEnv } })
    assert.equal(r.code, 2, `${label}: ${r.out}`)
    assert.match(r.stderr, /git log output could not be read \(the output ended inside a hunk, line \d+\) — refusing rather than reading less/, label)
  }
})

test('the splitter yields what parseLog does at every byte offset of a hostile log', () => {
  const { sb } = hostile()
  const r = spawnSync('git', logArgs(['--all']), { cwd: sb.work, env: sb.env })
  assert.equal(r.status, 0, String(r.stderr))
  const whole = parseLog(r.stdout.toString('utf8'))
  assert.ok(whole.some((p) => p.added.some((a) => a.text === '\x01two')))
  for (let cut = 0; cut <= r.stdout.length; cut += 7) {
    const s = splitLog()
    const got = [...s.push(r.stdout.subarray(0, cut)), ...s.push(r.stdout.subarray(cut)), ...s.end()]
    assert.deepEqual(got, whole, `split at byte ${cut}`)
  }
})

test('the pinned settings: diff.relative from a subdirectory and diff.submodule=log change nothing', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email] })
  sb.commit({ file: 'sub/keep.txt', content: 'keep\n' })
  const top = sb.commit({ file: 'top.txt', content: `${HOME_PATH}\n` })
  // A gitlink without a submodule: what `diff.submodule=log` would describe in lines of
  // its own, outside any hunk.
  sb.git(['update-index', '--add', '--cacheinfo', `160000,${top},mod`])
  sb.git(['commit', '-q', '-m', 'A gitlink'])
  writeFileSync(sb.env.GIT_CONFIG_GLOBAL, '[init]\n\tdefaultBranch = main\n[diff]\n\trelative = true\n\tsubmodule = log\n', { flag: 'a' })
  const r = sb.run(['scan', '--range', 'main', '--json'], { cwd: join(sb.work, 'sub') })
  assert.equal(r.code, 1, r.out)
  assert.ok(JSON.parse(r.stdout).findings.some((f) => f.where === 'top.txt:1'))
})
