// The rules, unit by unit. This is the one file in the repository that spells the
// path shapes out literally, because it defines them; `disclosegate check` skips it
// and `.disclosegate.json` exempts it from the path rule, and from nothing else.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { compileTerm, globToRegExp, mask, matchesGlob, pathMatches, scanCommits, textEmails, trailers, wildcard } from '../bin/lib/rules.mjs'
import { parseCommit, parsePatch, parseTag } from '../bin/lib/git.mjs'
import { checkEmails } from '../bin/lib/check.mjs'

const commit = (over = {}) => ({
  sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  author: { name: 'Alice', email: 'alice@personal.example' },
  committer: { name: 'Alice', email: 'alice@personal.example' },
  message: 'A plain message\n',
  added: [],
  files: [],
  ...over,
})
const cfg = (over = {}) => ({ publicEmails: ['alice@personal.example'], blockedDomains: [], terms: [], blockedNames: [], allowPaths: [], ...over })
const kinds = (fs) => fs.map((f) => `${f.rule}/${f.where}`)

test('the path rule finds home directories on three systems and file URLs', () => {
  for (const line of ['see /Users/alice/notes', 'cd /home/user/src', 'C:\\Users\\Bob Smith\\Desktop', '"C:\\\\Users\\\\bob\\\\x"', 'open file:///etc/hosts', 'x=/home/runner/work/']) {
    assert.equal(pathMatches(line).length, 1, line)
  }
  assert.equal(pathMatches('file:///home/user/a')[0].kind, 'file URL', 'one finding for a file URL into a home, not two')
  assert.equal(pathMatches('file:///home/user/a').length, 1)
})

test('the path rule leaves placeholders, URLs and bare roots alone', () => {
  for (const line of ['`/Users/<name>/`', '`/home/<name>/`', '`C:\\Users\\<name>\\`', '`file:///`', 'https://example.com/home/about/', 'https://example.com/Users/42/', 'cd /home', 'ls /Users', 'a.b/home/x/']) {
    assert.deepEqual(pathMatches(line), [], line)
  }
})

test('mask keeps two characters and the length', () => {
  assert.equal(mask('bob@example.internal'), 'bo… (20 chars)')
  assert.equal(mask('x'), 'x… (1 chars)')
  assert.equal(mask('café-é'), 'ca… (6 chars)', 'characters, not bytes')
})

test('trailers: every Token: line with an address, Co-authored-by and Signed-off-by included', () => {
  const t = trailers('Subject\n\nBody text: not a trailer@\nCo-authored-by: Bob <bob@example.internal>\nSigned-off-by: Carol <carol@example.com>\n')
  assert.deepEqual(t.map((x) => [x.key, x.email, x.name]), [
    ['Co-authored-by', 'bob@example.internal', 'Bob'],
    ['Signed-off-by', 'carol@example.com', 'Carol'],
  ])
})

test('email: an address outside publicEmails is a finding, wherever it sits', () => {
  const c = commit({ committer: { name: 'Bob', email: 'bob@example.internal' }, message: 'x\n\nCo-authored-by: Bob <bob@example.internal>\n' })
  const f = scanCommits([c], cfg())
  assert.deepEqual(kinds(f), ['email/committer', 'email/trailer Co-authored-by'])
  assert.equal(f[0].kind, 'not in publicEmails')
})

test('email: publicEmails takes wildcards, and an empty list switches the allowlist off', () => {
  const c = commit({ author: { name: 'A', email: '123+alice@users.noreply.example' } })
  assert.deepEqual(scanCommits([c], cfg({ publicEmails: ['alice@personal.example', '*@users.noreply.example'] })), [])
  assert.deepEqual(scanCommits([c], cfg({ publicEmails: [] })), [])
  assert.ok(wildcard('*@x.example').test('A@X.EXAMPLE'), 'case-insensitive')
})

