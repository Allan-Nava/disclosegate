// Reading what is about to leave: commit metadata, messages and added lines, from
// `git log -p` in one pass. Every call pins the settings that would change git's
// output — a pager, a signature check, an external diff, quoted paths, a dropped
// root diff — so a user's global config cannot make a line invisible to the rules.
import { spawn, spawnSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export class GitError extends Error {}

const PINNED = ['-c', 'core.quotePath=false', '-c', 'log.showSignature=false', '-c', 'log.showRoot=true', '-c', 'core.pager=cat', '-c', 'diff.noprefix=false']
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', '--src-prefix=a/', '--dst-prefix=b/']
// A merge's own changes: `git log -p` shows none, `--cc` the lines new to every parent.
const MERGES = ['--cc']
// %x01 opens a commit, %x02 separates fields, %x03 ends the header; none of the three
// can be typed into a commit message by any ordinary means.
const FORMAT = '%x01%H%x02%an%x02%ae%x02%cn%x02%ce%x02%B%x03'

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

// The added lines of a diff produced with -U0, with their new-side line numbers. A
// hunk is consumed by its own counts, so an added line whose text starts with `++ ` is
// content, never mistaken for a `+++` header.
//
// A merge comes as a combined diff (`--cc`): `@@@ -a,b -c,d +e,f @@@`, one `@` and one
// range per parent plus the result, and one marker column per parent in front of each
// line. A line with `-` in any column is in a parent and gone from the result; every
// other line is in the result, and is the merge's own only when every column is `+` —
// new to every parent. A line one parent already had was read in that parent's commit,
// or is already public.
export function parsePatch(text) {
  const added = []
  const files = []
  const lines = String(text).split('\n')
  let file = null
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^diff (?:--git|--cc|--combined) /.test(l)) {
      file = null
      i++
      continue
    }
    if (l.startsWith('+++ ')) {
      const p = l.slice(4)
      file = p === '/dev/null' ? null : unquote(p).replace(/^b\//, '')
      if (file) files.push(file)
      i++
      continue
    }
    const h = l.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (h) {
      let del = h[1] === undefined ? 1 : Number(h[1])
      let add = h[3] === undefined ? 1 : Number(h[3])
      let n = Number(h[2])
      i++
      while (i < lines.length && (del > 0 || add > 0 || lines[i].startsWith('\\'))) {
        const x = lines[i]
        if (x.startsWith('\\')) {
          i++
          continue
        }
        if (x.startsWith('+') && add > 0) {
          if (file) added.push({ file, line: n, text: x.slice(1) })
          n++
          add--
        } else if (x.startsWith('-') && del > 0) del--
        else break
        i++
      }
      continue
    }
    const cc = l.match(/^(@{3,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1(?: |$)/)
    if (cc) {
      const parents = cc[1].length - 1
      const old = cc[2].trim().split(' ').map((r) => (r.includes(',') ? Number(r.split(',')[1]) : 1))
      if (old.length !== parents) {
        i++
        continue
      }
      let add = cc[4] === undefined ? 1 : Number(cc[4])
      let n = Number(cc[3])
      const left = () => add > 0 || old.some((c) => c > 0)
      i++
      while (i < lines.length && (left() || lines[i].startsWith('\\'))) {
        const x = lines[i]
        if (x.startsWith('\\')) {
          i++
          continue
        }
        const cols = x.slice(0, parents)
        if (cols.length !== parents || /[^ +-]/.test(cols)) break
        if (cols.includes('-')) {
          for (let p = 0; p < parents; p++) if (cols[p] === '-') old[p]--
        } else {
          if (add <= 0) break
          for (let p = 0; p < parents; p++) if (cols[p] === ' ') old[p]--
          if (file && !cols.includes(' ')) added.push({ file, line: n, text: x.slice(parents) })
          n++
          add--
        }
        i++
      }
      continue
    }
    i++
  }
  return { added, files }
}

// One commit of the log: the text after a %x01, up to the next one.
function parseEntry(chunk) {
  const end = chunk.indexOf('\x03')
  const [sha, an, ae, cn, ce, ...body] = chunk.slice(0, end).split('\x02')
  const { added, files } = parsePatch(chunk.slice(end + 1))
  return { sha, author: { name: an, email: ae }, committer: { name: cn, email: ce }, message: body.join('\x02'), added, files }
}

export function parseLog(out) {
  return String(out).split('\x01').slice(1).map(parseEntry)
}

// The arguments of the one `git log` pass, without the pinned settings `git()` adds.
// revs are passed as separate arguments and never start with `-` unless we wrote
// them: a range from the command line is checked before it gets here.
export const logArgs = (revs) => ['log', '-p', ...MERGES, ...DIFF, `--format=${FORMAT}`, ...revs, '--']

export function logCommits(cwd, revs) {
  const r = git(logArgs(revs), { cwd })
  if (!r.ok) throw new GitError(`git log failed: ${r.err.trim().split('\n')[0]}`)
  return parseLog(r.out)
}

// The log as it arrives: bytes in, whole commits out. A commit is complete when the
// next one's %x01 arrives, so only the commit being read is held — `pending` — never
// the history. The decoder carries a character split across two chunks, so the text
// is what `parseLog` would have seen in one string.
export function splitLog() {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let started = false
  const take = (text) => {
    const parts = (pending + text).split('\x01')
    pending = parts.pop()
    if (!started) {
      if (!parts.length) return []
      parts.shift()
      started = true
    }
    return parts.map(parseEntry)
  }
  return {
    push: (chunk) => take(decoder.write(chunk)),
    end() {
      const out = take(decoder.end())
      if (started) out.push(parseEntry(pending))
      pending = ''
      return out
    },
    get pending() {
      return pending
    },
  }
}

// `logCommits`, streamed: the commits one at a time as git writes them, so a history
// of any size is read in the memory of its largest commit. git's own error is the
// GitError `logCommits` throws, once the log has ended.
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
  try {
    for await (const chunk of child.stdout) yield* split.push(chunk)
    const { error, status } = await exited
    if (error) throw new GitError(`git could not be run: ${error.code ?? error.message}`)
    if (status !== 0) throw new GitError(`git log failed: ${err.trim().split('\n')[0]}`)
    yield* split.end()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
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
    objects.push({ sha, type, body: buf.toString('utf8', nl + 1, end) })
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
      const t = parseTag(o.sha, o.body)
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
