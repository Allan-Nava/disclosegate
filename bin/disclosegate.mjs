#!/usr/bin/env node
// disclosegate — a pre-push guard against publishing internal detail.
//
//   disclosegate pre-push <remote> <url>     the git hook: ref lines on stdin, as git sends them
//   disclosegate scan [--range A..B | --staged | --history] [--json] [--show]  the same rules, by hand
//   disclosegate install [--force]           write the pre-push hook, never over another tool's
//   disclosegate uninstall                   remove the hook, only if disclosegate wrote it
//   disclosegate init                        write a template user config of placeholders
//   disclosegate doctor                      config, active rules, hook, remote enforcement
//   disclosegate check                       this repository's own invariants (npm test)
//
// Exit codes: 0 clean (or audit mode), 1 findings in block mode, 2 usage or config error.
// Nothing here opens a network connection: it reads git and two files, and prints.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from './lib/check.mjs'
import { ConfigError, inside, loadConfig, remoteVerdict, TEMPLATE, tildify, userConfigPath } from './lib/config.mjs'
import { doctor } from './lib/doctor.mjs'
import { allTags, commitsForSets, defaultRevs, GitError, logCommits, pushRevSets, repoRoot, stagedCommit, tagsAt } from './lib/git.mjs'
import { hooksDir, install, uninstall } from './lib/hook.mjs'
import { formatText, toJSON } from './lib/report.mjs'
import { scanCommits } from './lib/rules.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SCRIPT), '..')
const VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version

class UsageError extends Error {}

const out = (s) => process.stdout.write(`${s}\n`)
const err = (s) => process.stderr.write(`${s}\n`)

function usage() {
  return readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .slice(1, 13)
    .map((l) => l.replace(/^\/\/ ?/, ''))
    .join('\n')
}

function parseFlags(args, known) {
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!known.includes(a)) throw new UsageError(`unknown argument: ${a.startsWith('-') ? a : 'a positional argument'}`)
    if (a === '--range') {
      const v = args[++i]
      if (!v || v.startsWith('-')) throw new UsageError('--range needs a revision range, such as main..HEAD')
      flags.range = v
    } else flags[a.replace(/^--/, '')] = true
  }
  return flags
}

function needRepo(cwd) {
  const root = repoRoot(cwd)
  if (!root) throw new UsageError('not inside a git repository')
  return root
}

function report(commits, cfg, warnings, { json, show, context }) {
  const findings = scanCommits(commits, cfg)
  const reveal = !!show && !!process.stdout.isTTY
  if (show && !reveal) err('disclosegate: --show prints matches only when stdout is a terminal — masked')
  for (const w of warnings) err(`disclosegate: ${w}`)
  const tags = commits.filter((c) => c.tag != null).length
  const opts = { reveal, mode: cfg.mode, context, commits: commits.length - tags, tags, version: VERSION, warnings }
  out(json ? toJSON(findings, opts) : formatText(findings, opts))
  return findings.length && cfg.mode === 'block' ? 1 : 0
}

function prePush(args, cwd) {
  const [remoteName, remoteUrl, ...rest] = args.filter((a) => a !== '--json')
  if (!remoteName || !remoteUrl || rest.length) throw new UsageError('pre-push <remote-name> <remote-url> — git passes both; the ref lines come on stdin')
  if (process.stdin.isTTY) throw new UsageError('pre-push reads the ref lines git writes on stdin — by hand, run `disclosegate scan`')
  const root = needRepo(cwd)
  const { effective, warnings } = loadConfig({ repoRoot: root })
  const v = remoteVerdict(remoteUrl, effective.remotes)
  if (!v.enforce) {
    err(`disclosegate: remote ${remoteName} is not enforced (${v.reason}) — not checked`)
    return 0
  }
  const { sets, tips } = pushRevSets(readFileSync(0, 'utf8'), remoteName, cwd)
  const commits = [...commitsForSets(cwd, sets), ...(tips.length ? tagsAt(cwd, tips) : [])]
  return report(commits, effective, warnings, { json: args.includes('--json'), context: 'pre-push' })
}

