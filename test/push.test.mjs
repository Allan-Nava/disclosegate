// End to end: a real `git push` through the installed hook, against a bare remote.
// A refused push must leave the remote without the ref; a passing one must land it.
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ALICE, BOB, HOME_PATH, sandbox } from './helpers.mjs'

const guarded = (cfg = { publicEmails: [ALICE.email] }) => {
  const sb = sandbox()
  sb.userConfig(cfg)
  const r = sb.run(['install'])
  assert.equal(r.code, 0, r.out)
  return sb
}

test('a clean new branch is pushed', () => {
  const sb = guarded()
  sb.commit()
  const r = sb.push()
  assert.equal(r.code, 0, r.out)
  assert.ok(sb.remoteHas('refs/heads/main'))
  assert.match(r.out, /1 commit checked — clean/)
})

test('a new branch whose author is a work address is refused, and the address is masked', () => {
  const sb = guarded()
  sb.commit()
  sb.commit({ author: BOB })
  const r = sb.push()
  assert.notEqual(r.code, 0)
  assert.ok(!sb.remoteHas('refs/heads/main'), 'nothing reached the remote')
  assert.match(r.out, /push refused/)
  assert.match(r.out, /email\s+[0-9a-f]{7}\s+author\s+bo… \(20 chars\)\s+not in publicEmails/)
  assert.doesNotMatch(r.out, /bob@example\.internal/, 'the match never appears in full in a non-TTY')
  assert.match(r.out, /1 of 2 commits/)
})

test('an update scans only what the remote lacks', () => {
  const sb = guarded()
  sb.commit()
  assert.equal(sb.push().code, 0)
  sb.commit({ committer: BOB })
  const r = sb.push()
  assert.notEqual(r.code, 0)
  assert.match(r.out, /1 finding in 1 of 1 commit /)
  assert.match(r.out, /committer/)
})

test('a deletion is skipped — it publishes nothing', () => {
  const sb = guarded()
  sb.commit()
  sb.git(['branch', 'feature'])
  assert.equal(sb.push(['origin', 'main', 'feature']).code, 0)
  sb.commit({ author: BOB }) // unpushed, and not what a deletion sends
  const r = sb.push(['origin', '--delete', 'feature'])
  assert.equal(r.code, 0, r.out)
  assert.ok(!sb.remoteHas('refs/heads/feature'))
})

test('Co-authored-by and Signed-off-by trailers are checked', () => {
  const sb = guarded()
  sb.commit({ message: `Pair on the parser\n\nCo-authored-by: Bob <${BOB.email}>\nSigned-off-by: Carol <carol@example.com>` })
  const r = sb.push()
  assert.notEqual(r.code, 0)
  assert.match(r.out, /trailer Co-authored-by/)
  assert.match(r.out, /trailer Signed-off-by/)
})

test('a term in a commit message is refused, case-insensitively', () => {
  const sb = guarded({ publicEmails: [ALICE.email], terms: ['Project Nimbus'] })
  sb.commit({ message: 'wire up project nimbus' })
  const r = sb.push()
  assert.notEqual(r.code, 0)
  assert.match(r.out, /term\s+[0-9a-f]{7}\s+message\s+pr… \(14 chars\)/)
})

test('a regex term in an added line is refused, with its file and line', () => {
  const sb = guarded({ publicEmails: [ALICE.email], terms: ['/nimbus-(prod|stage)-\\d+/i'] })
  sb.commit({ file: 'config.txt', content: 'name = demo\nhost = NIMBUS-PROD-7\n' })
  const r = sb.push()
  assert.notEqual(r.code, 0)
  assert.match(r.out, /config\.txt:2/)
})

test('a home path in an added line is refused — the path rule needs no config at all', () => {
  const sb = sandbox()
  assert.equal(sb.run(['install']).code, 0)
  sb.commit({ file: 'README.txt', content: `see ${HOME_PATH}\n` })
  const r = sb.push()
  assert.notEqual(r.code, 0)
  assert.match(r.out, /path\s+[0-9a-f]{7}\s+README\.txt:1\s+\/h… \(11 chars\)\s+home directory/)
  assert.match(r.out, /no user config/)
})

test('allowPaths exempts a fixture from the path rule, and from nothing else', () => {
  const sb = guarded({ publicEmails: [ALICE.email], terms: ['nimbus'] })
  sb.repoConfig({ allowPaths: ['test/fixtures/**'] })
  sb.git(['add', '.disclosegate.json'])
  sb.commit({ file: 'test/fixtures/sample.txt', content: `${HOME_PATH}\n` })
  assert.equal(sb.push().code, 0, 'the exempted fixture passes')
  sb.commit({ file: 'test/fixtures/other.txt', content: 'nimbus\n' })
  const r = sb.push()
  assert.notEqual(r.code, 0, 'a term in an exempted file is still refused')
  assert.match(r.out, /test\/fixtures\/other\.txt:1/)
})

