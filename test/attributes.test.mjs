// DG-30: what git would print as "Binary files … differ" is read all the same. A `-diff`
// or `binary` attribute — in the repository's .gitattributes, in .git/info/attributes or
// in a file named by the user's `core.attributesFile` — a diff driver set to `binary`, a
// `core.bigFileThreshold`, a NUL in a file's first 8,000 bytes: each made git print one
// line instead of the file's lines, and 0.0.3 read none of them. Lock files are often
// marked that way, so an internal registry host or a work address in one passed.
//
// Now every file is read as text, its bytes as they are; past a read limit per commit,
// the file is a finding of its own (`unread`) — never a silent skip.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { missingDiffFlags } from '../bin/lib/check.mjs'
import { logArgs, logCommits, parseLog, parsePatch, splitLog } from '../bin/lib/git.mjs'
import { ALICE, BOB, HOME_PATH, sandbox } from './helpers.mjs'

const MiB = 1024 * 1024
const CFG = { publicEmails: [ALICE.email], terms: ['nimbus'], blockedDomains: ['example.internal'] }
const has = (j, rule, where, sha) => j.findings.some((f) => f.rule === rule && f.where === where && (sha === undefined || f.sha === sha))
const json = (r) => {
  assert.ok(r.stdout.trim().startsWith('{'), r.out)
  return JSON.parse(r.stdout)
}
const range = (sb, opts) => json(sb.run(['scan', '--range', 'main', '--json'], opts))
const rows = (j) => j.findings.map((f) => [f.rule, f.sha, f.where, f.match].join(' ')).sort()

test('a term in a file the repository marks -diff is found, and a real push is refused', () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  sb.commit({ file: '.gitattributes', content: 'yarn.lock -diff\n' })
  const c = sb.commit({ file: 'yarn.lock', content: 'pkg@^1.0.0:\n  resolved "https://registry.nimbus.example/pkg-1.0.0.tgz"\n' })
  assert.match(sb.git(['show', '--format=', c]).stdout, /^Binary files \/dev\/null and b\/yarn\.lock differ$/m, 'git itself hides the file')
  assert.ok(has(range(sb), 'term', 'yarn.lock:2', c))
  assert.equal(sb.run(['install']).code, 0)
  const r = sb.push()
  assert.notEqual(r.code, 0, r.out)
  assert.ok(!sb.remoteHas('refs/heads/main'), 'nothing reached the remote')
  assert.match(r.out, /term\s+[0-9a-f]{7}\s+yarn\.lock:2\s/)
})

test('a work address in a lock file marked binary is found, and a real push is refused', () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  sb.commit({ file: '.gitattributes', content: '*.lock binary\n' })
  const c = sb.commit({ file: 'deps.lock', content: `# generated\nmaintainer: ${BOB.email}\n` })
  assert.ok(has(range(sb), 'email', 'deps.lock:2', c))
  assert.equal(sb.run(['install']).code, 0)
  const r = sb.push()
  assert.notEqual(r.code, 0, r.out)
  assert.ok(!sb.remoteHas('refs/heads/main'))
  assert.match(r.out, /email\s+[0-9a-f]{7}\s+deps\.lock:2\s+bo… \(20 chars\)\s+blocked domain/)
})

test("what the user's git config marks binary is read too: core.attributesFile, info/attributes, a binary driver, core.bigFileThreshold", () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  const attrs = join(sb.home, 'attributes')
  writeFileSync(attrs, 'global.txt -diff\n')
  appendFileSync(sb.env.GIT_CONFIG_GLOBAL, `[core]\n\tattributesFile = ${attrs}\n\tbigFileThreshold = 1k\n[diff "opaque"]\n\tbinary = true\n`)
  mkdirSync(join(sb.work, '.git', 'info'), { recursive: true })
  writeFileSync(join(sb.work, '.git', 'info', 'attributes'), 'info.txt binary\ndriver.txt diff=opaque\n')
  const c = {}
  c.global = sb.commit({ file: 'global.txt', content: 'one\nnimbus global\n' })
  c.info = sb.commit({ file: 'info.txt', content: 'one\nnimbus info\n' })
  c.driver = sb.commit({ file: 'driver.txt', content: 'one\nnimbus driver\n' })
  c.big = sb.commit({ file: 'big.txt', content: `${'x'.repeat(2000)}\nnimbus big\n` })
  for (const k of Object.keys(c)) assert.match(sb.git(['show', '--format=', c[k]]).stdout, /^Binary files /m, `git hides ${k}.txt`)
  const j = range(sb)
  for (const k of Object.keys(c)) assert.ok(has(j, 'term', `${k}.txt:2`, c[k]), `${k}.txt`)
})