test('email: a blocked domain is a finding whatever the allowlist says, subdomains too', () => {
  const c = commit({ author: { name: 'Bob', email: 'bob@mail.example.internal' } })
  const f = scanCommits([c], cfg({ publicEmails: ['alice@personal.example', 'bob@mail.example.internal'], blockedDomains: ['example.internal'] }))
  assert.deepEqual(f.map((x) => x.kind), ['blocked domain'])
  assert.deepEqual(scanCommits([commit({ author: { name: 'B', email: 'b@notexample.internal' } })], cfg({ publicEmails: [], blockedDomains: ['example.internal'] })), [], 'a suffix is not a subdomain')
})

test('terms: a plain string is case-insensitive, a /regex/ is a regex, in messages, lines and file names', () => {
  const terms = ['Project Nimbus', '/nimbus-(prod|stage)-\\d+/i'].map(compileTerm)
  const c = commit({
    message: 'Wire up project nimbus\n',
    files: ['deploy/nimbus-stage-2.conf'],
    added: [{ file: 'config.txt', line: 3, text: 'host = NIMBUS-PROD-7' }, { file: 'deploy/nimbus-stage-2.conf', line: 1, text: 'x' }],
  })
  const f = scanCommits([c], cfg({ terms }))
  assert.deepEqual(kinds(f), ['term/message', 'term/file name', 'term/config.txt:3'])
  assert.equal(f[2].match, 'NIMBUS-PROD-7')
})

test('a file whose name carries a term is never named in a location', () => {
  const terms = [compileTerm('nimbus')]
  const c = commit({ files: ['nimbus/a.txt'], added: [{ file: 'nimbus/a.txt', line: 4, text: 'cd /home/user/x' }] })
  const f = scanCommits([c], cfg({ terms }))
  const located = f.find((x) => x.rule === 'path')
  assert.equal(located.where, 'ni… (12 chars):4')
})

test('compileTerm refuses an invalid regex, an empty term and one that matches everything', () => {
  assert.throws(() => compileTerm('/(unclosed/'))
  assert.throws(() => compileTerm('   '))
  assert.throws(() => compileTerm('/x*/'))
  assert.ok(compileTerm('a.b').re.test('A.B') && !compileTerm('a.b').re.test('axb'), 'plain strings are literal')
})

test('names: author, committer and trailer names in blockedNames, exactly, case-insensitively', () => {
  const c = commit({ author: { name: 'Bob Example', email: 'alice@personal.example' }, message: 'x\n\nCo-authored-by: bob example <alice@personal.example>\n' })
  assert.deepEqual(kinds(scanCommits([c], cfg({ blockedNames: ['Bob Example'] }))), ['name/author', 'name/trailer Co-authored-by'])
  assert.deepEqual(scanCommits([c], cfg({ blockedNames: ['Bob'] })), [], 'a part of a name is not the name')
})

test('allowPaths exempts a file from the path rule only — never from the email or term rules', () => {
  const terms = [compileTerm('nimbus')]
  const c = commit({ author: { name: 'B', email: 'bob@example.internal' }, added: [{ file: 'test/fixtures/a.txt', line: 1, text: 'cd /home/user/nimbus' }] })
  const f = scanCommits([c], cfg({ terms, allowPaths: ['test/fixtures/**'] }))
  assert.deepEqual(kinds(f), ['email/author', 'term/test/fixtures/a.txt:1'])
  assert.equal(scanCommits([c], cfg({ terms })).filter((x) => x.rule === 'path').length, 1, 'without the glob the path is found')
})

test("the repository's own config is exempt from its own terms only — not the user's, not the other rules", () => {
  const own = { ...compileTerm('internal-name'), fromRepo: true }
  const users = compileTerm('private-name')
  const c = commit({
    added: [
      { file: '.disclosegate.json', line: 1, text: '{ "terms": ["internal-name", "private-name"], "allowPaths": ["/home/user/x"] }' },
      { file: 'notes.txt', line: 1, text: 'internal-name' },
      { file: 'sub/.disclosegate.json', line: 1, text: 'internal-name' },
    ],
  })
  const f = scanCommits([c], cfg({ terms: [own, users] }))
  assert.deepEqual(kinds(f), ['term/.disclosegate.json:1', 'term/notes.txt:1', 'term/sub/.disclosegate.json:1', 'path/.disclosegate.json:1'])
  assert.equal(f[0].match, 'private-name', 'only the user term is found in the config')
  const m = scanCommits([commit({ message: 'rename internal-name' })], cfg({ terms: [own] }))
  assert.deepEqual(kinds(m), ['term/message'], 'a commit message is not the config')
})

