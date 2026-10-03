// The rules, unit by unit. This is the one file in the repository that spells the
// path shapes out literally, because it defines them; `disclosegate check` skips it
// and `.disclosegate.json` exempts it from the path rule, and from nothing else.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileTerm, globToRegExp, mask, matchesGlob, pathMatches, scanCommits, trailers, wildcard } from '../bin/lib/rules.mjs'
import { parsePatch } from '../bin/lib/git.mjs'

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