test('a textconv or external diff driver in the user config changes nothing: the bytes are read', () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  // A driver whose textconv and diff command print nothing: were either run, the file
  // would look empty. The file holds a NUL, so without them git calls it binary.
  appendFileSync(sb.env.GIT_CONFIG_GLOBAL, '[diff "tc"]\n\ttextconv = true\n\tcommand = true\n')
  sb.commit({ file: '.gitattributes', content: '*.doc diff=tc\n' })
  const c = sb.commit({ file: 'notes.doc', content: Buffer.from(`\0\x01header\ndeploy to nimbus\n${HOME_PATH}\n`, 'latin1') })
  const j = range(sb)
  assert.ok(has(j, 'term', 'notes.doc:2', c), 'the term')
  assert.ok(has(j, 'path', 'notes.doc:3', c), 'the home path')
})

test('a real binary file is read as text by every rule — the address, the term, the path among its bytes', () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
    Buffer.from(`\0\0author ${BOB.email}\0`, 'latin1'),
    Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03, 0x0d, 0x0a]),
    Buffer.from(`\x01built on nimbus\0${HOME_PATH}\0\n`, 'latin1'),
    Buffer.from([0xde, 0xad, 0xbe, 0xef]),
  ])
  const c = sb.commit({ file: 'logo.png', content: bytes })
  const after = sb.commit({ file: 'after.txt', content: 'nimbus after\n' })
  const j = range(sb)
  // The signature's own CR LF and LF end lines 1 and 2: a line is what ends in 0x0A.
  assert.ok(has(j, 'email', 'logo.png:3', c), 'the address')
  assert.ok(has(j, 'term', 'logo.png:4', c), 'the term')
  assert.ok(has(j, 'path', 'logo.png:4', c), 'the path')
  assert.ok(has(j, 'term', 'after.txt:1', after), 'and the commit after it')
  assert.equal(j.commits, 2)
  assert.ok(!j.findings.some((f) => f.rule === 'unread'), 'a file read whole is not reported unread')
})

test('a NUL, 0x01–0x03 and CR in a binary file are content: the framing holds, on every reader', () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  const sha = 'a'.repeat(40)
  // Everything here is what the reader looks for outside a hunk, inside a file git
  // would call binary; the path after it and the file after that must still be found.
  const content = Buffer.from(`\0\x01\x02\x03\r\n+++ b/fake\r\n@@ -0,0 +1,99 @@\n${sha}\ndiff --git a/y b/y\nBinary files a/y and b/y differ\n\0${HOME_PATH}\r\n`, 'latin1')
  const c = sb.commit({ file: 'blob.bin', content, message: 'Binary with framing bytes' })
  sb.commit({ file: 'next.txt', content: 'deploy to nimbus\n' })
  const j = range(sb)
  assert.ok(has(j, 'path', 'blob.bin:7', c), 'the path on the last line of the binary')
  assert.ok(has(j, 'term', 'next.txt:1'), 'the commit after it')
  assert.equal(j.commits, 2, 'counted once each')
  const [commit] = logCommits(sb.work, [`${c}^!`])
  assert.equal(commit.added.length, 7)
  assert.deepEqual(commit.added.map((a) => a.line), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(commit.added[0].text, '\0\x01\x02\x03\r')
  const raw = spawnSync('git', logArgs(['--all']), { cwd: sb.work, env: sb.env }).stdout
  const whole = parseLog(raw)
  for (let cut = 0; cut <= raw.length; cut += 5) {
    const s = splitLog()
    assert.deepEqual([...s.push(raw.subarray(0, cut)), ...s.push(raw.subarray(cut)), ...s.end()], whole, `split at byte ${cut}`)
  }
})