test('a repository config that tries to loosen is ignored, and doctor says so', () => {
  const sb = guarded()
  sb.repoConfig({ publicEmails: [BOB.email], mode: 'audit', terms: ['nimbus'] })
  sb.commit({ author: BOB })
  const r = sb.push()
  assert.notEqual(r.code, 0, 'still refused: the repo file cannot allow an address or switch to audit')
  assert.match(r.out, /tried to set publicEmails, mode — ignored/)
  const d = sb.run(['doctor'])
  assert.equal(d.code, 1)
  assert.match(d.stdout, /ignored: publicEmails, mode/)
  assert.match(d.stdout, /terms on \(1\)/, 'the tightening half is applied')
})

test("a repository's own terms do not refuse the push that adds its config", () => {
  const sb = guarded()
  sb.repoConfig({ terms: ['internal-name'] })
  sb.git(['add', '.disclosegate.json'])
  sb.commit({ message: 'guard a retired name' })
  const r = sb.push()
  assert.equal(r.code, 0, r.out)
  assert.ok(sb.remoteHas('refs/heads/main'))
})

test("a repository's own terms still refuse another file in the same push, and a user term refuses the config", () => {
  const sb = guarded()
  sb.repoConfig({ terms: ['internal-name'] })
  sb.git(['add', '.disclosegate.json'])
  sb.commit({ message: 'guard a retired name' })
  sb.commit({ file: 'notes.txt', content: 'deploy to internal-name\n' })
  const r = sb.push()
  assert.notEqual(r.code, 0, r.out)
  assert.ok(!sb.remoteHas('refs/heads/main'))
  assert.match(r.out, /notes\.txt:1/)
  assert.doesNotMatch(r.out, /\.disclosegate\.json:1/, 'the config defining the term is exempt from it')

  const sb2 = guarded({ publicEmails: [ALICE.email], terms: ['internal-name'] })
  sb2.repoConfig({ terms: ['internal-name'] })
  sb2.git(['add', '.disclosegate.json'])
  sb2.commit()
  const r2 = sb2.push()
  assert.notEqual(r2.code, 0, 'a term from the private list is refused even in the repository config')
  assert.match(r2.out, /\.disclosegate\.json:1/)
})

test('audit mode prints the findings and lets the push through', () => {
  const sb = guarded({ publicEmails: [ALICE.email], mode: 'audit' })
  sb.commit({ author: BOB })
  const r = sb.push()
  assert.equal(r.code, 0, r.out)
  assert.ok(sb.remoteHas('refs/heads/main'))
  assert.match(r.out, /audit mode, nothing refused/)
  assert.match(r.out, /bo… \(20 chars\)/)
})

test('a blocked domain is refused even when the address is in publicEmails', () => {
  const sb = guarded({ publicEmails: [ALICE.email, BOB.email], blockedDomains: ['example.internal'] })
  sb.commit({ author: BOB })
  const r = sb.push()
  assert.notEqual(r.code, 0)
  assert.match(r.out, /blocked domain/)
})

test('a remote in remotes.skip is not checked; one outside remotes.enforce neither', () => {
  const sb = guarded({ publicEmails: [ALICE.email], remotes: { skip: ['*/remote.git'] } })
  sb.commit({ author: BOB })
  const r = sb.push()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /remote origin is not enforced \(remotes\.skip\)/)
  sb.userConfig({ publicEmails: [ALICE.email], remotes: { enforce: ['github.com/*'] } })
  sb.commit({ author: BOB })
  const r2 = sb.push()
  assert.equal(r2.code, 0)
  assert.match(r2.out, /not in remotes\.enforce/)
})

