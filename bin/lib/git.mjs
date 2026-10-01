// Reading what is about to leave: commit metadata, messages and added lines, from
// `git log -p` in one pass. Every call pins the settings that would change git's
// output — a pager, a signature check, an external diff, quoted paths, a dropped
// root diff — so a user's global config cannot make a line invisible to the rules.
import { spawnSync } from 'node:child_process'

export class GitError extends Error {}

const PINNED = ['-c', 'core.quotePath=false', '-c', 'log.showSignature=false', '-c', 'log.showRoot=true', '-c', 'core.pager=cat', '-c', 'diff.noprefix=false']
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', '--src-prefix=a/', '--dst-prefix=b/']
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

// The added lines of a unified diff produced with -U0, with their new-side line
// numbers. A hunk is consumed by its own counts, so an added line whose text starts
// with `++ ` is content, never mistaken for a `+++` header.
export function parsePatch(text) {
  const added = []
  const files = []
  const lines = String(text).split('\n')
  let file = null
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (l.startsWith('diff --git ')) {
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
    i++
  }
  return { added, files }
}

export function parseLog(out) {
  const commits = []
  for (const chunk of String(out).split('\x01').slice(1)) {
    const end = chunk.indexOf('\x03')
    const [sha, an, ae, cn, ce, ...body] = chunk.slice(0, end).split('\x02')
    const { added, files } = parsePatch(chunk.slice(end + 1))
    commits.push({ sha, author: { name: an, email: ae }, committer: { name: cn, email: ce }, message: body.join('\x02'), added, files })
  }
  return commits
}

// revs are passed as separate arguments and never start with `-` unless we wrote
// them: a range from the command line is checked before it gets here.
export function logCommits(cwd, revs) {
  const r = git(['log', '-p', ...DIFF, `--format=${FORMAT}`, ...revs, '--'], { cwd })
  if (!r.ok) throw new GitError(`git log failed: ${r.err.trim().split('\n')[0]}`)
  return parseLog(r.out)
}

// The git hook protocol: one `<local-ref> <local-sha> <remote-ref> <remote-sha>` per
// ref. A deletion sends nothing and is skipped. A new branch sends whatever no ref of
// that remote already has. An update sends remote..local — unless the remote tip is
// not in this repository (someone else pushed; this is a force-push over it), where
// the new-branch rule is the only safe reading.
export function pushRevSets(stdin, remoteName, cwd) {
  const sets = []
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
    if (isZero(remote) || !hasCommit(cwd, remote)) sets.push([local, '--not', `--remotes=${remoteName}`])
    else sets.push([`${remote}..${local}`])
  }
  return { sets, deletions }
}

export function commitsForSets(cwd, sets) {
  const seen = new Map()
  for (const revs of sets) for (const c of logCommits(cwd, revs)) if (!seen.has(c.sha)) seen.set(c.sha, c)
  return [...seen.values()]
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
