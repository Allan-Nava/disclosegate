import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig, normaliseRemote, remoteVerdict, stripComments, TEMPLATE } from '../bin/lib/config.mjs'
import { scanTree } from '../bin/lib/check.mjs'

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), 'disclosegate-cfg-')))

test('comments are stripped, strings with // and /* intact', () => {
  const t = stripComments('// head\n{ "a": "https://x.example/*y*/", /* c */ "b": ["q\\"//"] } // tail')
  assert.deepEqual(JSON.parse(t), { a: 'https://x.example/*y*/', b: ['q"//'] })
  assert.doesNotThrow(() => JSON.parse(stripComments(TEMPLATE)))
})

test('trust order: the repository file adds terms and domains, sets allowPaths, and nothing else', () => {
  const home = dir()
  const repo = dir()
  writeFileSync(join(home, 'user.json'), JSON.stringify({ publicEmails: ['Alice@Personal.example'], terms: ['nimbus'], blockedDomains: ['@work.example'], mode: 'audit' }))
  writeFileSync(join(repo, '.disclosegate.json'), JSON.stringify({ terms: ['/cirrus-\\d/', 'nimbus'], blockedDomains: ['example.internal'], allowPaths: ['test/fixtures/**'], publicEmails: ['bob@example.internal'], mode: 'block', remotes: { skip: ['*'] } }))
  const { effective: e, repo: r, warnings } = loadConfig({ env: { HOME: home, DISCLOSEGATE_CONFIG: join(home, 'user.json') }, repoRoot: repo })
  assert.deepEqual(e.publicEmails, ['alice@personal.example'])
  assert.deepEqual(e.terms.map((t) => t.source), ['nimbus', '/cirrus-\\d/'])
  assert.deepEqual(e.blockedDomains, ['work.example', 'example.internal'])
  assert.deepEqual(e.allowPaths, ['test/fixtures/**'])
  assert.equal(e.mode, 'audit', 'the repository cannot set mode either way')
  assert.deepEqual(e.remotes, { enforce: [], skip: [] })
  assert.deepEqual(r.ignored, ['publicEmails', 'mode', 'remotes'])
  assert.match(warnings[0], /ignored/)
})

test('a missing user config is not an error', () => {
  const home = dir()
  const { user, effective, warnings } = loadConfig({ env: { HOME: home }, repoRoot: null })
  assert.equal(user.found, false)
  assert.equal(effective.mode, 'block')
  assert.match(warnings[0], /no user config at ~\/\.disclosegate\.json/, 'the home directory is shown as ~')
})

test('remote URLs normalise to host/path, and skip wins over enforce', () => {
  // `@` is assembled so the SSH user forms are not addresses to `disclosegate check`.
  const at = '@'
  for (const u of [`git${at}github.com:Owner/Repo.git`, 'https://github.com/owner/repo', `ssh://git${at}github.com:22/owner/repo.git`, `https://token${at}github.com/owner/repo/`]) {
    assert.equal(normaliseRemote(u), 'github.com/owner/repo', u)
  }
  assert.equal(normaliseRemote('/srv/git/x.git'), '/srv/git/x')
  const remotes = { enforce: ['github.com/*'], skip: ['github.com/owner/scratch'] }
  assert.equal(remoteVerdict(`git${at}github.com:owner/repo.git`, remotes).enforce, true)
  assert.equal(remoteVerdict(`git${at}github.com:owner/scratch.git`, remotes).enforce, false)
  assert.equal(remoteVerdict(`git${at}git.example.internal:team/x.git`, remotes).enforce, false)
  assert.equal(remoteVerdict('anything', {}).enforce, true, 'no list: every remote')
})

test('the tree scan behind `check` finds home paths, real addresses and the user\'s terms, masked', () => {
  const root = dir()
  writeFileSync(join(root, 'a.md'), ['ok: alice@personal.example and bob@example.internal', `bad: ${['', 'Users', 'someone', 'x'].join('/')}`, `bad: ${['someone', 'personal.examples'].join('@')}`, 'bad: nimbus'].join('\n'))
  const f = scanTree(root, ['a.md'], { terms: [{ re: /nimbus/gi }] })
  assert.equal(f.length, 3, f.join('\n'))
  assert.match(f[0], /a\.md:2: home directory \(\/U… \(15 chars\)\)/)
  assert.match(f[1], /a\.md:3: an email address that is not a placeholder \(so… \(25 chars\)\)/)
  assert.match(f[2], /a\.md:4: a term from your user config/)
  assert.ok(!f.join('').includes('personal.examples'))
})
