// The commands run by hand: scan, install and uninstall, init, doctor, and the exit
// codes that tell a finding (1) from a usage or configuration error (2).
import assert from 'node:assert/strict'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { stripComments } from '../bin/lib/config.mjs'
import { placeholderEmail } from '../bin/lib/check.mjs'
import { ALICE, BOB, HOME_PATH, sandbox } from './helpers.mjs'

// A file's text and mode through one descriptor: the mode is that of the bytes read,
// with no window for the path to change between a stat and a read (DG-34).
function held(file) {
  const fd = openSync(file, 'r')
  try {
    return { text: readFileSync(fd, 'utf8'), mode: fstatSync(fd).mode }
  } finally {
    closeSync(fd)
  }
}
// A file's text, or null when there is none — one read, no existence check before it.
function contents(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

test('scan --range --json: machine output, matches masked, exit 1 in block mode', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email] })
  const first = sb.commit()
  sb.commit({ author: BOB, committer: ALICE, content: `${HOME_PATH}\n` })
  const r = sb.run(['scan', '--range', `${first}..HEAD`, '--json'])
  assert.equal(r.code, 1)
  const j = JSON.parse(r.stdout)
  assert.equal(j.tool, 'disclosegate')
  assert.equal(j.commits, 1)
  assert.equal(j.refused, true)
  assert.deepEqual(j.findings.map((f) => [f.rule, f.where, f.match, f.length]), [
    ['email', 'author', 'bo… (20 chars)', 20],
    ['path', 'file-2.txt:1', '/h… (11 chars)', 11],
  ])
  assert.doesNotMatch(r.stdout, /bob@example|\/home\/user/)
})

test('--show is refused when stdout is not a terminal', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email] })
  sb.commit({ author: BOB })
  const r = sb.run(['scan', '--history', '--show'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /only when stdout is a terminal/)
  assert.doesNotMatch(r.stdout, /bob@example\.internal/)
})

test('scan with no range checks what no remote has; --history checks everything', () => {
  const sb = sandbox()
  sb.commit({ content: `${HOME_PATH}\n` })
  sb.push()
  sb.git(['fetch', '-q', 'origin'])
  sb.commit()
  const pending = sb.run(['scan'])
  assert.equal(pending.code, 0, pending.out)
  assert.match(pending.stdout, /1 commit checked — clean/)
  const all = sb.run(['scan', '--history'])
  assert.equal(all.code, 1)
  assert.match(all.stdout, /1 finding in 1 of 2 commits/)
})

test('scan --staged checks the index and the identity the next commit would carry', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email] })
  sb.commit()
  writeFileSync(join(sb.work, 'notes.txt'), `x\n${HOME_PATH}\n`)
  sb.git(['add', 'notes.txt'])
  const r = sb.run(['scan', '--staged'], { extraEnv: { GIT_AUTHOR_EMAIL: BOB.email } })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /email\s+staged\s+author/)
  assert.match(r.stdout, /notes\.txt:2/)
})

test('audit mode: scan prints and exits 0', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email], mode: 'audit' })
  sb.commit({ author: BOB })
  const r = sb.run(['scan', '--history'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /audit mode/)
})

