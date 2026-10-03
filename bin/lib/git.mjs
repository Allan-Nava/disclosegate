// Reading what is about to leave: commit metadata, messages and added lines. Every call
// pins the settings that would change git's output — a pager, a signature check, an
// external diff, a textconv, quoted paths, a dropped root diff, a diff relative to a
// subdirectory, a submodule described in lines — so a user's global config cannot make a
// line invisible to the rules.
//
// Nothing a commit carries can move the framing (DG-29). The patches come from one
// `git log -p --cc -U0 --format=%H`: the only text git writes of its own between them is
// a commit's sha on a line by itself, and every line a commit adds is inside a hunk,
// consumed by the hunk's own counts — so content never reaches the place where a sha is
// looked for, and a line outside a hunk that git does not write is an error, never
// skipped. The author, committer and message come from the commit object itself,
// through `git cat-file --batch`, which states each object's length in bytes before it.
// No separator byte is involved anywhere: a 0x01, a NUL or a whole fake header in a
// line, a message or a name is read as what it is.
//
// Nothing is binary to the reading (DG-30). `--text` makes git print every file as lines
// whatever its attributes (`-diff`, `binary`, a driver set to binary — from the
// repository, `info/attributes` or the user's `core.attributesFile`), its size against
// `core.bigFileThreshold`, or a NUL in its first bytes. The one place git ignores
// `--text` is a merge's combined diff; there a file git calls binary is read through one
// diff per parent (`mergeOwn`). The lines are split on the newline byte alone; a file's
// added text is read up to `READ_LIMIT` bytes in a commit, and a commit's up to
// `COMMIT_LIMIT`. What lies past either is consumed for the framing, not decoded, and
// its file is reported `unread` — never dropped quietly.
import { spawn, spawnSync } from 'node:child_process'

export class GitError extends Error {}

const PINNED = ['-c', 'core.quotePath=false', '-c', 'log.showSignature=false', '-c', 'log.showRoot=true', '-c', 'core.pager=cat', '-c', 'diff.noprefix=false', '-c', 'diff.relative=false']
const DIFF = ['--no-color', '--text', '--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short', '-U0', '--src-prefix=a/', '--dst-prefix=b/']
// A merge's own changes: `git log -p` shows none, `--cc` the lines new to every parent.
const MERGES = ['--cc']
// The sha alone: nothing a commit carries is written into the framing.
const FORMAT = '%H'
const SHA_LINE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

// Bytes of a file's added text read in one commit. Past it, the lines are counted, not
// kept, and the file is an `unread` finding: memory and time stay bounded on a large
// binary, and what was not read is said. Per file, so one large file never costs another
// its reading. 100 MiB is where GitHub refuses a file outright; text that size was read
// whole before `--text`, and still is.
export const READ_LIMIT = 100 * 1024 * 1024
// Bytes of added text read in one commit, all files together: the most a commit holds in
// memory. About where the collected reading of 0.0.3 failed outright, on a string longer
// than V8 allows — so no commit it could read is read less now.
export const COMMIT_LIMIT = 512 * 1024 * 1024
// The longest line outside a hunk taken for git's own: a header, a path. Longer is not
// git's, and is an error.
const HEADER_LIMIT = 1024 * 1024

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
// name, the hunk headers and a `Binary files` line: extended headers, the old side's
// name, the no-newline marker. Anything else there means the reading has lost its place.
const OUTSIDE = /^(?:old mode |new mode |deleted file mode |new file mode |mode |index |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |--- |\\)/

const PLUS = 0x2b
const MINUS = 0x2d
const SPACE = 0x20
const BACKSLASH = 0x5c

