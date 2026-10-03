// Configuration, with a trust order.
//
//   ~/.disclosegate.json   (or DISCLOSEGATE_CONFIG) — the user file. It holds the
//                          private lists, so it must never live in a repository:
//                          one inside the repository being scanned is an error.
//   <repo>/.disclosegate.json — the repository file. Anyone with commit access can
//                          write it, so it may only tighten: add terms and
//                          blockedDomains, and set allowPaths. Every other key is
//                          ignored and reported, never applied.
//
// Both files are JSON with `//` and `/* */` comments. A missing user file is not an
// error: the path rule needs no list and still runs.
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path'
import { compileTerm, REPO_FILE, wildcard } from './rules.mjs'

export class ConfigError extends Error {}

export const USER_KEYS = ['publicEmails', 'blockedDomains', 'terms', 'blockedNames', 'allowPaths', 'mode', 'remotes']
export const REPO_KEYS = ['terms', 'blockedDomains', 'allowPaths']
const LISTS = ['publicEmails', 'blockedDomains', 'terms', 'blockedNames', 'allowPaths']
export { REPO_FILE }

export const userConfigPath = (env = process.env) => (env.DISCLOSEGATE_CONFIG ? resolve(env.DISCLOSEGATE_CONFIG) : join(env.HOME || homedir(), '.disclosegate.json'))

// Paths are shown with the home directory as `~`: this output lands in CI logs too,
// and a home path names its owner.
export function tildify(p, env = process.env) {
  const home = env.HOME || homedir()
  if (!p || !home) return p
  if (p === home) return '~'
  return p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p
}

// Comments out, strings intact — a URL's `//` inside a string is not a comment.
export function stripComments(text) {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      out += ch
      if (ch === '\\') out += text[++i] ?? ''
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else out += ch
  }
  return out
}

// A config file's text, or null when there is none: one read, no existence check before
// it, so the file found is the file read (DG-35).
function readText(file, shown) {
  if (!file) return null
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw new ConfigError(`${shown}: cannot be read (${e.code})`)
  }
}