// A merge that resolves a conflict in a `-diff` lock file: git's combined diff prints
// "Binary files differ" for it even under --text, so its own lines come from one diff
// per parent — a line is the merge's own only when every parent lacks it.
function mergeFixture() {
  const sb = sandbox()
  sb.userConfig(CFG)
  sb.commit({ file: '.gitattributes', content: '*.lock -diff\n*.png binary\n' })
  sb.commit({ file: 'deps.lock', content: 'a\n' })
  sb.git(['checkout', '-q', '-b', 'side'])
  sb.commit({ file: 'deps.lock', content: 'a\nside\n' })
  sb.git(['checkout', '-q', 'main'])
  sb.commit({ file: 'deps.lock', content: 'a\nmain\n' })
  sb.git(['merge', '-q', 'side'], { allowFail: true })
  const merge = sb.commit({ file: 'deps.lock', content: 'a\nmain\nside\nnimbus resolved\n', message: 'Merge side' })
  const img = sb.commit({ file: 'img.png', content: Buffer.from(`\0PNG\0\n${BOB.email}\n`, 'latin1') })
  return { sb, merge, img }
}

test("a merge's own lines in a -diff file are read, and only its own", () => {
  const { sb, merge } = mergeFixture()
  assert.match(sb.git(['show', '--cc', '--text', '--format=', merge]).stdout, /^Binary files differ$/m, 'git hides the merge, --text or not')
  const [m] = logCommits(sb.work, [`${merge}^!`])
  assert.deepEqual(m.added.map((a) => [a.file, a.line, a.text]), [['deps.lock', 4, 'nimbus resolved']])
  assert.ok(has(range(sb), 'term', 'deps.lock:4', merge))
})