test('install refuses to clobber a hook it did not write; --force moves it and chains it; uninstall restores it', () => {
  const sb = sandbox()
  const hook = join(sb.work, '.git', 'hooks', 'pre-push')
  const foreign = '#!/bin/sh\necho another tool\n'
  writeFileSync(hook, foreign, { mode: 0o755 })
  const r = sb.run(['install'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /did not write is already there — left alone/)
  assert.equal(readFileSync(hook, 'utf8'), foreign, 'untouched')
  const u = sb.run(['uninstall'])
  assert.equal(u.code, 2, 'uninstall leaves a foreign hook alone too')
  assert.equal(readFileSync(hook, 'utf8'), foreign)

  const f = sb.run(['install', '--force'])
  assert.equal(f.code, 0, f.out)
  const installed = held(hook)
  assert.match(installed.text, /disclosegate-managed-hook/)
  assert.ok(installed.mode & 0o100, 'executable')
  assert.equal(readFileSync(`${hook}.before-disclosegate`, 'utf8'), foreign)
  assert.match(f.stdout, /it runs after disclosegate/)
  assert.match(sb.run(['doctor']).stdout, /installed — then pre-push\.before-disclosegate, chained/)
  assert.equal(sb.run(['install']).code, 0, 're-installing over its own hook is an update')

  const back = sb.run(['uninstall'])
  assert.equal(back.code, 0)
  assert.match(back.stdout, /restored/)
  assert.equal(readFileSync(hook, 'utf8'), foreign)
  assert.ok(!existsSync(`${hook}.before-disclosegate`))
})

test('the installed hook refuses the push when disclosegate has gone', () => {
  const sb = sandbox()
  assert.equal(sb.run(['install']).code, 0)
  const hook = join(sb.work, '.git', 'hooks', 'pre-push')
  writeFileSync(hook, readFileSync(hook, 'utf8').replace(/^DG_SCRIPT=.*$/m, "DG_SCRIPT='/nonexistent/disclosegate.mjs'"))
  sb.commit()
  const r = sb.git(['push', 'origin', 'main'], { allowFail: true, extraEnv: { PATH: '/usr/bin:/bin' } })
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /cannot find disclosegate/)
})

test('init writes a template of placeholders with comments, and refuses to overwrite', () => {
  const sb = sandbox()
  const r = sb.run(['init'])
  assert.equal(r.code, 0, r.out)
  const { text, mode } = held(sb.env.DISCLOSEGATE_CONFIG)
  assert.match(text, /^\/\/ /m, 'comments')
  assert.equal(mode & 0o777, 0o600)
  const data = JSON.parse(stripComments(text))
  for (const e of data.publicEmails) assert.ok(placeholderEmail(e), 'placeholders only')
  assert.equal(sb.run(['init']).code, 2)
  sb.commit()
  const d = sb.run(['doctor'])
  assert.match(d.stdout, /template placeholders/)
  assert.equal(sb.run(['scan', '--history']).code, 1, 'the template is a valid config — and its placeholder allowlist does not hold Alice')
})

test('init refuses to write the user config inside the repository', () => {
  const sb = sandbox()
  const r = sb.run(['init'], { extraEnv: { DISCLOSEGATE_CONFIG: join(sb.work, 'mine.json') } })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /never live in one/)
})

test('init refuses a user config path that is a dangling symlink into the repository', () => {
  const sb = sandbox()
  symlinkSync(join(sb.work, 'mine.json'), sb.env.DISCLOSEGATE_CONFIG)
  const r = sb.run(['init'])
  assert.equal(r.code, 2, r.out)
  assert.match(r.stderr, /never live in one/)
  assert.ok(!existsSync(join(sb.work, 'mine.json')), 'nothing was written through the link')
})

test('init writes a new file or nothing: a link at the path, dangling or not, is refused and nothing goes through it (DG-34)', () => {
  const sb = sandbox()
  const elsewhere = join(sb.base, 'elsewhere.json')
  symlinkSync(elsewhere, sb.env.DISCLOSEGATE_CONFIG)
  const r = sb.run(['init'])
  assert.equal(r.code, 2, r.out)
  assert.match(r.stderr, /is a symbolic link — left alone/)
  assert.equal(contents(elsewhere), null, 'nothing was written through the dangling link')

  writeFileSync(elsewhere, '{}\n')
  const again = sb.run(['init'])
  assert.equal(again.code, 2, again.out)
  assert.match(again.stderr, /is a symbolic link — left alone/)
  assert.equal(contents(elsewhere), '{}\n', 'the file behind the link is untouched')
})