test('globs: ** crosses directories, * does not', () => {
  assert.ok(matchesGlob('test/fixtures/deep/a.txt', ['test/fixtures/**']))
  assert.ok(matchesGlob('a.txt', ['**/*.txt']) && matchesGlob('x/y/a.txt', ['**/*.txt']))
  assert.ok(!matchesGlob('test/fixtures/deep/a.txt', ['test/fixtures/*']))
  assert.ok(globToRegExp('./docs/*.md').test('docs/a.md'))
})

test('findings come worst first: blocked domain, unlisted address, term, name, path', () => {
  const c1 = commit({ sha: '1'.repeat(40), added: [{ file: 'a', line: 1, text: '/home/user/x' }] })
  const c2 = commit({ sha: '2'.repeat(40), author: { name: 'Bob', email: 'bob@example.internal' }, committer: { name: 'C', email: 'c@other.example' }, message: 'nimbus\n' })
  const f = scanCommits([c1, c2], cfg({ blockedDomains: ['other.example'], terms: [compileTerm('nimbus')], blockedNames: ['Bob'] }))
  assert.deepEqual(f.map((x) => `${x.rule}:${x.kind}`), ['email:blocked domain', 'email:not in publicEmails', 'term:term', 'name:blocked name', 'path:home directory'])
  assert.equal(f[0].short, '2222222')
})

test('parsePatch: new-side line numbers, no context, and a line that starts with ++ is content', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    'index 1..2 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -2 +2,2 @@',
    '-old',
    '+++ not a header',
    '+second',
    '@@ -10,0 +12 @@',
    '+twelve',
    '\\ No newline at end of file',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git "a/sp ace\\tx" "b/sp ace\\tx"',
    '--- /dev/null',
    '+++ "b/sp ace\\tx"',
    '@@ -0,0 +1 @@',
    '+q',
  ].join('\n')
  const { added, files } = parsePatch(patch)
  assert.deepEqual(added, [
    { file: 'a.txt', line: 2, text: '++ not a header' },
    { file: 'a.txt', line: 3, text: 'second' },
    { file: 'a.txt', line: 12, text: 'twelve' },
    { file: 'sp ace\tx', line: 1, text: 'q' },
  ])
  assert.deepEqual(files, ['a.txt', 'sp ace\tx'])
})

test('a tag: the tagger is read like a committer, its message like a commit message', () => {
  const t = { sha: 'f'.repeat(40), tag: 'v1', tagger: { name: 'Bob Example', email: 'bob@example.internal' }, message: 'Release nimbus\n\nCo-authored-by: Carol <carol@example.com>\n', added: [], files: [] }
  const f = scanCommits([t], cfg({ terms: [compileTerm('nimbus')], blockedNames: ['Bob Example'] }))
  assert.deepEqual(kinds(f), ['email/tagger', 'email/trailer Co-authored-by', 'term/tag message', 'name/tagger'])
  assert.ok(f.every((x) => x.tag), 'a finding on a tag says so')
})

