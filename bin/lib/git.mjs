// Reading what is about to leave: commit metadata, messages and added lines. Every call
// pins the settings that would change git's output — a pager, a signature check, an
// external diff, quoted paths, a dropped root diff, a diff relative to a subdirectory, a
// submodule described in lines — so a user's global config cannot make a line invisible
// to the rules.
//
// Nothing a commit carries can move the framing (DG-29). The patches come from one
// `git log -p --cc -U0 --format=%H`: the only text git writes of its own between them is
// a commit's sha on a line by itself, and every line a commit adds is inside a hunk,
// consumed by the hunk's own counts — so content never reaches the place where a sha is
// looked for, and a line outside a hunk that git does not write is an error, never
// skipped. The author, committer and message come from the commit object itself,
// through `git cat-file --batch`, which states each object's length in bytes before it.
// No separator byte is involved anywhere: a 0x01, a NUL past git's binary sniff or a
// whole fake header in a line, a message or a name is read as what it is.
import { spawn, spawnSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export class GitError extends Error {}

const PINNED = ['-c', 'core.quotePath=false', '-c', 'log.showSignature=false', '-c', 'log.showRoot=true', '-c', 'core.pager=cat', '-c', 'diff.noprefix=false', '-c', 'diff.relative=false']
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short', '-U0', '--src-prefix=a/', '--dst-prefix=b/']
// A merge's own changes: `git log -p` shows none, `--cc` the lines new to every parent.
const MERGES = ['--cc']
// The sha alone: nothing a commit carries is written into the framing.
const FORMAT = '%H'
const SHA_LINE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

export function git(args, { cwd, input } = {}) {
  const r = spawnSync('git', [...PINNED, ...args], { cwd, input, encoding: 'utf8', maxBuffer: 1 << 30 })
  if (r.error) throw new GitError(`git could not be run: ${r.error.code ?? r.error.message}`)
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '', status: r.status }
}

export const isZero = (sha) => /^0+$/.test(sha)
export const isSha = (s) => /^[0-9a-f]{7,64}$/i.test(s)

export function repoRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd })
  return r.ok ? r.out.trim() : null
}

export const hasCommit = (cwd, sha) => git(['cat-file', '-e', `${sha}^{commit}`], { cwd }).ok

// `"b/sp ace\tx"` → `sp ace<TAB>x`: git's C-style quoting, octal escapes as UTF-8 bytes.
function unquote(p) {
  if (!p.startsWith('"')) return p
  const bytes = []
  const s = p.slice(1, -1)
  const simple = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      bytes.push(...Buffer.from(s[i]))
      continue
    }
    const n = s[i + 1]
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(simple[n] ?? n.charCodeAt(0))
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// What git writes outside a hunk, besides the `diff` and `+++` lines read for the file
// name and the hunk headers: extended headers, the old side's name, a binary file's one
// line, the no-newline marker. Anything else there means the reading has lost its place.
const OUTSIDE = /^(?:old mode |new mode |deleted file mode |new file mode |mode |index |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |--- |\\)/