function parseJsonc(text, shown) {
  let data
  try {
    data = JSON.parse(stripComments(text))
  } catch {
    throw new ConfigError(`${shown}: not valid JSON (comments are allowed, trailing commas are not)`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(`${shown}: must be a JSON object`)
  return data
}

// Errors name the key and the position, never the value: a value is what the file
// exists to keep private.
function validate(data, shown, keys) {
  const errors = []
  for (const k of LISTS) {
    if (!keys.includes(k) || !(k in data)) continue
    if (!Array.isArray(data[k]) || !data[k].every((s) => typeof s === 'string' && s.trim())) errors.push(`${k} must be a list of non-empty strings`)
  }
  if (keys.includes('terms') && Array.isArray(data.terms)) {
    data.terms.forEach((t, i) => {
      if (typeof t !== 'string') return
      try {
        compileTerm(t)
      } catch (e) {
        errors.push(`terms[${i}] is not a usable term (${e.message.replace(/:.*$/s, '')})`)
      }
    })
  }
  if (keys.includes('mode') && 'mode' in data && !['block', 'audit'].includes(data.mode)) errors.push('mode must be "block" or "audit"')
  if (keys.includes('remotes') && 'remotes' in data) {
    const r = data.remotes
    if (!r || typeof r !== 'object' || Array.isArray(r)) errors.push('remotes must be an object { enforce: [...], skip: [...] }')
    else {
      for (const k of Object.keys(r)) if (!['enforce', 'skip'].includes(k)) errors.push(`remotes.${k} is not a key (enforce, skip)`)
      for (const k of ['enforce', 'skip']) if (k in r && !(Array.isArray(r[k]) && r[k].every((s) => typeof s === 'string' && s.trim()))) errors.push(`remotes.${k} must be a list of non-empty strings`)
    }
  }
  if (errors.length) throw new ConfigError(`${shown}: ${errors.join('; ')}`)
}

const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
// The file itself is resolved, not only its directory: a user file that is a symlink
// into a dotfiles repository lives in that repository. A file that does not exist yet
// (`init`) resolves through its directory — and through its link, if it is a dangling
// one, since writing it would follow the link.
const resolveFile = (p, hops = 0) => {
  try {
    return realpathSync(p)
  } catch {}
  try {
    if (hops < 40 && lstatSync(p).isSymbolicLink()) return resolveFile(resolve(real(dirname(p)), readlinkSync(p)), hops + 1)
  } catch {}
  return join(real(dirname(p)), p.split(/[\\/]/).pop())
}
export function inside(file, dir) {
  const rel = relative(real(dir), resolveFile(file))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

const lower = (xs) => xs.map((s) => s.trim().toLowerCase())
const domains = (xs) => lower(xs).map((d) => d.replace(/^\*?\.|^@/, ''))
const uniq = (xs) => [...new Set(xs)]

export function loadConfig({ env = process.env, repoRoot = null } = {}) {
  const userPath = userConfigPath(env)
  const shown = tildify(userPath, env)
  const userText = readText(userPath, shown)
  const user = { path: userPath, shown, found: userText !== null, data: {} }
  if (user.found) {
    if (repoRoot && inside(userPath, repoRoot)) throw new ConfigError(`${user.shown}: the user config holds the private lists and must never live in a repository — move it out of this one`)
    user.data = parseJsonc(userText, user.shown)
    const unknown = Object.keys(user.data).filter((k) => !USER_KEYS.includes(k))
    if (unknown.length) throw new ConfigError(`${user.shown}: unknown key${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (known: ${USER_KEYS.join(', ')})`)
    validate(user.data, user.shown, USER_KEYS)
  }

  const repoPath = repoRoot ? join(repoRoot, REPO_FILE) : null
  const repoText = readText(repoPath, REPO_FILE)
  const repo = { path: repoPath, shown: REPO_FILE, found: repoText !== null, data: {}, ignored: [] }
  if (repo.found) {
    const data = parseJsonc(repoText, repo.shown)
    repo.ignored = Object.keys(data).filter((k) => !REPO_KEYS.includes(k))
    validate(data, repo.shown, REPO_KEYS)
    for (const k of REPO_KEYS) if (k in data) repo.data[k] = data[k]
  }

  const u = user.data
  const r = repo.data
  const termSources = uniq([...(u.terms ?? []), ...(r.terms ?? [])])
  const effective = {
    publicEmails: lower(u.publicEmails ?? []),
    blockedDomains: uniq(domains([...(u.blockedDomains ?? []), ...(r.blockedDomains ?? [])])),
    terms: termSources.map((t) => ({ ...compileTerm(t), fromRepo: !(u.terms ?? []).includes(t) })),
    blockedNames: u.blockedNames ?? [],
    allowPaths: uniq([...(u.allowPaths ?? []), ...(r.allowPaths ?? [])]),
    mode: u.mode ?? 'block',
    remotes: { enforce: u.remotes?.enforce ?? [], skip: u.remotes?.skip ?? [] },
  }
  const warnings = []
  if (repo.ignored.length) warnings.push(`${REPO_FILE} tried to set ${repo.ignored.join(', ')} — ignored: a repository file may only add terms and blockedDomains, and set allowPaths`)
  if (!user.found) warnings.push(`no user config at ${user.shown} — only the path rule${effective.terms.length || effective.blockedDomains.length ? ' and the repository file\'s lists' : ''} run; \`disclosegate init\` writes a template`)
  return { user, repo, effective, warnings }
}

// --- remotes ----------------------------------------------------------------

// `git@host:owner/repo.git`, `https://user@host:443/owner/repo`, `ssh://host/owner/repo`
// all become `host/owner/repo`, so one pattern covers every way of naming a remote.
export function normaliseRemote(url) {
  let u = String(url).trim()
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  if (!u.startsWith('/')) {
    u = u.replace(/^[^@/]+@/, '')
    u = u.replace(/^([^/:]+):\d+(?=\/)/, '$1')
    u = u.replace(/^([^/:]+):(?!\/)/, '$1/')
  }
  return u.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()
}

// skip wins; an empty enforce list means every remote.
export function remoteVerdict(url, remotes = {}) {
  const n = normaliseRemote(url)
  const hit = (list) => (list ?? []).some((p) => wildcard(normaliseRemote(p)).test(n))
  if (hit(remotes.skip)) return { enforce: false, reason: 'remotes.skip' }
  if ((remotes.enforce ?? []).length && !hit(remotes.enforce)) return { enforce: false, reason: 'not in remotes.enforce' }
  return { enforce: true, reason: (remotes.enforce ?? []).length ? 'remotes.enforce' : 'every remote (no remotes.enforce)' }
}

// --- the template `disclosegate init` writes ---------------------------------

export const TEMPLATE = `// disclosegate — your private lists.
//
// This file is yours alone. It stays in your home directory and is never committed to
// any repository: what it lists is exactly what must not be published. Every value
// below is a placeholder ending in .example — replace them, or empty the lists you do
// not need. \`disclosegate doctor\` warns while a placeholder is still here.
{
  // The addresses you publish under. Any other author, committer or trailer address
  // (Co-authored-by, Signed-off-by, ...) is a finding. "*" is a wildcard, so a forge's
  // no-reply form can be one entry. An empty list switches this check off.
  "publicEmails": ["you@personal.example"],

  // Domains that are never public, whatever publicEmails says — an employer's, a
  // client's. Subdomains are included.
  "blockedDomains": ["work.example"],

  // Names that must not appear in a commit message, an added line or a file name:
  // a private host, service, repository or client. A plain string matches
  // case-insensitively; "/source/flags" is a regular expression.
  "terms": ["internal-host.example", "/client-[a-z]+\\\\.example/i"],

  // Author, committer and trailer names that must not appear. Optional.
  "blockedNames": [],

  // Files exempt from the path rule only (globs, "**" crosses directories).
  "allowPaths": [],

  // "block" refuses the push; "audit" prints the findings and lets it through.
  "mode": "block",

  // Which remotes the hook guards, matched against the remote URL with "*" as a
  // wildcard. An empty enforce list means every remote; skip wins over enforce.
  "remotes": { "enforce": [], "skip": [] }
}
`

// The keys that still hold a value `init` wrote.
export function placeholders(data) {
  const template = JSON.parse(stripComments(TEMPLATE))
  return LISTS.filter((k) => Array.isArray(data[k]) && data[k].some((v) => (template[k] ?? []).includes(v)))
}