test("parsePatch: a merge's combined hunks — only a line new to every parent is added", () => {
  const patch = [
    'diff --cc x.txt',
    'index 1,2..3',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@@ -1,2 -1,2 +1,4 @@@',
    '- two',
    ' -three',
    '++nimbus',
    '++++ not a header',
    ' +ours',
    '+ theirs',
    'diff --cc y.txt',
    'index 0000000,0000000..3',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/y.txt',
    '@@@ -1,0 -1,0 +1,1 @@@',
    '++new',
    'diff --cc z.txt',
    'index 1,2,3..4',
    '--- a/z.txt',
    '+++ b/z.txt',
    '@@@@ -5,0 -5,0 -5,1 +5,2 @@@@',
    '+++octopus',
    '++ in the third parent',
    'diff --git a/w.txt b/w.txt',
    '--- a/w.txt',
    '+++ b/w.txt',
    '@@ -0,0 +1 @@',
    '+plain',
  ].join('\n')
  const { added, files } = parsePatch(patch)
  assert.deepEqual(added, [
    { file: 'x.txt', line: 1, text: 'nimbus' },
    { file: 'x.txt', line: 2, text: '++ not a header' },
    { file: 'y.txt', line: 1, text: 'new' },
    { file: 'z.txt', line: 5, text: 'octopus' },
    { file: 'w.txt', line: 1, text: 'plain' },
  ])
  assert.deepEqual(files, ['x.txt', 'y.txt', 'z.txt', 'w.txt'])
})

test('blockedDomains: an address at a blocked domain in a message or an added line is a finding', () => {
  const c = commit({
    message: 'Ask bob@mail.example.internal\n\nCo-authored-by: Bob <bob@example.internal>\n',
    added: [
      { file: 'test/fixtures/a.txt', line: 2, text: 'remote = ssh://git@git.example.internal/group/repo.git' },
      { file: 'notes.txt', line: 1, text: 'write to dave@example.com or carol@notexample.internal' },
    ],
  })
  const f = scanCommits([c], cfg({ blockedDomains: ['example.internal'], allowPaths: ['test/fixtures/**'] }))
  assert.deepEqual(kinds(f), ['email/trailer Co-authored-by', 'email/message', 'email/test/fixtures/a.txt:2'], 'a trailer once, allowPaths no exemption')
  assert.ok(f.every((x) => x.kind === 'blocked domain' && x.rank === 0))
  assert.deepEqual(f.slice(1).map((x) => x.match), ['bob@mail.example.internal', 'git@git.example.internal'])
  assert.deepEqual(kinds(scanCommits([c], cfg())), ['email/trailer Co-authored-by'], 'text is read against blockedDomains only, never publicEmails')
  const t = { sha: 'e'.repeat(40), tag: 'v1', tagger: { name: 'Alice', email: 'alice@personal.example' }, message: 'cc bob@example.internal\n', added: [], files: [] }
  assert.deepEqual(kinds(scanCommits([t], cfg({ blockedDomains: ['example.internal'] }))), ['email/tag message'])
})

test('blockedDomains: a trailer address that runs into a path is still at its host', () => {
  const c = commit({ message: 'x\n\nSee-also: git@git.example.internal/group/repo.git\n' })
  const f = scanCommits([c], cfg({ publicEmails: [], blockedDomains: ['example.internal'] }))
  assert.deepEqual(f.map((x) => [x.where, x.match]), [['message', 'git@git.example.internal']])
})

test('unread: a file not read in full is a finding of its own, last, under a masked name when its name is secret (DG-30)', () => {
  const c = commit({
    files: ['big.dat', 'nimbus-dump.bin'],
    added: [{ file: 'big.dat', line: 1, text: 'see /home/user/x' }],
    unread: [{ file: 'big.dat', why: 'limit' }, { file: 'nimbus-dump.bin', why: 'binary' }],
  })
  const f = scanCommits([c], cfg({ terms: [compileTerm('nimbus')] }))
  assert.deepEqual(kinds(f), ['term/file name', 'path/big.dat:1', 'unread/big.dat', 'unread/ni… (15 chars)'])
  assert.deepEqual(f.filter((x) => x.rule === 'unread').map((x) => x.kind), ['read in part — past the read limit', 'not read — git printed it as binary'])
  assert.deepEqual(scanCommits([commit()], cfg()), [], 'a commit without unread files has no such finding')
})