// The added lines of a diff produced with -U0, with their new-side line numbers, read a
// line at a time. A hunk is consumed by its own counts, so an added line whose text
// starts with `++ `, or is a sha, or a `diff --git`, is content — never a header.
//
// A merge comes as a combined diff (`--cc`): `@@@ -a,b -c,d +e,f @@@`, one `@` and one
// range per parent plus the result, and one marker column per parent in front of each
// line. A line with `-` in any column is in a parent and gone from the result; every
// other line is in the result, and is the merge's own only when every column is `+` —
// new to every parent. A line one parent already had was read in that parent's commit,
// or is already public.
//
// `log` mode reads `git log --format=%H` output: a sha on a line of its own, outside any
// hunk, opens the next commit. Without it, one diff, and a sha line is out of place. A
// hunk that ends early, a line no hunk can hold, or text git does not write is a
// GitError: the caller refuses the push rather than read less than was sent.
function patchReader({ log }) {
  const what = log ? 'git log' : 'git diff'
  let cur = log ? null : { added: [], files: [] }
  let file = null
  let hunk = null
  let no = 0
  let done = []
  const fail = (why) => {
    throw new GitError(`${what} output could not be read (${why}, line ${no}) — refusing rather than reading less`)
  }
  const plain = (x) => {
    const h = hunk
    if (x.startsWith('\\')) return
    if (x[0] === '+' && h.add > 0) {
      if (file) cur.added.push({ file, line: h.n, text: x.slice(1) })
      h.n++
      h.add--
    } else if (x[0] === '-' && h.del > 0) h.del--
    else if (x[0] === ' ' && h.add > 0 && h.del > 0) {
      h.n++
      h.add--
      h.del--
    } else fail('a line its hunk cannot hold')
    if (h.add === 0 && h.del === 0) hunk = null
  }
  const combined = (x) => {
    const h = hunk
    if (x.startsWith('\\')) return
    const cols = x.slice(0, h.parents)
    if (cols.length !== h.parents || /[^ +-]/.test(cols)) fail('a combined line without a column per parent')
    if (cols.includes('-')) {
      for (let p = 0; p < h.parents; p++) if (cols[p] === '-' && h.old[p]-- <= 0) fail('a combined hunk longer than its counts')
    } else {
      if (h.add <= 0) fail('a combined hunk longer than its counts')
      for (let p = 0; p < h.parents; p++) if (cols[p] === ' ' && h.old[p]-- <= 0) fail('a combined hunk longer than its counts')
      if (file && !cols.includes(' ')) cur.added.push({ file, line: h.n, text: x.slice(h.parents) })
      h.n++
      h.add--
    }
    if (h.add === 0 && h.old.every((c) => c === 0)) hunk = null
  }
  const line = (l) => {
    no++
    if (hunk) return hunk.parents ? combined(l) : plain(l)
    if (SHA_LINE.test(l)) {
      if (!log) fail('a commit in a single diff')
      if (cur) done.push(cur)
      cur = { sha: l, added: [], files: [] }
      file = null
      return
    }
    if (l === '') return
    if (!cur) fail('text before the first commit')
    if (/^diff (?:--git|--cc|--combined) /.test(l)) {
      file = null
      return
    }
    if (l.startsWith('+++ ')) {
      const p = l.slice(4)
      file = p === '/dev/null' ? null : unquote(p).replace(/^b\//, '')
      if (file) cur.files.push(file)
      return
    }
    const h = l.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (h) {
      const del = h[1] === undefined ? 1 : Number(h[1])
      const add = h[3] === undefined ? 1 : Number(h[3])
      if (del || add) hunk = { parents: 0, del, add, n: Number(h[2]) }
      return
    }
    const cc = l.match(/^(@{3,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1(?: |$)/)
    if (cc) {
      const parents = cc[1].length - 1
      const old = cc[2].trim().split(' ').map((r) => (r.includes(',') ? Number(r.split(',')[1]) : 1))
      if (old.length !== parents) fail('a combined hunk header without a range per parent')
      const add = cc[4] === undefined ? 1 : Number(cc[4])
      if (add || old.some((c) => c > 0)) hunk = { parents, old, add, n: Number(cc[3]) }
      return
    }
    if (OUTSIDE.test(l)) return
    fail('a line outside any hunk that git does not write')
  }
  return {
    line,
    // The commits completed so far — each one as soon as the next one's sha arrives.
    take() {
      const out = done
      done = []
      return out
    },
    end() {
      if (hunk) fail('the output ended inside a hunk')
      const out = this.take()
      if (cur) out.push(cur)
      cur = null
      return out
    },
  }
}

// The lines of git's output: the empty string after its final newline is not one.
const linesOf = (text) => {
  const lines = String(text).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export function parsePatch(text) {
  const r = patchReader({ log: false })
  for (const l of linesOf(text)) r.line(l)
  const [{ added, files }] = r.end()
  return { added, files }
}

// The patches of `git log --format=%H -p`: `{ sha, added, files }` per commit, in order.
export function parseLog(out) {
  const r = patchReader({ log: true })
  for (const l of linesOf(out)) r.line(l)
  return r.end()
}

// The arguments of the `git log` pass, without the pinned settings `git()` adds. revs
// are passed as separate arguments and never start with `-` unless we wrote them: a
// range from the command line is checked before it gets here.
export const logArgs = (revs) => ['log', '-p', ...MERGES, ...DIFF, `--format=${FORMAT}`, ...revs, '--']

// A commit object: headers, a blank line, the message — what `%an %ae %cn %ce %B`
// print, read from the object instead of from a format. A header that continues on lines
// beginning with a space (a signature, a mergetag) is skipped whole. An `encoding`
// header is honoured as `git log` honours it, re-encoding to UTF-8 where Node can.
export function parseCommit(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const blank = buf.indexOf('\n\n')
  const enc = (blank === -1 ? buf : buf.subarray(0, blank)).toString('latin1').match(/(?:^|\n)encoding ([^\n]+)/)?.[1]
  const text = decode(buf, enc)
  const split = text.indexOf('\n\n')
  const h = {}
  for (const l of (split === -1 ? text : text.slice(0, split)).split('\n')) {
    const sp = l.indexOf(' ')
    if (sp > 0 && !(l.slice(0, sp) in h)) h[l.slice(0, sp)] = l.slice(sp + 1)
  }
  return { author: person(h.author), committer: person(h.committer), message: split === -1 ? '' : text.slice(split + 2) }
}

function decode(buf, enc) {
  if (enc && !/^utf-?8$/i.test(enc.trim())) {
    try {
      return new TextDecoder(enc.trim()).decode(buf)
    } catch {
      // An encoding Node does not know: read the bytes as UTF-8, as git prints them.
    }
  }
  return buf.toString('utf8')
}

// `Name <email> 1700000000 +0000`, split as git splits it: the first `<`, the first `>`
// after it, the name without the space before the `<`. Unsplittable is empty, as %an is.
function person(v) {
  const s = v ?? ''
  const lt = s.indexOf('<')
  const gt = lt === -1 ? -1 : s.indexOf('>', lt + 1)
  if (gt === -1) return { name: '', email: '' }
  return { name: s.slice(0, lt).replace(/[ \t\r\n]+$/, ''), email: s.slice(lt + 1, gt) }
}

// A patch and its commit object, as one commit. A sha `git log` named that is not a
// commit to `git cat-file` means the two readings disagree: refused, not skipped.
function commitOf(p, o) {
  if (!o || o.type !== 'commit' || o.sha !== p.sha) throw new GitError(`git cat-file did not return the commit git log named (${p.sha.slice(0, 7)}) — refusing rather than reading less`)
  const { author, committer, message } = parseCommit(o.body)
  return { sha: p.sha, author, committer, message, added: p.added, files: p.files }
}

export function logCommits(cwd, revs) {
  const r = git(logArgs(revs), { cwd })
  if (!r.ok) throw new GitError(`git log failed: ${r.err.trim().split('\n')[0]}`)
  const patches = parseLog(r.out)
  if (!patches.length) return []
  const objects = catObjects(cwd, patches.map((p) => p.sha))
  if (objects.length !== patches.length) throw new GitError('git cat-file returned fewer objects than git log named commits — refusing rather than reading less')
  return patches.map((p, i) => commitOf(p, objects[i]))
}

// The log as it arrives: bytes in, whole patches out. A commit is complete when the next
// one's sha line arrives, so only the commit being read is held, never the history; a
// line split across two chunks waits in `pending`, and the decoder carries a character
// split across two, so the reading is the one `parseLog` makes of the whole string.
export function splitLog() {
  const decoder = new StringDecoder('utf8')
  const r = patchReader({ log: true })
  let pending = ''
  const take = (text) => {
    if (!text.includes('\n')) {
      pending += text
      return []
    }
    const lines = (pending + text).split('\n')
    pending = lines.pop()
    for (const l of lines) r.line(l)
    return r.take()
  }
  return {
    push: (chunk) => take(decoder.write(chunk)),
    end() {
      const out = take(decoder.end())
      if (pending !== '') r.line(pending)
      pending = ''
      return [...out, ...r.end()]
    },
    get pending() {
      return pending
    },
  }
}

// One `git cat-file --batch` kept open: a sha in, its object out, framed by the byte
// count git states before it. A request waits for its answer, so one object is held.
function catFile(cwd) {
  const child = spawn('git', [...PINNED, 'cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const queue = []
  let buf = Buffer.alloc(0)
  let err = ''
  let failed = null
  const settle = () => {
    while (queue.length) {
      const nl = buf.indexOf(10)
      if (nl === -1) break
      const [sha, type, size] = buf.toString('utf8', 0, nl).split(' ')
      if (size === undefined) {
        buf = buf.subarray(nl + 1)
        queue.shift().resolve({ sha, type })
        continue
      }
      const end = nl + 1 + Number(size)
      if (buf.length < end + 1) break
      queue.shift().resolve({ sha, type, body: buf.subarray(nl + 1, end) })
      buf = buf.subarray(end + 1)
    }
    if (failed) while (queue.length) queue.shift().reject(failed)
  }
  const fail = (e) => {
    failed ??= e
    settle()
  }
  child.stdout.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d
    settle()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => {
    if (err.length < 65536) err += d
  })
  child.stdin.on('error', () => {})
  child.on('error', (e) => fail(new GitError(`git could not be run: ${e.code ?? e.message}`)))
  child.on('close', (status) => fail(new GitError(`git cat-file ended: ${err.trim().split('\n')[0] || `exit ${status}`}`)))
  return {
    get: (sha) =>
      new Promise((resolve, reject) => {
        if (failed) return reject(failed)
        queue.push({ resolve, reject })
        child.stdin.write(`${sha}\n`)
      }),
    close() {
      child.stdin.end()
    },
  }
}

// `logCommits`, streamed: the commits one at a time as git writes them, so a history
// of any size is read in the memory of its largest commit. Each patch is joined to its
// commit object through one `git cat-file --batch` kept open beside the log. git's own
// error is the GitError `logCommits` throws, once the log has ended.
export async function* streamCommits(cwd, revs) {
  const child = spawn('git', [...PINNED, ...logArgs(revs)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => {
    if (err.length < 65536) err += d
  })
  const exited = new Promise((done) => {
    child.on('error', (e) => done({ error: e }))
    child.on('close', (status) => done({ status }))
  })
  const split = splitLog()
  let objects = null
  const commit = async (p) => commitOf(p, await (objects ??= catFile(cwd)).get(p.sha))
  try {
    for await (const chunk of child.stdout) for (const p of split.push(chunk)) yield await commit(p)
    const { error, status } = await exited
    if (error) throw new GitError(`git could not be run: ${error.code ?? error.message}`)
    if (status !== 0) throw new GitError(`git log failed: ${err.trim().split('\n')[0]}`)
    for (const p of split.end()) yield await commit(p)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    objects?.close()
  }
}


// The git hook protocol: one `<local-ref> <local-sha> <remote-ref> <remote-sha>` per
// ref. A deletion sends nothing and is skipped. A new branch sends whatever no ref of
// that remote already has. An update sends remote..local — unless the remote tip is
// not in this repository (someone else pushed; this is a force-push over it), where
// the new-branch rule is the only safe reading.
export function pushRevSets(stdin, remoteName, cwd) {
  const sets = []
  const tips = []
  let deletions = 0
  for (const raw of String(stdin).split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const p = line.split(/\s+/)
    if (p.length < 4 || !isSha(p[1]) || !isSha(p[3])) throw new GitError(`unexpected pre-push line: expected "<local-ref> <local-sha> <remote-ref> <remote-sha>"`)
    const [, local, , remote] = p
    if (isZero(local)) {
      deletions++
      continue
    }
    tips.push(local)
    if (isZero(remote) || !hasCommit(cwd, remote)) sets.push([local, '--not', `--remotes=${remoteName}`])
    else sets.push([`${remote}..${local}`])
  }
  return { sets, tips, deletions }
}

export function commitsForSets(cwd, sets) {
  const seen = new Map()
  for (const revs of sets) for (const c of logCommits(cwd, revs)) if (!seen.has(c.sha)) seen.set(c.sha, c)
  return [...seen.values()]
}

// Objects by sha through one `git cat-file --batch`, read as bytes: the size git
// prints is a byte count, and a message in UTF-8 has more bytes than characters.
function catObjects(cwd, shas) {
  const r = spawnSync('git', [...PINNED, 'cat-file', '--batch'], { cwd, input: `${shas.join('\n')}\n`, maxBuffer: 1 << 30 })
  if (r.error) throw new GitError(`git could not be run: ${r.error.code ?? r.error.message}`)
  if (r.status !== 0) throw new GitError(`git cat-file failed: ${String(r.stderr).trim().split('\n')[0]}`)
  const buf = r.stdout
  const objects = []
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf(10, i)
    if (nl === -1) break
    const [sha, type, size] = buf.toString('utf8', i, nl).split(' ')
    if (type === 'missing' || size === undefined) {
      i = nl + 1
      continue
    }
    const end = nl + 1 + Number(size)
    objects.push({ sha, type, body: buf.subarray(nl + 1, end) })
    i = end + 1
  }
  return objects
}

// An annotated tag object: `object`, `type`, `tag` and `tagger` headers, a blank line,
// the message (a signature, when there is one, is the end of the message). A header
// that continues on lines beginning with a space is skipped whole.
export function parseTag(sha, body) {
  const text = String(body)
  const split = text.indexOf('\n\n')
  const head = split === -1 ? text : text.slice(0, split)
  const h = {}
  for (const l of head.split('\n')) {
    const sp = l.indexOf(' ')
    if (sp > 0 && !(l.slice(0, sp) in h)) h[l.slice(0, sp)] = l.slice(sp + 1)
  }
  const who = (h.tagger ?? '').match(/^(.*?) <([^>]*)>/)
  return {
    sha,
    tag: h.tag ?? '',
    tagger: who ? { name: who[1], email: who[2] } : null,
    message: split === -1 ? '' : text.slice(split + 2),
    added: [],
    files: [],
    target: { sha: h.object, type: h.type },
  }
}

// The annotated tags among `shas`, and the tags they point at in turn: a tag of a tag
// publishes both. A sha that names a commit is not a tag and is left to `git log`.
export function tagsAt(cwd, shas) {
  const seen = new Map()
  let pending = [...new Set(shas)]
  while (pending.length) {
    const next = []
    for (const o of catObjects(cwd, pending)) {
      if (o.type !== 'tag' || seen.has(o.sha)) continue
      const t = parseTag(o.sha, o.body.toString('utf8'))
      seen.set(o.sha, t)
      if (t.target.type === 'tag' && isSha(t.target.sha ?? '')) next.push(t.target.sha)
    }
    pending = next.filter((s) => !seen.has(s))
  }
  return [...seen.values()]
}

// Every annotated tag a ref points at — what `--all` reaches beyond the commits.
export function allTags(cwd) {
  const r = git(['for-each-ref', '--format=%(objecttype) %(objectname)'], { cwd })
  if (!r.ok) throw new GitError(`git for-each-ref failed: ${r.err.trim().split('\n')[0]}`)
  const shas = r.out.split('\n').filter((l) => l.startsWith('tag ')).map((l) => l.slice(4))
  return shas.length ? tagsAt(cwd, shas) : []
}

const ident = (cwd, v) => {
  const r = git(['var', v], { cwd })
  const m = r.ok && r.out.match(/^(.*?) <([^>]*)>/)
  return m ? { name: m[1], email: m[2] } : null
}

// What the next commit would carry: the staged lines and the identity git would use.
export function stagedCommit(cwd) {
  const r = git(['diff', '--cached', '-p', ...DIFF, '--'], { cwd })
  if (!r.ok) throw new GitError(`git diff --cached failed: ${r.err.trim().split('\n')[0]}`)
  const { added, files } = parsePatch(r.out)
  return { sha: 'staged', author: ident(cwd, 'GIT_AUTHOR_IDENT'), committer: ident(cwd, 'GIT_COMMITTER_IDENT'), message: '', added, files }
}

// `scan` with no range: what a plain `git push` would most likely send.
export function defaultRevs(cwd) {
  if (!git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd }).ok) return null
  if (git(['rev-parse', '--verify', '-q', '@{upstream}'], { cwd }).ok) return ['@{upstream}..HEAD']
  return ['HEAD', '--not', '--remotes']
}
