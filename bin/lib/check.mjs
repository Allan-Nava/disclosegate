// `disclosegate check`: this repository's own invariants, run by `npm test` before the
// suites. Statements the README must keep, versions that must agree, and the tool's
// own rules turned on its own tree — a guard against publishing home paths and work
// addresses that published one itself would refute its whole README.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { breakingOutOfPlace, changelogSection } from './changelog.mjs'
import { git } from './git.mjs'
import { mask, pathMatches } from './rules.mjs'
import { ConfigError, loadConfig, REPO_KEYS } from './config.mjs'

// The one file that spells the path shapes out, because it defines and tests them.
export const CHECK_EXEMPT = ['test/rules.test.mjs']

// Load-bearing sentences: the README promises them, and the code is held to them.
export const NEVER_SENDS = 'never sends'
export const ALLOW_PATHS_SENTENCE = '`allowPaths` exempts files from the path rule only — never from the email or term rules.'

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const PLACEHOLDER_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net|internal)|[^.]+\.(?:example|test|invalid|localhost))$|^(?:example|test|invalid|localhost)$/i
export const placeholderEmail = (e) => PLACEHOLDER_DOMAIN.test(e.split('@').pop())

function trackedFiles(root) {
  const r = git(['ls-files', '-z'], { cwd: root })
  if (r.ok && r.out) return r.out.split('\0').filter(Boolean)
  // Not a checkout yet (or an unpacked tarball): walk, skipping what is never tracked.
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const rel = relative(root, p)
      if (['.git', 'node_modules'].includes(name) || rel === join('site', 'dist')) continue
      if (statSync(p).isDirectory()) walk(p)
      else out.push(rel.split('\\').join('/'))
    }
  }
  walk(root)
  return out
}

export function scanTree(root, files, { terms = [] } = {}) {
  const failures = []
  for (const file of files) {
    if (CHECK_EXEMPT.includes(file)) continue
    let buf
    try {
      buf = readFileSync(join(root, file))
    } catch {
      continue
    }
    if (buf.includes(0)) continue
    buf
      .toString('utf8')
      .split('\n')
      .forEach((text, i) => {
        const at = `${file}:${i + 1}`
        for (const h of pathMatches(text)) failures.push(`${at}: ${h.kind} (${mask(h.match)})`)
        for (const m of text.matchAll(EMAIL)) if (!placeholderEmail(m[0])) failures.push(`${at}: an email address that is not a placeholder (${mask(m[0])}) — use example.com, *.example or example.internal`)
        for (const t of terms) {
          t.re.lastIndex = 0
          const m = t.re.exec(text)
          t.re.lastIndex = 0
          if (m) failures.push(`${at}: a term from your user config (${mask(m[0])})`)
        }
      })
  }
  return failures
}

export function check(root, env = process.env) {
  const failures = []
  const fail = (m) => failures.push(m)
  const read = (f) => {
    try {
      return readFileSync(join(root, f), 'utf8')
    } catch {
      fail(`${f}: missing`)
      return ''
    }
  }

  let pkg = {}
  try {
    pkg = JSON.parse(read('package.json'))
  } catch {
    fail('package.json: not valid JSON')
  }
  if (pkg.name !== 'disclosegate') fail('package.json: name must be disclosegate')
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? '')) fail('package.json: version must be x.y.z')
  if (pkg.engines?.node !== '>=18') fail('package.json: engines.node must be ">=18"')
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) fail('package.json: zero runtime dependencies — move it to devDependencies or write it')
  if (pkg.repository?.url !== 'git+https://github.com/Allan-Nava/disclosegate.git') fail('package.json: repository.url must name the GitHub repository')
  if (!(pkg.files ?? []).includes('bin')) fail('package.json: files must ship bin')

  const changelog = read('CHANGELOG.md')
  if (!/^## \[Unreleased\]/m.test(changelog)) fail('CHANGELOG.md: no ## [Unreleased] section')
  if (pkg.version && changelogSection(changelog, pkg.version) === null) fail(`CHANGELOG.md: no section for ${pkg.version}, the version in package.json`)
  for (const b of breakingOutOfPlace(changelog)) fail(`CHANGELOG.md: [${b.section}] ### ${b.heading} — a Breaking entry goes first under its heading`)

  const readme = read('README.md')
  if (!readme.includes(NEVER_SENDS)) fail(`README.md: must state that the tool ${NEVER_SENDS} anything anywhere`)
  if (!readme.includes(ALLOW_PATHS_SENTENCE)) fail(`README.md: must carry the sentence: ${ALLOW_PATHS_SENTENCE}`)

  const release = read('.github/workflows/release.yml')
  if (!release.includes('scripts/release-notes.mjs')) fail('release.yml: the notes must open with the CHANGELOG section (scripts/release-notes.mjs)')
  if (!release.includes("'disclosegate--v*'")) fail("release.yml: must trigger on tags 'disclosegate--v*'")

  try {
    const own = JSON.parse(read('.disclosegate.json'))
    const extra = Object.keys(own).filter((k) => !REPO_KEYS.includes(k))
    if (extra.length) fail(`.disclosegate.json: ${extra.join(', ')} would be ignored — a repository file may only set ${REPO_KEYS.join(', ')}`)
  } catch {
    fail('.disclosegate.json: not valid JSON')
  }

  // The maintainer's own private lists, when there are any, are turned on the tree
  // too — matches masked, like everywhere else.
  let terms = []
  try {
    const { user, effective } = loadConfig({ env })
    if (user.found) terms = [...effective.terms, ...effective.blockedDomains.map((d) => ({ re: new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') }))]
  } catch (e) {
    if (e instanceof ConfigError) fail(`user config: ${e.message}`)
    else throw e
  }
  const files = trackedFiles(root)
  if (!files.length) fail('no files found to scan')
  failures.push(...scanTree(root, files, { terms }))
  return { failures, files: files.length }
}