// DG-31: every built-in pattern that reads content is linear in the line. Each scan runs in
// a child process with a hard stop, because a regex cannot be interrupted in the thread
// that runs it: a quadratic pattern fails here in seconds instead of holding CI for hours.
// The bounds are generous — the scans take milliseconds; the patterns they replaced took
// seconds on the same input.
function timed(body, { limit = 30000 } = {}) {
  const lib = (f) => JSON.stringify(new URL(`../bin/lib/${f}`, import.meta.url).href)
  const code = `import * as rules from ${lib('rules.mjs')}\nimport * as git from ${lib('git.mjs')}\nconst t0 = performance.now()\nconst result = (() => { ${body} })()\nprocess.stdout.write(JSON.stringify({ ms: performance.now() - t0, result }))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: limit, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.signal, null, `killed after ${limit} ms — not linear`)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const SCAN = `const cfg = { publicEmails: ['*@*.example', 'alice@personal.example'], blockedDomains: ['example.internal'], terms: [], blockedNames: [], allowPaths: [] }
const commit = (over) => ({ sha: 'a'.repeat(40), author: { name: 'A', email: 'alice@personal.example' }, committer: { name: 'A', email: 'alice@personal.example' }, message: 'm\\n', added: [], files: [], ...over })
const kinds = (fs) => fs.map((f) => f.rule + '/' + f.where + '/' + f.match.length)`

test('DG-31: a 100k-letter line is read in well under a second, and lines of 25k, 50k and 100k together', () => {
  const one = timed(`${SCAN}
    return kinds(rules.scanCommits([commit({ added: [{ file: 'a', line: 1, text: 'a'.repeat(100000) }] })], cfg))`)
  assert.deepEqual(one.result, [])
  assert.ok(one.ms < 1000, `${one.ms.toFixed(0)} ms`)
  const three = timed(`${SCAN}
    const added = [25000, 50000, 100000].map((n, i) => ({ file: 'a', line: i + 1, text: 'x'.repeat(n) }))
    return kinds(rules.scanCommits([commit({ added })], cfg))`)
  assert.deepEqual(three.result, [])
  assert.ok(three.ms < 2000, `${three.ms.toFixed(0)} ms`)
})

test('DG-31: a base64 blob of a few MB on one line, and random bytes read as text, stay linear', () => {
  const r = timed(`${SCAN}
    let x = 7
    const bytes = Buffer.alloc(3 * 1024 * 1024).map(() => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 16) & 255)
    const added = [{ file: 'blob.b64', line: 1, text: bytes.toString('base64url') }, { file: 'blob.bin', line: 1, text: bytes.toString('latin1') }]
    return kinds(rules.scanCommits([commit({ added })], cfg))`)
  assert.deepEqual(r.result, [])
  assert.ok(r.ms < 5000, `${r.ms.toFixed(0)} ms`)
})

test('DG-31: an address after a long run of letters is still found, and one that is the run', () => {
  const r = timed(`${SCAN}
    const run = 'a'.repeat(100000)
    const added = [{ file: 'a', line: 1, text: run + ' bob@example.internal' }, { file: 'a', line: 2, text: run + '@mail.example.internal' }, { file: 'a', line: 3, text: run + '.' + run + '@example.internal' }]
    return kinds(rules.scanCommits([commit({ added })], cfg))`)
  assert.deepEqual(r.result, ['email/a:1/20', 'email/a:2/100022', 'email/a:3/200018'])
  assert.ok(r.ms < 1000, `${r.ms.toFixed(0)} ms`)
})

test('DG-31: a message — trailer values, angle brackets, whitespace before a CR — stays linear', () => {
  const r = timed(`${SCAN}
    const n = 100000
    const message = ['m', '', 'Data: ' + 'a'.repeat(n), 'Data: ' + 'a'.repeat(n) + '@' + 'b'.repeat(n), 'Co-authored-by: ' + '<'.repeat(n), 'Key:' + ' '.repeat(n) + 'x\\ry', 'Co-authored-by: Bob <' + 'b'.repeat(n) + '@x.example>', ''].join('\\n')
    return kinds(rules.scanCommits([commit({ message })], cfg))`)
  assert.deepEqual(r.result, [])
  assert.ok(r.ms < 2000, `${r.ms.toFixed(0)} ms`)
})

test('DG-31: identities — a long name, a tagger without a closing bracket, a wildcard with two stars — stay linear', () => {
  const r = timed(`
    const n = 100000
    const c = git.parseCommit('tree ' + '0'.repeat(40) + '\\nauthor A' + ' '.repeat(n) + 'x <a@b.example> 1 +0000\\ncommitter C <c@d.example> 1 +0000\\n\\nm\\n')
    const t = git.parseTag('f'.repeat(40), 'object x\\ntype commit\\ntag v1\\ntagger' + ' <'.repeat(n) + '\\n\\nm\\n')
    return [c.author.name.length, t.tagger, rules.wildcard('*@*.example').test('@'.repeat(n)), rules.wildcard('*@*.example').test('a'.repeat(n) + '@b.example')]`)
  assert.deepEqual(r.result, [100002, null, false, true])
  assert.ok(r.ms < 2000, `${r.ms.toFixed(0)} ms`)
})

// The patterns as they were before DG-31, kept as the reference the scans must agree with
// on every input: same matches, same order, same text.
const OLD = {
  text: /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/g,
  loose: /[^\s<>"'(),;:@]+@[^\s<>"'(),;:@]+\.[A-Za-z]{2,}/g,
  check: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  trailer: /^\s*([A-Za-z][A-Za-z0-9-]*):\s+(.*)$/,
}
const oldAll = (re, s) => [...s.matchAll(re)].map((m) => m[0])
const oldTrailers = (message) => {
  const out = []
  message.split('\n').forEach((line, i) => {
    const m = line.match(OLD.trailer)
    if (!m) return
    // `split(re).join('')` is `replace(re, '')` for a pattern without groups: the old
    // pattern, not a sanitiser — the name is compared, never rendered.
    const name = m[2].split(/<[^>]*>/).join('').trim()
    for (const e of m[2].matchAll(OLD.loose)) out.push({ key: m[1], email: e[0], name, line: i + 1 })
  })
  return out
}
const oldWildcard = (p) => new RegExp(`^${String(p).split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
const oldTagger = (v) => v.match(/^(.*?) <([^>]*)>/)
const oldName = (v) => v.replace(/[ \t\r\n]+$/, '')

function fuzz(seed) {
  let x = seed
  const rand = (n) => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 8) % n
  const atoms = ['a', 'Z', '7', '.', '-', '_', '%', '+', '@', '@', '.', 'com', 'ex', 'b-c', ' ', '\t', '\r', '\u2028', '\u00a0', '<', '>', ':', 'Key:', 'Co-authored-by: ', '/', '"', ',', 'é', '*', 'A1']
  return () => {
    let s = ''
    for (let i = rand(24); i > 0; i--) s += atoms[rand(atoms.length)]
    return s
  }
}

