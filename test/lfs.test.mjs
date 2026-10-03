// Git LFS (DG-32): a tracked file is a pointer in the commit and its content goes to the
// LFS store through git-lfs's own hook. The content is read from the local object store
// as the file's lines; content that is not there is `unread`. Most tests write the
// pointer and the object by hand, so they need no git-lfs; the last one runs git-lfs
// itself, chained after disclosegate, and is skipped where git-lfs is not installed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { lfsPointer } from '../bin/lib/git.mjs'
import { ALICE, BOB, sandbox } from './helpers.mjs'

const CFG = { publicEmails: [ALICE.email], blockedDomains: ['example.internal'] }
const pointerOf = (content) => {
  const oid = createHash('sha256').update(content).digest('hex')
  return { oid, text: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(content)}\n` }
}
// The object where git-lfs keeps it: `.git/lfs/objects/aa/bb/<oid>`.
const store = (sb, content) => {
  const { oid } = pointerOf(content)
  const dir = join(sb.work, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, oid), content)
}
const guarded = () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  assert.equal(sb.run(['install']).code, 0)
  return sb
}

test('lfsPointer: a whole pointer, and nothing that only looks like one', () => {
  const { oid, text } = pointerOf('x\n')
  assert.deepEqual(lfsPointer(text), { oid, size: 2 })
  assert.equal(lfsPointer(`notes\noid sha256:${oid}\nsize 2\n`), null, 'no version line first')
  assert.equal(lfsPointer(`version https://git-lfs.github.com/spec/v1\nsize 2\n`), null, 'no oid')
  assert.equal(lfsPointer(`${text}${'x'.repeat(1024)}`), null, 'past 1024 bytes')
})

test('an LFS file is read as its content: a work address in it refuses the push', () => {
  const sb = guarded()
  const content = `data\ncontact ${BOB.email}\n`
  store(sb, content)
  sb.commit({ file: 'model.bin', content: pointerOf(content).text })
  const r = sb.push()
  assert.notEqual(r.code, 0, r.out)
  assert.match(r.out, /model\.bin:2/)
  assert.ok(!sb.remoteHas('refs/heads/main'))
})

test('a changed pointer is read again, as the new content', () => {
  const sb = guarded()
  const first = 'clean\n'
  store(sb, first)
  sb.commit({ file: 'model.bin', content: pointerOf(first).text })
  assert.equal(sb.push().code, 0)
  const second = `clean\nstill clean\n${BOB.email}\n`
  store(sb, second)
  sb.commit({ file: 'model.bin', content: pointerOf(second).text })
  const r = sb.push()
  assert.notEqual(r.code, 0, r.out)
  assert.match(r.out, /model\.bin:3/)
})

test('LFS content not on this machine is an unread finding, and refuses the push', () => {
  const sb = guarded()
  sb.commit({ file: 'model.bin', content: pointerOf('never stored\n').text })
  const r = sb.push()
  assert.notEqual(r.code, 0, r.out)
  assert.match(r.out, /its Git LFS content is not on this machine/)
})

test('clean LFS content passes, and a line that only looks like a pointer\'s is not read as one', () => {
  const sb = guarded()
  const content = 'weights\n'
  store(sb, content)
  sb.commit({ file: 'model.bin', content: pointerOf(content).text })
  sb.commit({ file: 'docs.md', content: `How a pointer looks:\n\noid sha256:${'a'.repeat(64)}\n` })
  const r = sb.push()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /2 commits checked — clean/)
})

test('scan --staged reads the content of a staged LFS file', () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  sb.commit()
  const content = `x\n${BOB.email}\n`
  store(sb, content)
  writeFileSync(join(sb.work, 'model.bin'), pointerOf(content).text)
  sb.git(['add', 'model.bin'])
  const r = sb.run(['scan', '--staged'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.stdout, /model\.bin:2/)
})

const lfs = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8' }).status === 0

test('with git-lfs itself: chained after disclosegate, it uploads nothing on a refused push and everything on a clean one', { skip: !lfs && 'git-lfs is not installed' }, () => {
  const sb = sandbox()
  sb.userConfig(CFG)
  sb.git(['lfs', 'install', '--local'])
  sb.git(['lfs', 'track', '*.bin'])
  sb.git(['add', '.gitattributes'])
  sb.git(['commit', '-q', '-m', 'track'])
  const f = sb.run(['install', '--force'])
  assert.equal(f.code, 0, f.out)
  assert.match(f.stdout, /it runs after disclosegate/, "git-lfs's hook is chained")

  sb.commit({ file: 'model.bin', content: `data\n${BOB.email}\n` })
  assert.match(sb.git(['cat-file', '-p', 'HEAD:model.bin']).stdout, /^version https:\/\/git-lfs/, 'committed as a pointer')
  const refused = sb.push()
  assert.notEqual(refused.code, 0, refused.out)
  assert.match(refused.out, /model\.bin:2/)
  const objects = join(sb.remote, 'lfs', 'objects')
  assert.ok(!existsSync(objects) || !readdirSync(objects).length, 'git-lfs uploaded nothing')

  sb.git(['reset', '-q', '--hard', 'HEAD~1'])
  sb.commit({ file: 'model.bin', content: 'clean weights\n' })
  const clean = sb.push()
  assert.equal(clean.code, 0, clean.out)
  assert.ok(readdirSync(objects).length, 'git-lfs uploaded the clean object')
})
