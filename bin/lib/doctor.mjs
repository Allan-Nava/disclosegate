// `disclosegate doctor`: is the guard actually guarding? Config found, which rules are
// active, the hook in place, which remotes it enforces. It prints counts, key names
// and remote names — never a list's values, which are the private part.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { COMMIT_LIMIT, git, READ_LIMIT } from './git.mjs'
import { BACKUP_SUFFIX, hookState, hooksDir } from './hook.mjs'
import { loadConfig, placeholders, remoteVerdict, tildify } from './config.mjs'

const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

export function doctor({ cwd, root, env = process.env }) {
  const lines = []
  const problems = []
  const row = (k, v) => lines.push(`  ${k.padEnd(12)} ${v}`)

  // loadConfig throws ConfigError for a broken file; the caller turns that into exit 2.
  const { user, repo, effective: e } = loadConfig({ env, repoRoot: root })

  if (user.found) {
    const u = user.data
    row('user config', `${user.shown} — ${n((u.publicEmails ?? []).length, 'public email')}, ${n((u.blockedDomains ?? []).length, 'blocked domain')}, ${n((u.terms ?? []).length, 'term')}, ${n((u.blockedNames ?? []).length, 'name')}`)
    const ph = [...new Set(placeholders(u))]
    if (ph.length) problems.push(`${user.shown} still holds template placeholders in ${ph.join(', ')} — replace them with your own values`)
  } else {
    row('user config', `${user.shown} — missing`)
    problems.push(`no user config: the email, term and name rules have nothing to check. \`disclosegate init\` writes a template at ${user.shown}`)
  }

  if (repo.found) {
    const r = repo.data
    row('repo config', `${repo.shown} — adds ${n((r.terms ?? []).length, 'term')}, ${n((r.blockedDomains ?? []).length, 'blocked domain')}; ${n((r.allowPaths ?? []).length, 'allowPaths glob')}`)
    if (repo.ignored.length) {
      row('', `ignored: ${repo.ignored.join(', ')}`)
      problems.push(`${repo.shown} tries to set ${repo.ignored.join(', ')} — ignored. A repository file may only tighten (add terms, blockedDomains) and set allowPaths, which exempts files from the path rule only.`)
    }
  } else row('repo config', `${repo.shown} — none (optional)`)

  const rules = [
    `email allowlist ${e.publicEmails.length ? `on (${e.publicEmails.length})` : 'off — no publicEmails'}`,
    `blocked domains ${e.blockedDomains.length ? `on (${e.blockedDomains.length})` : 'off'}`,
    `terms ${e.terms.length ? `on (${e.terms.length})` : 'off'}`,
    'path on (built in)',
    `names ${e.blockedNames.length ? `on (${e.blockedNames.length})` : 'off'}`,
  ]
  row('rules', rules.join(' · '))
  row('mode', e.mode === 'audit' ? 'audit — findings are printed, pushes go through' : 'block — a finding refuses the push')
  row('allowPaths', e.allowPaths.length ? `${e.allowPaths.join(', ')} (path rule only)` : 'none')
  row('reading', `every added line as text — binary files and -diff or binary attributes too — up to ${READ_LIMIT / 1024 / 1024} MiB of a file and ${COMMIT_LIMIT / 1024 / 1024} MiB of a commit; a file past either is an unread finding`)

  const { dir, viaHooksPath } = hooksDir(cwd, root)
  const file = join(dir, 'pre-push')
  const state = hookState(file)
  const where = `${tildify(file, env)}${viaHooksPath ? ' (core.hooksPath)' : ''}`
  if (state === 'ours') row('hook', `${where} — installed${existsSync(file + BACKUP_SUFFIX) ? ` — then pre-push${BACKUP_SUFFIX}, chained` : ''}`)
  else if (state === 'foreign') {
    row('hook', `${where} — another tool's hook`)
    problems.push('the pre-push hook is not disclosegate\'s: pushes are not checked. `disclosegate install --force` moves it aside')
  } else {
    row('hook', `${where} — not installed`)
    problems.push('no pre-push hook: pushes are not checked. `disclosegate install` adds it')
  }

  const remotes = git(['remote'], { cwd }).out.split('\n').filter(Boolean)
  if (!remotes.length) row('remotes', 'none configured')
  for (const name of remotes) {
    const url = git(['remote', 'get-url', '--push', name], { cwd }).out.trim()
    const v = remoteVerdict(url, e.remotes)
    row(name === remotes[0] ? 'remotes' : '', `${name} — ${v.enforce ? 'enforced' : 'not enforced'} (${v.reason})`)
  }

  return { lines, problems }
}
