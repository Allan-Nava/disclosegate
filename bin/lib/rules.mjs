// The rules, pure: commits in, findings out. No filesystem, no git, no environment —
// everything here is a function of its arguments, so every rule is unit-tested
// without a repository (test/rules.test.mjs).
//
// A commit is { sha, author: {name, email}, committer: {name, email}, message,
// added: [{ file, line, text }], files: [path, ...], unread: [{ file, why }] } — `unread`
// the files whose added lines were not all read: past the read limit (`limit`), or
// printed by git as binary (`binary`). An annotated tag has the same
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
// keeps; a private name is next; a home path or a name says less. A file not read in
// full is last: nothing was found in it, but nothing can be said of what was not read.
export const RANK = { 'email:blocked': 0, 'email:unlisted': 1, term: 2, name: 3, path: 4, unread: 5 }

// What an `unread` finding says, by why.
export const UNREAD = { limit: 'read in part — past the read limit', binary: 'not read — git printed it as binary' }

// The first two characters, an ellipsis and the length: enough to tell two findings
// apart, too little to publish the thing itself in a CI log.
export function mask(s) {
  const chars = [...String(s)]
  return `${chars.slice(0, 2).join('')}… (${chars.length} chars)`
}

// `*` is a wildcard; everything else is literal. `anchored` globs match the whole
// string, case-insensitively. What it returns has `test`, as the regex
// `^part.*part.*part$` (`*` never crossing a line break) would — but that regex is
// quadratic in the string with two stars and cubic with three, and the string can be
// an address of any length from a message line, so a pattern with two stars or more is
// matched part by part: the first at the start, the last at the end, each between at
// its leftmost place (DG-31).
const BREAK = /[\n\r\u2028\u2029]/
export function wildcard(pattern) {
  const parts = String(pattern).split('*')
  const re = new RegExp(`^${parts.map(esc).join('.*')}$`, 'i')
  if (parts.length < 3 || parts.some((p) => BREAK.test(p))) return { test: (s) => re.test(s) }
  const at = parts.map((p) => new RegExp(esc(p), 'iy'))
  const find = parts.map((p) => new RegExp(esc(p), 'ig'))
  const last = parts.length - 1
  return {
    test(value) {
      const s = String(value)
      if (BREAK.test(s)) return false
      const tail = s.length - parts[last].length
      at[0].lastIndex = 0
      at[last].lastIndex = tail
      if (tail < parts[0].length || !at[0].test(s) || !at[last].test(s)) return false
      let pos = parts[0].length
      for (let i = 1; i < last; i++) {
        find[i].lastIndex = pos
        const m = find[i].exec(s)
        if (!m || m.index + parts[i].length > tail) return false
        pos = m.index + parts[i].length
      }
      return true
    },
  }
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

// Addresses are found from each `@` outwards, never by a regex that starts at every
// character: `[local]+@…` starts a match at each character of a run of local-part
// characters and reads to the run's end looking for the `@`, so a line of n letters cost
// n²/2 steps — 8 s for a commit of three long lines, minutes for a minified bundle
// (DG-31). The scan below finds what `text.matchAll(/[local]+@domain/g)` found — the
// same addresses, in the same order — reading each character a bounded number of times:
// a match holds exactly one `@`; its local part is the run of local characters before
// that `@`, cut where the previous match ended; its domain is read forwards from the
// `@` by `domain(s, i)`, which returns where the match ends or -1.
//
// The character classes are tables indexed by UTF-16 code unit, each filled by the
// class's own regex — over all 65,536 units for the class that takes non-ASCII
// characters, over the 128 ASCII ones for the classes that take none — so a table
// tests exactly what the pattern tested.
const table = (re, size = 128) => {
  const t = new Uint8Array(65536)
  for (let c = 0; c < size; c++) t[c] = re.test(String.fromCharCode(c)) ? 1 : 0
  return t
}
export const CLASS = {
  local: table(/[A-Za-z0-9._%+-]/),
  host: table(/[A-Za-z0-9-]/),
  alpha: table(/[A-Za-z]/),
  loose: table(/[^\s<>"'(),;:@]/, 65536),
}
const DOT = 46

export function addressesIn(text, local, domain) {
  const s = String(text)
  const out = []
  let from = 0
  let a = s.indexOf('@')
  while (a !== -1) {
    let start = a
    while (start > from && local[s.charCodeAt(start - 1)] === 1) start--
    const end = start < a ? domain(s, a + 1) : -1
    if (end === -1) a = s.indexOf('@', a + 1)
    else {
      out.push(s.slice(start, end))
      from = end
      a = s.indexOf('@', end)
    }
  }
  return out
}

// `[^\s<>"'(),;:@]+@[^\s<>"'(),;:@]+\.[A-Za-z]{2,}` — an address in a trailer: the domain
// is its run up to the last dot with two letters after it, and those letters.
function looseDomain(s, i) {
  const { loose, alpha } = CLASS
  let e = i
  while (loose[s.charCodeAt(e)] === 1) e++
  for (let d = e - 1; d > i; d--) {
    if (s.charCodeAt(d) === DOT && alpha[s.charCodeAt(d + 1)] === 1 && alpha[s.charCodeAt(d + 2)] === 1) {
      let f = d + 3
      while (alpha[s.charCodeAt(f)] === 1) f++
      return f
    }
  }
  return -1
}
const looseEmails = (text) => addressesIn(text, CLASS.loose, looseDomain)

const TRAILER = /^\s*([A-Za-z][A-Za-z0-9-]*):(?=(\s+))\2(.*)$/
// The value of a trailer-shaped line, or null. The whitespace after the colon is taken
// whole — `(?=(\s+))\2` is an atomic `\s+` — because `\s+(.*)$` gave it back one
// character at a time when the value held a CR, quadratic in the run (DG-31); giving
// it back never made a match, since the CR is still ahead of `.*`.
const trailerOf = (line) => {
  const m = line.match(TRAILER)
  return m && { key: m[1], value: m[3] }
}

// An address in free text — a message body, an added line — where it is followed by a
// path or a port as often as by a space: the domain stops at the first character a host
// name cannot hold, so `git@git.example.internal/group/repo.git` is at that host.
// `[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])`: the domain is
// its labels as far as each ends in a dot, up to the last label after a dot that is
// letters only, two or more.
function hostDomain(s, i) {
  const { host, alpha } = CLASS
  let best = -1
  let dots = 0
  for (let p = i; ; ) {
    let e = p
    let letters = true
    while (host[s.charCodeAt(e)] === 1) {
      if (alpha[s.charCodeAt(e)] !== 1) letters = false
      e++
    }
    if (e === p) return best
    if (dots > 0 && letters && e - p >= 2) best = e
    if (s.charCodeAt(e) !== DOT) return best
    dots++
    p = e + 1
  }
}
export const textEmails = (text) => addressesIn(text, CLASS.local, hostDomain)

// `<…>` spans out, as `.replace(/<[^>]*>/g, '')` takes them — without reading to the end
// of the line from every `<` that has no `>` after it.
function stripAngles(s) {
  let out = ''
  let i = 0
  for (;;) {
    const lt = s.indexOf('<', i)
    const gt = lt === -1 ? -1 : s.indexOf('>', lt + 1)
    if (gt === -1) return out + s.slice(i)
    out += s.slice(i, lt)
    i = gt + 1
  }
}

// Trailer-shaped lines — `Token: value` — and the addresses in them. Every one counts:
// Co-authored-by and Signed-off-by are the common ones, but a Reviewed-by publishes
// an address just the same.
export function trailers(message) {
  const out = []
  String(message ?? '')
    .split('\n')
    .forEach((line, i) => {
      const t = trailerOf(line)
      if (!t) return
      const name = stripAngles(t.value).trim()
      for (const email of looseEmails(t.value)) out.push({ key: t.key, email, name, line: i + 1 })
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
      domainsIn(msg, line, trailerOf(line) ? looseEmails(line) : [])
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
    // A file whose lines were not all read is a finding of its own: the guard cannot vouch
    // for what it did not see, and saying so is the user's cue to look.
    for (const u of c.unread ?? []) {
      add({ where: secretNames.has(u.file) ? mask(u.file) : u.file, rule: 'unread', kind: UNREAD[u.why] ?? u.why, match: u.file })
    }
    return out
  }
}