test('doctor: config, rules, hook and remotes', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email], terms: ['nimbus'], remotes: { enforce: ['*/remote.git'] } })
  let d = sb.run(['doctor'])
  assert.equal(d.code, 1)
  assert.match(d.stdout, /not installed/)
  sb.run(['install'])
  d = sb.run(['doctor'])
  assert.equal(d.code, 0, d.out)
  assert.match(d.stdout, /1 public email, 0 blocked domains, 1 term/)
  assert.match(d.stdout, /email allowlist on \(1\).*path on \(built in\)/)
  assert.match(d.stdout, /hook\s+.*pre-push — installed/)
  assert.match(d.stdout, /origin — enforced \(remotes\.enforce\)/)
  assert.doesNotMatch(d.stdout, /alice@|nimbus/, 'doctor prints counts, not values')
})

test('doctor without a user config says what is missing', () => {
  const sb = sandbox()
  const d = sb.run(['doctor'])
  assert.equal(d.code, 1)
  assert.match(d.stdout, /user config\s+.*missing/)
  assert.match(d.stdout, /email allowlist off/)
})

test('configuration errors exit 2 and name the key, never the value', () => {
  const sb = sandbox()
  sb.commit()
  for (const [cfg, needle] of [
    ['{ not json', /not valid JSON/],
    [{ publicEmail: ['x'] }, /unknown key publicEmail/],
    [{ terms: ['/secret-(/'] }, /terms\[0\] is not a usable term/],
    [{ mode: 'loud' }, /mode must be/],
    [{ remotes: { enforce: 'github.com/*' } }, /remotes\.enforce must be a list/],
  ]) {
    sb.userConfig(cfg)
    const r = sb.run(['scan', '--history'])
    assert.equal(r.code, 2, `${JSON.stringify(cfg)}: ${r.out}`)
    assert.match(r.stderr, needle)
    assert.doesNotMatch(r.stderr, /secret/)
  }
})

test('a user config inside the repository being scanned is refused', () => {
  const sb = sandbox()
  sb.commit()
  writeFileSync(join(sb.work, 'private.json'), '{}')
  const r = sb.run(['scan'], { extraEnv: { DISCLOSEGATE_CONFIG: join(sb.work, 'private.json') } })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /must never live in a repository/)
})

test('usage errors exit 2', () => {
  const sb = sandbox()
  assert.equal(sb.run(['frobnicate']).code, 2)
  assert.equal(sb.run(['scan', '--range']).code, 2)
  assert.equal(sb.run(['scan', '--range', '--all']).code, 2, 'a range cannot smuggle an option into git')
  assert.equal(sb.run(['scan', '--staged', '--history']).code, 2)
  assert.equal(sb.run(['pre-push']).code, 2)
  assert.equal(sb.run([]).code, 2)
  assert.equal(sb.run(['scan'], { cwd: sb.home }).code, 2, 'outside a repository')
})

test('blockedNames: an author name is a finding', () => {
  const sb = sandbox()
  sb.userConfig({ blockedNames: ['Bob Example'] })
  sb.commit({ author: { name: 'Bob Example', email: ALICE.email } })
  const r = sb.run(['scan', '--history'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /name\s+[0-9a-f]{7}\s+author\s+Bo… \(11 chars\)\s+blocked name/)
})

test('scan --history reads annotated tags too, and counts them apart', () => {
  const sb = sandbox()
  sb.userConfig({ publicEmails: [ALICE.email] })
  sb.commit()
  sb.git(['tag', '-a', 'v1', '-m', 'Release 1'], { extraEnv: { GIT_COMMITTER_NAME: BOB.name, GIT_COMMITTER_EMAIL: BOB.email } })
  const r = sb.run(['scan', '--history', '--json'])
  assert.equal(r.code, 1, r.out)
  const j = JSON.parse(r.stdout)
  assert.equal(j.commits, 1)
  assert.equal(j.tags, 1)
  assert.deepEqual(j.findings.map((f) => [f.rule, f.where, f.match]), [['email', 'tagger', 'bo… (20 chars)']])
})
