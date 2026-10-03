// The rules, pure: commits in, findings out. No filesystem, no git, no environment —
// everything here is a function of its arguments, so every rule is unit-tested
// without a repository (test/rules.test.mjs).
//
// A commit is { sha, author: {name, email}, committer: {name, email}, message,
// added: [{ file, line, text }], files: [path, ...] }. An annotated tag has the same
// shape with { tag: <name>, tagger: {name, email} } in place of author and committer,
// and nothing added. A finding is { sha, short, where, rule, kind, match, rank, tag }.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The path rule is built in and always on. A home directory is a path segment
// `/Users/<name>/` or `/home/<name>/` that does not continue a word, a host or a
// dotted name — so `https://example.com/home/about/` is a URL, not a home — and
// its Windows form with either separator escaping. A file URL is one that names
// a path. Placeholders such as `/home/<name>/` match none of them, which is what
// lets the documentation describe the rule.
export const PATH_PATTERNS = [
  { kind: 'home directory', re: /(?<![\w.-])\/(?:Users|home)\/[A-Za-z0-9._-]+\//g },
  { kind: 'home directory', re: /(?<![\w])[A-Za-z]:\\{1,2}Users\\{1,2}[^\\/:*?"<>|\r\n]{1,64}?\\/gi },
  { kind: 'file URL', re: /file:\/\/\/[A-Za-z0-9_~.%-]/gi },
]

// Worst first: an address in the metadata is the identity the forge displays and
// keeps; a private name is next; a home path or a name says less.
export const RANK = { 'email:blocked': 0, 'email:unlisted': 1, term: 2, name: 3, path: 4 }

// The first two characters, an ellipsis and the length: enough to tell two findings
// apart, too little to publish the thing itself in a CI log.
export function mask(s) {
  const chars = [...String(s)]
  return `${chars.slice(0, 2).join('')}… (${chars.length} chars)`
}

// `*` is a wildcard; everything else is literal. `anchored` globs match the whole
// string, case-insensitively.
export function wildcard(pattern) {
  return new RegExp(`^${String(pattern).split('*').map(esc).join('.*')}$`, 'i')
}

// File globs for allowPaths: `**` crosses directories, `*` and `?` do not.
export function globToRegExp(glob) {
  let re = ''
  const g = String(glob).replace(/^\.\//, '')
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]
    if (ch === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += esc(ch)
  }
  return new RegExp(`^${re}$`)
}

export const matchesGlob = (path, globs) => globs.some((g) => globToRegExp(g).test(path))

// A term is a plain string, matched case-insensitively, or `/source/flags`.
// Throws on an invalid regex or one that matches the empty string — a term that
// matches everywhere is a configuration mistake, not a rule.
export function compileTerm(term) {
  const m = String(term).match(/^\/(.+)\/([dgimsuy]*)$/s)
  let re
  if (m) {
    const flags = m[2].includes('g') ? m[2] : `${m[2]}g`
    re = new RegExp(m[1], flags)
  } else {
    if (!String(term).trim()) throw new Error('empty term')
    re = new RegExp(esc(String(term)), 'gi')
  }
  re.lastIndex = 0
  if (re.test('')) throw new Error('matches the empty string')
  re.lastIndex = 0
  return { source: String(term), re }
}

function firstMatch(re, text) {
  re.lastIndex = 0
  const m = re.exec(text)
  re.lastIndex = 0
  return m ? m[0] : null
}

// Every path-rule hit in one line, overlaps dropped: a file URL into a home directory is
// one finding, not two.
export function pathMatches(text) {
  const hits = []
  for (const { kind, re } of PATH_PATTERNS) {
    re.lastIndex = 0
    for (const m of String(text).matchAll(re)) hits.push({ kind, match: m[0], index: m.index, end: m.index + m[0].length })
  }
  hits.sort((a, b) => a.index - b.index || b.end - a.end)
  const out = []
  let end = -1
  for (const h of hits) {
    if (h.index < end) continue
    out.push(h)
    end = h.end
  }
  return out
}

const EMAIL = /[^\s<>"'(),;:@]+@[^\s<>"'(),;:@]+\.[A-Za-z]{2,}/g
const TRAILER = /^\s*([A-Za-z][A-Za-z0-9-]*):\s+(.*)$/

// An address in free text — a message body, an added line — where it is followed by a
// path or a port as often as by a space: the domain stops at the first character a host
// name cannot hold, so `git@git.example.internal/group/repo.git` is at that host.
const TEXT_EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/g
export const textEmails = (text) => [...String(text).matchAll(TEXT_EMAIL)].map((m) => m[0])

// Trailer-shaped lines — `Token: value` — and the addresses in them. Every one counts:
// Co-authored-by and Signed-off-by are the common ones, but a Reviewed-by publishes
// an address just the same.
export function trailers(message) {
  const out = []
  String(message ?? '')
    .split('\n')
    .forEach((line, i) => {
      const m = line.match(TRAILER)
      if (!m) return
      const name = m[2].replace(/<[^>]*>/g, '').trim()
      for (const e of m[2].matchAll(EMAIL)) out.push({ key: m[1], email: e[0], name, line: i + 1 })
    })
  return out
}

const domainOf = (email) => email.toLowerCase().split('@').pop()
export const domainBlocked = (email, domains) => {
  const d = domainOf(email)
  return domains.some((b) => d === b || d.endsWith(`.${b}`))
}
export const emailPublic = (email, publicEmails) => publicEmails.some((p) => wildcard(p).test(email.trim()))

// The repository file, at the root. A term it defines (`fromRepo`) is exempt on its own
// lines, or the commit that adds the file is refused by it; every other rule still
// reads them, and so does a term that also comes from the user file.
export const REPO_FILE = '.disclosegate.json'

// Findings worst first; within a rule, in the order the commits were read.
export const sortFindings = (findings) => findings.sort((a, b) => a.rank - b.rank || a.ci - b.ci)

// cfg: { publicEmails, blockedDomains, terms: [{source, re, fromRepo?}], blockedNames, allowPaths }
export function scanCommits(commits, cfg) {
  const scan = scanner(cfg)
  const out = []
  commits.forEach((c, ci) => {
    for (const f of scan(c, ci)) out.push(f)
  })
  return sortFindings(out)
}

// The rules for one commit at a time — `ci` is its place in the reading — so a caller
// that streams the history holds the findings, never the commits. Unsorted.
export function scanner(cfg) {
  const terms = cfg.terms ?? []
  const publicEmails = cfg.publicEmails ?? []
  const blockedDomains = (cfg.blockedDomains ?? []).map((d) => d.toLowerCase())
  const blockedNames = (cfg.blockedNames ?? []).map((n) => n.trim().toLowerCase())
  const allowPaths = cfg.allowPaths ?? []

  return (c, ci) => {
    const out = []
    const isTag = c.tag != null
    const add = (f) => {
      const key = f.rule === 'email' ? `email:${f.kind === 'blocked domain' ? 'blocked' : 'unlisted'}` : f.rule
      out.push({ sha: c.sha, short: c.sha.slice(0, 7), ci, rank: RANK[key], tag: isTag, ...f })
    }
    const email = (where, address) => {
      if (!address) return
      if (blockedDomains.length && domainBlocked(address, blockedDomains)) add({ where, rule: 'email', kind: 'blocked domain', match: address })
      else if (publicEmails.length && !emailPublic(address, publicEmails)) add({ where, rule: 'email', kind: 'not in publicEmails', match: address })
    }
    const name = (where, n) => {
      if (n && blockedNames.includes(n.trim().toLowerCase())) add({ where, rule: 'name', kind: 'blocked name', match: n })
    }
    const termsIn = (where, text, own = false) => {
      for (const t of terms) {
        if (own && t.fromRepo) continue
        const m = firstMatch(t.re, text)
        if (m) add({ where, rule: 'term', kind: 'term', match: m })
      }
    }
    // In text, only the domain list applies: an address in a line is not an identity the
    // forge displays, and holding every one to publicEmails would refuse a README.
    const domainsIn = (where, text, read = []) => {
      if (!blockedDomains.length) return
      for (const e of textEmails(text)) if (!read.includes(e) && domainBlocked(e, blockedDomains)) add({ where, rule: 'email', kind: 'blocked domain', match: e })
    }
    const pathsIn = (where, text) => {
      for (const h of pathMatches(text)) add({ where, rule: 'path', kind: h.kind, match: h.match })
    }

    for (const [where, id] of [['author', c.author], ['committer', c.committer], ['tagger', c.tagger]]) {
      if (!id) continue
      email(where, id.email)
      name(where, id.name)
    }
    for (const t of trailers(c.message)) {
      email(`trailer ${t.key}`, t.email)
      name(`trailer ${t.key}`, t.name)
    }
    const msg = isTag ? 'tag message' : 'message'
    for (const line of String(c.message ?? '').split('\n')) {
      termsIn(msg, line)
      pathsIn(msg, line)
      // A trailer's addresses were read above; one they missed is read here.
      domainsIn(msg, line, TRAILER.test(line) ? [...line.matchAll(EMAIL)].map((m) => m[0]) : [])
    }
    // A file's name is published with it. One that carries a term is a finding, and
    // it is never printed: every line in it is shown under a masked name instead.
    const secretNames = new Set()
    for (const f of c.files ?? []) {
      if (terms.some((t) => firstMatch(t.re, f))) {
        secretNames.add(f)
        termsIn('file name', f)
      }
    }
    for (const a of c.added ?? []) {
      const where = `${secretNames.has(a.file) ? mask(a.file) : a.file}:${a.line}`
      termsIn(where, a.text, a.file === REPO_FILE)
      domainsIn(where, a.text)
      if (!matchesGlob(a.file, allowPaths)) pathsIn(where, a.text)
    }
    return out
  }
}
