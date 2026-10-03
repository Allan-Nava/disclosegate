// Findings, for people and for machines. A match is masked unless the caller asked
// for it with --show *and* stdout is a terminal: this output is printed by a hook,
// captured by CI and pasted into issues, and a guard that republishes what it found
// in a public log has done the leak itself.
import { mask } from './rules.mjs'

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// "3 commits", "1 tag", "2 commits and 1 tag": a tag is counted apart, never as a commit.
const objects = (commits, tags) => [commits || !tags ? plural(commits, 'commit') : null, tags ? plural(tags, 'tag') : null].filter(Boolean).join(' and ')

export function shown(f, reveal) {
  return reveal ? f.match : mask(f.match)
}

export function formatText(findings, { reveal = false, mode = 'block', context = 'scan', commits = 0, tags = 0 } = {}) {
  const affected = new Set(findings.map((f) => f.sha)).size
  if (!findings.length) return `disclosegate: ${objects(commits, tags)} checked — clean`
  const verdict = mode === 'audit' ? ' — audit mode, nothing refused' : context === 'pre-push' ? ' — push refused' : ''
  const out = [`disclosegate: ${plural(findings.length, 'finding')} in ${affected} of ${objects(commits, tags)}${verdict}`, '']
  const rows = findings.map((f) => [f.rule, f.short, f.where, shown(f, reveal), f.kind])
  const width = rows[0].map((_, i) => Math.max(...rows.map((r) => [...r[i]].length)))
  for (const r of rows) out.push(`  ${r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(width[i] - [...c].length))).join('  ')}`)
  out.push('')
  if (context === 'pre-push' && mode !== 'audit') {
    out.push('Nothing has left this machine. Rewrite the commits, then push again:')
    out.push('  an address in author or committer   git rebase -i <base> -x "git commit --amend --no-edit --reset-author"')
    out.push('  a message or a trailer               git rebase -i <base>, then reword')
    out.push('  an added line                        edit the file, then git commit --fixup and git rebase -i --autosquash')
    if (findings.some((f) => f.tag)) out.push('  a tagger or a tag message            git tag -f -a <tag> <tag>^{}, as the right user.email')
    if (findings.some((f) => f.rule === 'unread')) out.push('  a file not read in full              read it yourself; if it is clean, git push --no-verify')
  }
  if (!reveal) out.push('Matches are masked. `disclosegate scan --show` in a terminal prints them in full.')
  return out.join('\n')
}

export function toJSON(findings, { reveal = false, mode = 'block', context = 'scan', commits = 0, tags = 0, version, warnings = [] } = {}) {
  return JSON.stringify(
    {
      tool: 'disclosegate',
      version,
      context,
      mode,
      commits,
      tags,
      refused: mode === 'block' && findings.length > 0,
      findings: findings.map((f) => ({ commit: f.short, sha: f.sha, where: f.where, rule: f.rule, kind: f.kind, match: shown(f, reveal), length: [...f.match].length })),
      warnings,
    },
    null,
    2,
  )
}