test('the hook, --range, --history and --pre-commit read the same findings — and the ones they must', () => {
  const { sb, merge, img } = mergeFixture()
  const tip = sb.git(['rev-parse', 'main']).stdout.trim()
  const hook = json(sb.run(['pre-push', 'origin', sb.remote, '--json'], { input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n` }))
  const history = json(sb.run(['scan', '--history', '--json']))
  const pc = json(sb.run(['pre-push', '--pre-commit', '--json'], { extraEnv: { PRE_COMMIT_REMOTE_NAME: 'origin', PRE_COMMIT_REMOTE_URL: sb.remote, PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/main' } }))
  const r = range(sb)
  assert.ok(has(history, 'term', 'deps.lock:4', merge), "the merge's own line in a -diff file")
  assert.ok(has(history, 'email', 'img.png:2', img), 'the address in a binary file')
  for (const [label, j] of [['pre-push', hook], ['--pre-commit', pc], ['--range', r]]) {
    assert.equal(j.commits, history.commits, label)
    assert.deepEqual(rows(j), rows(history), label)
  }
})

test('scan --staged reads a staged -diff file', () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  sb.commit({ file: '.gitattributes', content: '*.lock -diff\n' })
  writeFileSync(join(sb.work, 'yarn.lock'), 'x\nnimbus staged\n')
  sb.git(['add', 'yarn.lock'])
  assert.ok(has(json(sb.run(['scan', '--staged', '--json'])), 'term', 'yarn.lock:2'))
})

// Past the read limit — 100 MiB of a file's added lines in one commit — a file is read
// up to it and reported: a finding of its own, refusing in block mode, printed in audit
// mode. The file beside it in the same commit is read whole.
test('a file past the read limit is an unread finding: refused in block mode, printed in audit mode, never skipped', () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  sb.commit({ file: '.gitattributes', content: '*.dat binary\n' })
  // Short words: a long run of letters is slow under the address rule (DG-31), and that
  // is not what this test measures.
  const line = `${'0123456789 abcdef '.repeat(56)}\n`
  const big = Buffer.alloc(101 * MiB, line)
  writeFileSync(join(sb.work, 'zz-after.txt'), 'nimbus beside it\n')
  sb.git(['add', 'zz-after.txt'])
  const c = sb.commit({ file: 'dump.dat', content: Buffer.concat([Buffer.from('nimbus first\n'), big, Buffer.from(`${HOME_PATH}\n`)]) })
  const r = sb.run(['scan', '--range', 'main', '--json'])
  assert.equal(r.code, 1, r.out)
  const j = json(r)
  assert.ok(has(j, 'term', 'dump.dat:1', c), 'what lies within the limit is read')
  assert.ok(has(j, 'unread', 'dump.dat', c), 'the file is reported')
  assert.ok(!j.findings.some((f) => f.rule === 'path'), 'what lies past it is not')
  assert.ok(has(j, 'term', 'zz-after.txt:1', c), 'the next file in the commit is read whole')
  assert.equal(j.findings.filter((f) => f.rule === 'unread').length, 1)
  assert.equal(j.refused, true)
  sb.userConfig({ ...CFG, mode: 'audit' })
  const audit = sb.run(['scan', '--history'])
  assert.equal(audit.code, 0, audit.out)
  assert.match(audit.stdout, /unread\s+[0-9a-f]{7}\s+dump\.dat\s+du… \(8 chars\)\s+read in part — past the read limit/)
  assert.match(sb.run(['doctor']).stdout, /reading\s+every added line as text.*100 MiB/)
})

test('the parser: a read limit cuts a commit, never its framing; an over-long header line fails closed', () => {
  const sha = 'b'.repeat(40)
  const log = `${sha}\n\ndiff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,3 @@\n+0123456789\n+abcdefghij\n+klm\ndiff --git a/y b/y\nnew file mode 100644\n--- /dev/null\n+++ b/y\n@@ -0,0 +1 @@\n+tail\n`
  const [p] = parseLog(log, { limit: 15 })
  assert.deepEqual(p.added.map((a) => [a.file, a.line, a.text]), [['x', 1, '0123456789'], ['x', 2, 'abcde'], ['y', 1, 'tail']])
  assert.deepEqual(p.unread, [{ file: 'x', why: 'limit' }], 'the limit is per file: y is read whole')
  // And a commit's limit, all files together: here y has three bytes of it left.
  const [q] = parseLog(log, { limit: 15, commitLimit: 18 })
  assert.deepEqual(q.added.map((a) => [a.file, a.text]), [['x', '0123456789'], ['x', 'abcde'], ['y', 'tai']])
  assert.deepEqual(q.unread, [{ file: 'x', why: 'limit' }, { file: 'y', why: 'limit' }])
  assert.deepEqual(parseLog(log)[0].unread, [])
  for (let cut = 0; cut <= log.length; cut++) {
    const s = splitLog({ limit: 15 })
    const buf = Buffer.from(log)
    assert.deepEqual([...s.push(buf.subarray(0, cut)), ...s.push(buf.subarray(cut)), ...s.end()], [p], `split at byte ${cut}`)
  }
  // git never writes a header line of a megabyte: one that long is not git's.
  assert.throws(() => parsePatch(`diff --git a/${'z'.repeat(2 * MiB)} b/z\n`), /could not be read/)
  // A `Binary files` line git did print is a file not read, named and reported.
  // Its name may hold " and b/": the two sides are the same length, so it splits there.
  const bin = parsePatch('diff --git a/x and b/y b/x and b/y\nindex 1..2 100644\nBinary files a/x and b/y and b/x and b/y differ\n')
  assert.deepEqual(bin.unread, [{ file: 'x and b/y', why: 'binary' }])
  assert.deepEqual(parsePatch('diff --git a/n b/n\nnew file mode 100644\nBinary files /dev/null and b/n differ\n').unread, [{ file: 'n', why: 'binary' }])
})

test('check holds the diff flags: --text, --no-textconv, --no-ext-diff', () => {
  assert.deepEqual(missingDiffFlags(readFileSync(new URL('../bin/lib/git.mjs', import.meta.url), 'utf8')), [])
  assert.deepEqual(missingDiffFlags("const DIFF = ['--no-color', '--no-ext-diff', '-U0']"), ['--text', '--no-textconv'])
})