function scan(args, cwd) {
  const flags = parseFlags(args, ['--range', '--staged', '--history', '--json', '--show'])
  if ([flags.range, flags.staged, flags.history].filter(Boolean).length > 1) throw new UsageError('pick one of --range, --staged, --history')
  const root = needRepo(cwd)
  const { effective, warnings } = loadConfig({ repoRoot: root })
  let commits
  if (flags.staged) commits = [stagedCommit(cwd)]
  else if (flags.history) commits = [...logCommits(cwd, ['--all']), ...allTags(cwd)]
  else if (flags.range) commits = logCommits(cwd, [flags.range])
  else {
    const revs = defaultRevs(cwd)
    commits = revs ? logCommits(cwd, revs) : []
  }
  return report(commits, effective, warnings, { json: flags.json, show: flags.show, context: 'scan' })
}

function doInstall(args, cwd) {
  const flags = parseFlags(args, ['--force'])
  const root = needRepo(cwd)
  const { dir } = hooksDir(cwd, root)
  const r = install({ dir, force: flags.force, node: process.execPath, script: SCRIPT })
  if (!r.ok) {
    err(`disclosegate: ${tildify(r.file)}: ${r.message}`)
    return 2
  }
  if (r.moved) out(`disclosegate: moved the existing hook to ${tildify(r.moved)} — it runs after disclosegate, when a push passes`)
  out(`disclosegate: ${r.updated ? 'updated' : 'installed'} ${tildify(r.file)}`)
  return 0
}

function doUninstall(args, cwd) {
  parseFlags(args, [])
  const root = needRepo(cwd)
  const { dir } = hooksDir(cwd, root)
  const r = uninstall({ dir })
  if (!r.ok) {
    err(`disclosegate: ${tildify(r.file)}: ${r.message}`)
    return 2
  }
  out(r.removed ? `disclosegate: removed ${tildify(r.file)}${r.restored ? ' and restored the hook it had replaced' : ''}` : 'disclosegate: no pre-push hook to remove')
  return 0
}

function init(args, cwd) {
  parseFlags(args, [])
  const file = userConfigPath()
  if (existsSync(file)) {
    err(`disclosegate: ${tildify(file)} already exists — left alone`)
    return 2
  }
  const root = repoRoot(cwd)
  if (root && inside(file, root)) {
    err(`disclosegate: ${tildify(file)} is inside this repository — the user config must never live in one`)
    return 2
  }
  writeFileSync(file, TEMPLATE, { mode: 0o600 })
  out(`disclosegate: wrote ${tildify(file)} — every value in it is a placeholder; replace them, then run \`disclosegate doctor\``)
  return 0
}

function runDoctor(args, cwd) {
  parseFlags(args, [])
  const root = needRepo(cwd)
  const { lines, problems } = doctor({ cwd, root })
  out(`disclosegate ${VERSION} doctor`)
  for (const l of lines) out(l)
  if (problems.length) {
    out('')
    for (const p of problems) out(`  ! ${p}`)
  }
  return problems.length ? 1 : 0
}

function runCheck(args) {
  parseFlags(args, [])
  const { failures, files } = check(ROOT)
  if (failures.length) {
    for (const f of failures) err(`check: ${f}`)
    err(`check: ${failures.length} failure${failures.length === 1 ? '' : 's'}`)
    return 1
  }
  out(`ok — disclosegate ${VERSION}: manifest, CHANGELOG, README statements, ${files} files clean of home paths and addresses`)
  return 0
}

function main(argv) {
  const [cmd, ...args] = argv
  const cwd = process.cwd()
  switch (cmd) {
    case 'pre-push':
      return prePush(args, cwd)
    case 'scan':
      return scan(args, cwd)
    case 'install':
      return doInstall(args, cwd)
    case 'uninstall':
      return doUninstall(args, cwd)
    case 'init':
      return init(args, cwd)
    case 'doctor':
      return runDoctor(args, cwd)
    case 'check':
      return runCheck(args)
    case '--version':
    case 'version':
      out(VERSION)
      return 0
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(usage())
      return cmd ? 0 : 2
    default:
      throw new UsageError(`unknown command: ${cmd}`)
  }
}

let code
try {
  code = main(process.argv.slice(2))
} catch (e) {
  if (e instanceof UsageError || e instanceof ConfigError || e instanceof GitError) {
    err(`disclosegate: ${e.message}`)
    if (e instanceof UsageError) err('run `disclosegate help` for the commands')
    code = 2
  } else {
    // A bug, not a finding: exit 2 so it is never read as "the push carried something",
    // and the hook still refuses the push — a guard that crashed has checked nothing.
    err(`disclosegate: internal error — ${e.stack}`)
    code = 2
  }
}
process.exitCode = code