test('DG-31: the scans agree with the patterns they replaced, on 20,000 generated inputs each', () => {
  const gen = fuzz(31)
  for (let i = 0; i < 20000; i++) {
    const s = gen()
    assert.deepEqual(textEmails(s), oldAll(OLD.text, s), JSON.stringify(s))
    assert.deepEqual(checkEmails(s), oldAll(OLD.check, s), JSON.stringify(s))
    const message = `${gen()}\n${gen()}\n${s}`
    assert.deepEqual(trailers(message), oldTrailers(message), JSON.stringify(message))
    const [p, q] = [gen(), gen()]
    assert.equal(wildcard(p).test(q), oldWildcard(p).test(q), JSON.stringify([p, q]))
    const tagger = gen()
    const t = parseTag('f'.repeat(40), `tag v1\ntagger ${tagger}\n\nm\n`).tagger
    const o = oldTagger(tagger)
    assert.deepEqual(t, o ? { name: o[1], email: o[2] } : null, JSON.stringify(tagger))
    const author = gen().replace(/\n/g, '')
    const lt = author.indexOf('<')
    if (lt !== -1 && author.indexOf('>', lt + 1) !== -1) assert.equal(parseCommit(`author ${author}\n\nm\n`).author.name, oldName(author.slice(0, lt)), JSON.stringify(author))
  }
})
