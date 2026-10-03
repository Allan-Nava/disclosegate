// DG-22: `scan --history` streams the log — one commit held at a time — instead of
// reading the whole history into memory first. What it prints, how it masks and how it
// exits must not change: the streamed reading is held to the collected one on the same
// fixture repository, byte for byte, and the splitter to `parseLog` at every byte offset.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { GitError, logArgs, logCommits, parseLog, splitLog, streamCommits } from '../bin/lib/git.mjs'
import { ALICE, BOB, HOME_PATH, sandbox } from './helpers.mjs'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const lib = (f) => new URL(`../bin/lib/${f}`, import.meta.url).href

// A history with something for every rule: a work address as author and in a trailer,
// a term in a message and in a line, a home path, a blocked domain in text, text in
// several scripts (multi-byte UTF-8, so a chunk can end inside a character), a merge
// with a line of its own, and an annotated tag by a work address.
function fixture(cfg = {}) {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email], terms: ['nimbus'], blockedDomains: ['example.internal'], ...cfg })
  sb.commit({ file: 'a.txt', content: 'café — naïve ü 日本語 ✓\n', message: 'Start: résumé ☃' })
  sb.commit({ author: BOB, content: `${HOME_PATH}\n` })
  sb.commit({ content: 'deploy to nimbus\nmail bob@example.internal\n', message: 'Deploy\n\nCo-authored-by: Bob <bob@example.internal>' })
  sb.git(['checkout', '-q', '-b', 'side'])
  sb.commit({ file: 'b.txt', content: 'side\n' })
  sb.git(['checkout', '-q', 'main'])
  sb.commit({ file: 'c.txt', content: 'main\n' })
  sb.git(['merge', '-q', '--no-ff', '--no-commit', 'side'])
  sb.commit({ file: 'merge-note.txt', content: 'resolved on nimbus\n', message: 'Merge side' })
  sb.git(['tag', '-a', 'v1', '-m', 'Release 1'], { extraEnv: { GIT_COMMITTER_NAME: BOB.name, GIT_COMMITTER_EMAIL: BOB.email } })
  return sb
}

// The collected reading — the whole log, then the tags, then the rules — run in the
// sandbox's environment through the same library calls `scan --history` made in 0.0.3.
const collected = (sb, json) => {
  const script = `
    import { loadConfig } from '${lib('config.mjs')}'
    import { allTags, logCommits } from '${lib('git.mjs')}'
    import { scanCommits } from '${lib('rules.mjs')}'
    import { formatText, toJSON } from '${lib('report.mjs')}'
    const cwd = process.cwd()
    const { effective, warnings } = loadConfig({ repoRoot: cwd })
    const commits = [...logCommits(cwd, ['--all']), ...allTags(cwd)]
    const findings = scanCommits(commits, effective)
    const tags = commits.filter((c) => c.tag != null).length
    const opts = { reveal: false, mode: effective.mode, context: 'scan', commits: commits.length - tags, tags, version: ${JSON.stringify(VERSION)}, warnings }
    for (const w of warnings) process.stderr.write('disclosegate: ' + w + '\\n')
    process.stdout.write((${json} ? toJSON(findings, opts) : formatText(findings, opts)) + '\\n')
    process.exitCode = findings.length && effective.mode === 'block' ? 1 : 0
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: sb.work, env: sb.env, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

const rawLog = (sb, revs = ['--all']) => {
  const r = spawnSync('git', logArgs(revs), { cwd: sb.work, env: sb.env })
  assert.equal(r.status, 0, String(r.stderr))
  return r.stdout
}

test('the splitter yields what parseLog does, wherever a chunk ends — inside a character or a separator', () => {
  const sb = fixture()
  const buf = rawLog(sb)
  const whole = parseLog(buf.toString('utf8'))
  assert.ok(whole.length >= 6)
  assert.ok(whole.some((c) => c.added.some((a) => a.text.includes('日本語'))))
  for (let cut = 0; cut <= buf.length; cut++) {
    const s = splitLog()
    const got = [...s.push(buf.subarray(0, cut)), ...s.push(buf.subarray(cut)), ...s.end()]
    assert.deepEqual(got, whole, `split at byte ${cut}`)
  }
})

test('the splitter holds one line and one commit at a time, and hands each commit over as soon as the next begins', () => {
  const sb = fixture()
  const buf = rawLog(sb)
  const longest = Math.max(...buf.toString('utf8').split('\n').map((l) => Buffer.byteLength(l)))
  const s = splitLog()
  const got = []
  let peak = 0
  for (let i = 0; i < buf.length; i += 64) {
    got.push(...s.push(buf.subarray(i, i + 64)))
    peak = Math.max(peak, Buffer.byteLength(s.pending))
    if (i + 64 >= buf.length / 2 && i < buf.length / 2) assert.ok(got.length > 0, 'commits arrive before the log ends')
  }
  got.push(...s.end())
  assert.equal(s.pending, '')
  assert.ok(peak <= longest + 64, `peak ${peak} bytes, longest line ${longest}`)
  assert.deepEqual(got, parseLog(buf.toString('utf8')))
})

test('streamCommits reads what logCommits reads; a failing git log is a GitError', async () => {
  const sb = fixture()
  process.env.GIT_CONFIG_GLOBAL = sb.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const streamed = []
  for await (const c of streamCommits(sb.work, ['--all'])) streamed.push(c)
  assert.deepEqual(streamed, logCommits(sb.work, ['--all']))
  await assert.rejects(
    async () => {
      for await (const c of streamCommits(sb.work, ['no-such-ref'])) void c
    },
    (e) => e instanceof GitError && /^git log failed: fatal: /.test(e.message),
  )
})

for (const [label, cfg, code] of [
  ['block mode', {}, 1],
  ['audit mode', { mode: 'audit' }, 0],
]) {
  test(`scan --history prints, masks and exits as the collected reading did — ${label}`, () => {
    const sb = fixture(cfg)
    for (const json of [false, true]) {
      const r = sb.run(['scan', '--history', ...(json ? ['--json'] : [])])
      const want = collected(sb, json)
      assert.equal(r.code, code, r.out)
      assert.equal(r.code, want.code)
      assert.equal(r.stdout, want.stdout)
      assert.equal(r.stderr, want.stderr)
    }
    const j = JSON.parse(sb.run(['scan', '--history', '--json']).stdout)
    assert.equal(j.commits, 6)
    assert.equal(j.tags, 1)
    assert.deepEqual([...new Set(j.findings.map((f) => f.rule))], ['email', 'term', 'path'])
    assert.ok(j.findings.every((f) => /^.{2}… \(\d+ chars\)$/.test(f.match)), 'every match masked')
    assert.doesNotMatch(sb.run(['scan', '--history']).stdout, /bob@example|nimbus|\/home\/user/)
  })
}

test('scan --history on a repository with no commit is clean, as before', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email] })
  const r = sb.run(['scan', '--history'])
  assert.equal(r.code, collected(sb, false).code)
  assert.equal(r.stdout, collected(sb, false).stdout)
})