// `Binary files a/<p> and b/<p> differ`, either side possibly /dev/null: the file's name.
// Without renames both sides name the same path, so they are the same length, and a name
// holding " and " still splits in the middle.
function binaryName(inner) {
  let p
  if (inner.startsWith('/dev/null and ')) p = inner.slice('/dev/null and '.length)
  else if (inner.endsWith(' and /dev/null')) p = inner.slice(0, -' and /dev/null'.length)
  else p = inner.slice((inner.length - ' and '.length) / 2 + ' and '.length)
  return unquote(p).replace(/^[ab]\//, '')
}

// The added lines of a diff produced with -U0, with their new-side line numbers, read a
// line at a time as bytes. A hunk is consumed by its own counts, so an added line whose
// text starts with `++ `, or is a sha, or a `diff --git`, is content — never a header.
// Only the newline byte ends a line: a NUL, a CR, 0x01 to 0x03 are content.
//
// A merge comes as a combined diff (`--cc`): `@@@ -a,b -c,d +e,f @@@`, one `@` and one
// range per parent plus the result, and one marker column per parent in front of each
// line. A line with `-` in any column is in a parent and gone from the result; every
// other line is in the result, and is the merge's own only when every column is `+` —
// new to every parent. A line one parent already had was read in that parent's commit,
// or is already public. A file the combined diff calls binary — it does whatever
// `--text` says — is listed in `binary` and read per parent once the parents are known.
//
// At most `limit` bytes of a file's added text are decoded, and `commitLimit` of a
// commit's; the lines past either are consumed by their marker byte, and a file that lost
// text is listed in `unread`.
// `room()` tells the splitter how much of the next line to keep.
//
// `log` mode reads `git log --format=%H` output: a sha on a line of its own, outside any
// hunk, opens the next commit. Without it, one diff, and a sha line is out of place. A
// hunk that ends early, a line no hunk can hold, or text git does not write is a
// GitError: the caller refuses the push rather than read less than was sent.
function patchReader({ log, limit = READ_LIMIT, commitLimit = COMMIT_LIMIT }) {
  const what = log ? 'git log' : 'git diff'
  const fresh = (sha) => ({ ...(sha ? { sha } : {}), added: [], files: [], unread: [], binary: [], read: 0 })
  let cur = log ? null : fresh()
  let file = null
  let fileRead = 0
  let combinedFile = null
  let hunk = null
  let no = 0
  let done = []
  const fail = (why) => {
    throw new GitError(`${what} output could not be read (${why}, line ${no}) — refusing rather than reading less`)
  }
  const unread = (f, why) => {
    if (f != null && !cur.unread.some((u) => u.file === f)) cur.unread.push({ file: f, why })
  }
  // What the file's budget and the commit's still hold.
  const budget = () => Math.max(0, Math.min(limit - fileRead, commitLimit - cur.read))
  // An added line: its text from byte `skip`, as much as the budget holds.
  const record = (b, total, skip) => {
    if (!file) return
    const left = budget()
    if (left <= 0) {
      if (total > skip) unread(file, 'limit')
      return
    }
    const have = Math.min(b.length - skip, left)
    cur.added.push({ file, line: hunk.n, text: b.toString('utf8', skip, skip + have) })
    fileRead += have
    cur.read += have
    if (total - skip > have) unread(file, 'limit')
  }
  const plain = (b, total) => {
    const h = hunk
    const c = b[0]
    if (c === BACKSLASH) return
    if (c === PLUS && h.add > 0) {
      record(b, total, 1)
      h.n++
      h.add--
    } else if (c === MINUS && h.del > 0) h.del--
    else if (c === SPACE && h.add > 0 && h.del > 0) {
      h.n++
      h.add--
      h.del--
    } else fail('a line its hunk cannot hold')
    if (h.add === 0 && h.del === 0) hunk = null
  }
  const combined = (b, total) => {
    const h = hunk
    if (b[0] === BACKSLASH) return
    const cols = b.toString('latin1', 0, h.parents)
    if (cols.length !== h.parents || /[^ +-]/.test(cols)) fail('a combined line without a column per parent')
    if (cols.includes('-')) {
      for (let p = 0; p < h.parents; p++) if (cols[p] === '-' && h.old[p]-- <= 0) fail('a combined hunk longer than its counts')
    } else {
      if (h.add <= 0) fail('a combined hunk longer than its counts')
      for (let p = 0; p < h.parents; p++) if (cols[p] === ' ' && h.old[p]-- <= 0) fail('a combined hunk longer than its counts')
      if (!cols.includes(' ')) record(b, total, h.parents)
      h.n++
      h.add--
    }
    if (h.add === 0 && h.old.every((c) => c === 0)) hunk = null
  }
  const header = (l) => {
    if (SHA_LINE.test(l)) {
      if (!log) fail('a commit in a single diff')
      if (cur) done.push(cur)
      cur = fresh(l)
      file = null
      combinedFile = null
      return
    }
    if (l === '') return
    if (!cur) fail('text before the first commit')
    const d = l.match(/^diff (--git|--cc|--combined) (.*)$/)
    if (d) {
      file = null
      fileRead = 0
      combinedFile = d[1] === '--git' ? null : unquote(d[2])
      return
    }
    if (l.startsWith('+++ ')) {
      const p = l.slice(4)
      file = p === '/dev/null' ? null : unquote(p).replace(/^b\//, '')
      fileRead = 0
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
    // A combined diff ignores --text: its binary file is read per parent. A two-sided
    // diff never prints this under --text; if it does, the file is reported, not skipped.
    if (l === 'Binary files differ' && combinedFile != null) {
      if (!log) unread(combinedFile, 'binary')
      else if (!cur.binary.includes(combinedFile)) cur.binary.push(combinedFile)
      return
    }
    const bin = l.match(/^Binary files (.+) differ$/)
    if (bin) {
      const name = binaryName(bin[1])
      if (!cur.files.includes(name)) cur.files.push(name)
      unread(name, 'binary')
      return
    }
    if (OUTSIDE.test(l)) return
    fail('a line outside any hunk that git does not write')
  }
  return {
    // How many bytes of the next line to keep: inside a hunk, its marker columns and what
    // the budget still holds — nothing more for a file that is not read (a deletion);
    // outside, a header's worth.
    room() {
      if (!hunk) return HEADER_LIMIT
      const markers = hunk.parents || 1
      return file ? markers + budget() : markers
    },
    // One line, without its newline: `b` the bytes kept of it, `total` its length.
    bytes(b, total) {
      no++
      if (hunk) return hunk.parents ? combined(b, total) : plain(b, total)
      if (total > b.length) fail('a line outside any hunk longer than git writes')
      return header(b.toString('utf8'))
    },
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

// Bytes in, lines out: a line is cut at the newline byte, and of each only what the
// reader has room for is kept — a line of any length costs its kept bytes, never more.
// A line split across two chunks waits in `parts`.
function lineSplitter(r) {
  let parts = []
  let kept = 0
  let total = 0
  let room = -1
  const flush = () => {
    r.bytes(parts.length === 1 ? parts[0] : Buffer.concat(parts, kept), total)
    parts = []
    kept = 0
    total = 0
    room = -1
  }
  return {
    push(buf) {
      let i = 0
      while (i < buf.length) {
        if (room < 0) room = r.room()
        const nl = buf.indexOf(10, i)
        const end = nl === -1 ? buf.length : nl
        const take = Math.min(end - i, room - kept)
        if (take > 0) {
          parts.push(buf.subarray(i, i + take))
          kept += take
        }
        total += end - i
        if (nl === -1) return
        flush()
        i = nl + 1
      }
    },
    end() {
      if (total > 0) flush()
    },
    get pending() {
      return Buffer.concat(parts, kept).toString('utf8')
    },
  }
}

const bytesOf = (text) => (Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8'))

// One diff — `git diff`, `diff-tree` — as `{ added, files, unread }`.
export function parsePatch(text, { limit, commitLimit } = {}) {
  const r = patchReader({ log: false, limit, commitLimit })
  const s = lineSplitter(r)
  s.push(bytesOf(text))
  s.end()
  const [{ added, files, unread }] = r.end()
  return { added, files, unread }
}

// The patches of `git log --format=%H -p`, in order: `{ sha, added, files, unread,
// binary, read }` per commit — what `splitLog` yields, from the whole output at once.
export function parseLog(out, opts) {
  const s = splitLog(opts)
  return [...s.push(bytesOf(out)), ...s.end()]
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

// The parents a commit object names, in order.
const parentsOf = (body) => {
  const head = body.subarray(0, body.indexOf('\n\n') === -1 ? body.length : body.indexOf('\n\n')).toString('latin1')
  return [...head.matchAll(/^parent ([0-9a-f]+)$/gm)].map((m) => m[1])
}

// A merge's own lines in a file its combined diff printed as binary — `--cc` ignores
// `--text`, and a `-diff` lock file is what a conflict is most often resolved in. One
// `--text` diff per parent; a line is the merge's own when every parent's diff adds it,
// which is what the combined diff's `+` in every column means. Within what the commit's
// budget has left.
function mergeOwn(cwd, sha, parents, path, left) {
  const per = parents.map((parent) => {
    const r = gitBytes(['--literal-pathspecs', 'diff-tree', '-p', ...DIFF, parent, sha, '--', path], { cwd })
    if (!r.ok) throw new GitError(`git diff-tree failed: ${r.err.trim().split('\n')[0]}`)
    return parsePatch(r.out, { commitLimit: left })
  })
  const rest = per.slice(1).map((p) => new Set(p.added.map((a) => a.line)))
  const added = per[0].added.filter((a) => rest.every((s) => s.has(a.line)))
  const lost = per.flatMap((p) => p.unread).find((u) => u.file === path)
  return { added, unread: lost ? [{ file: path, why: lost.why }] : [] }
}

// A patch and its commit object, as one commit. A sha `git log` named that is not a
// commit to `git cat-file` means the two readings disagree: refused, not skipped.
function commitOf(cwd, p, o) {
  if (!o || o.type !== 'commit' || o.sha !== p.sha) throw new GitError(`git cat-file did not return the commit git log named (${p.sha.slice(0, 7)}) — refusing rather than reading less`)
  const { author, committer, message } = parseCommit(o.body)
  const c = { sha: p.sha, author, committer, message, added: p.added, files: p.files, unread: p.unread }
  let read = p.read
  for (const path of p.binary) {
    const own = mergeOwn(cwd, p.sha, parentsOf(o.body), path, COMMIT_LIMIT - read)
    for (const a of own.added) read += Buffer.byteLength(a.text)
    c.added = [...c.added, ...own.added]
    if (!c.files.includes(path)) c.files = [...c.files, path]
    for (const u of own.unread) if (!c.unread.some((x) => x.file === u.file)) c.unread = [...c.unread, u]
  }
  return c
}

// git's output as bytes: a line of a binary file is not UTF-8, and a log of large files
// is longer than a string can be.
function gitBytes(args, { cwd } = {}) {
  const r = spawnSync('git', [...PINNED, ...args], { cwd, maxBuffer: 1 << 30 })
  if (r.error) throw new GitError(`git could not be run: ${r.error.code ?? r.error.message}`)
  return { ok: r.status === 0, out: r.stdout, err: String(r.stderr ?? '') }
}

// The collected reading: the whole log, then the objects. The commands stream instead
// (`streamCommits`); this is the reading they are held to.
export function logCommits(cwd, revs) {
  const r = gitBytes(logArgs(revs), { cwd })
  if (!r.ok) throw new GitError(`git log failed: ${r.err.trim().split('\n')[0]}`)
  const patches = parseLog(r.out)
  if (!patches.length) return []
  const objects = catObjects(cwd, patches.map((p) => p.sha))
  if (objects.length !== patches.length) throw new GitError('git cat-file returned fewer objects than git log named commits — refusing rather than reading less')
  return patches.map((p, i) => commitOf(cwd, p, objects[i]))
}

// The log as it arrives: bytes in, whole patches out. A commit is complete when the next
// one's sha line arrives, so only the commit being read is held, never the history; a
// line split across two chunks waits in the splitter, and a line is decoded only once
// whole, so the reading is the one `parseLog` makes of the whole output.
export function splitLog({ limit, commitLimit } = {}) {
  const r = patchReader({ log: true, limit, commitLimit })
  const s = lineSplitter(r)
  return {
    push(chunk) {
      s.push(chunk)
      return r.take()
    },
    end() {
      s.end()
      return r.end()
    },
    get pending() {
      return s.pending
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
  const commit = async (p) => commitOf(cwd, p, await (objects ??= catFile(cwd)).get(p.sha))
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

// The commits of several rev sets — a push of several refs — each once, streamed.
export async function* streamSets(cwd, sets) {
  const seen = new Set()
  for (const revs of sets) {
    for await (const c of streamCommits(cwd, revs)) {
      if (seen.has(c.sha)) continue
      seen.add(c.sha)
      yield c
    }
  }
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
  const r = gitBytes(['diff', '--cached', '-p', ...DIFF, '--'], { cwd })
  if (!r.ok) throw new GitError(`git diff --cached failed: ${r.err.trim().split('\n')[0]}`)
  const { added, files, unread } = parsePatch(r.out)
  return { sha: 'staged', author: ident(cwd, 'GIT_AUTHOR_IDENT'), committer: ident(cwd, 'GIT_COMMITTER_IDENT'), message: '', added, files, unread }
}

// `scan` with no range: what a plain `git push` would most likely send.
export function defaultRevs(cwd) {
  if (!git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd }).ok) return null
  if (git(['rev-parse', '--verify', '-q', '@{upstream}'], { cwd }).ok) return ['@{upstream}..HEAD']
  return ['HEAD', '--not', '--remotes']
}