test('core.hooksPath is where the hook goes', () => {
  const sb = sandbox()
  sb.git(['config', 'core.hooksPath', '.githooks'])
  const r = sb.run(['install'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.stdout, /\.githooks\/pre-push/)
  sb.commit({ content: `${HOME_PATH}\n` })
  assert.notEqual(sb.push().code, 0, 'git runs it from there')
})

// A dotfiles repository: the user file is a symlink into the work tree being pushed.
// Its lists hold no term, so nothing in the commit would match — only the refusal
// keeps the private list from leaving.
test('a user file that is a symlink into the repository is refused, and nothing is pushed', () => {
  const sb = sandbox()
  assert.equal(sb.run(['install']).code, 0)
  sb.commit({ file: 'disclosegate.json', content: JSON.stringify({ publicEmails: [ALICE.email], blockedDomains: ['example.internal'] }) })
  symlinkSync(join(sb.work, 'disclosegate.json'), sb.env.DISCLOSEGATE_CONFIG)
  const r = sb.push()
  assert.notEqual(r.code, 0, r.out)
  assert.ok(!sb.remoteHas('refs/heads/main'), 'nothing reached the remote')
  assert.match(r.out, /must never live in a repository/)
  const s = sb.run(['scan', '--history'])
  assert.equal(s.code, 2, s.out)
  assert.match(s.stderr, /must never live in a repository/)
})

test('a user file reached through a symlinked directory into the repository is refused', () => {
  const sb = sandbox()
  assert.equal(sb.run(['install']).code, 0)
  mkdirSync(join(sb.work, 'dotfiles'))
  sb.commit({ file: 'dotfiles/disclosegate.json', content: JSON.stringify({ publicEmails: [ALICE.email] }) })
  symlinkSync(join(sb.work, 'dotfiles'), join(sb.home, 'dotfiles'))
  const extraEnv = { DISCLOSEGATE_CONFIG: join(sb.home, 'dotfiles', 'disclosegate.json') }
  const s = sb.run(['scan', '--history'], { extraEnv })
  assert.equal(s.code, 2, s.out)
  assert.match(s.stderr, /must never live in a repository/)
})

test('a user file that is a symlink to a file outside the repository is read as usual', () => {
  const sb = sandbox()
  assert.equal(sb.run(['install']).code, 0)
  const target = join(sb.base, 'elsewhere.json')
  writeFileSync(target, JSON.stringify({ publicEmails: [ALICE.email] }))
  symlinkSync(target, sb.env.DISCLOSEGATE_CONFIG)
  sb.commit()
  const r = sb.push()
  assert.equal(r.code, 0, r.out)
  assert.ok(sb.remoteHas('refs/heads/main'))
})

// An annotated tag is an object of its own: its tagger and its message are published
// with it, even when every commit it points at is already on the remote.
const tag = (sb, args, who = ALICE) => sb.git(['tag', ...args], { extraEnv: { GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } })

test('an annotated tag whose tagger is a work address is refused, though its commit is public', () => {
  const sb = guarded()
  sb.commit()
  assert.equal(sb.push().code, 0)
  tag(sb, ['-a', 'v1', '-m', 'Release 1'], BOB)
  const r = sb.push(['origin', 'v1'])
  assert.notEqual(r.code, 0, r.out)
  assert.ok(!sb.remoteHas('refs/tags/v1'), 'the tag did not reach the remote')
  assert.match(r.out, /email\s+[0-9a-f]{7}\s+tagger\s+bo… \(20 chars\)\s+not in publicEmails/)
  assert.match(r.out, /1 finding in 1 of 1 tag /)
  assert.doesNotMatch(r.out, /bob@example\.internal/)
})

test('a tag message is read — terms, paths, trailers — through a tag of a tag', () => {
  const sb = guarded({ publicEmails: [ALICE.email], terms: ['Project Nimbus'] })
  sb.commit()
  assert.equal(sb.push().code, 0)
  tag(sb, ['-a', 'inner', '-m', `Release\n\nSigned-off-by: Bob <${BOB.email}>`])
  tag(sb, ['-a', 'outer', 'inner', '-m', `Ship project nimbus from ${HOME_PATH}`])
  const r = sb.push(['origin', 'outer'])
  assert.notEqual(r.code, 0, r.out)
  assert.match(r.out, /trailer Signed-off-by/)
  assert.match(r.out, /term\s+[0-9a-f]{7}\s+tag message\s+pr… \(14 chars\)/)
  assert.match(r.out, /path\s+[0-9a-f]{7}\s+tag message/)
  assert.match(r.out, /in 2 of 2 tags/)
})

test('a clean annotated tag is pushed, and a lightweight one is its commit', () => {
  const sb = guarded()
  sb.commit()
  assert.equal(sb.push().code, 0)
  tag(sb, ['-a', 'v1', '-m', 'Release 1'])
  const r = sb.push(['origin', 'v1'])
  assert.equal(r.code, 0, r.out)
  assert.ok(sb.remoteHas('refs/tags/v1'))
  assert.match(r.out, /1 tag checked — clean/)
  tag(sb, ['v1-light'], BOB)
  assert.equal(sb.push(['origin', 'v1-light']).code, 0, 'a lightweight tag has no tagger to check')
})
