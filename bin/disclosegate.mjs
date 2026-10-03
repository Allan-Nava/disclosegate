#!/usr/bin/env node
// disclosegate — a pre-push guard against publishing internal detail.
//
//   disclosegate pre-push <remote> <url> | --pre-commit   the git hook: ref lines on stdin — or pre-commit's PRE_COMMIT_* variables
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
import { allTags, defaultRevs, GitError, pushRevSets, repoRoot, stagedCommit, streamCommits, streamSets, tagsAt } from './lib/git.mjs'
import { hooksDir, install, uninstall } from './lib/hook.mjs'
import { formatText, toJSON } from './lib/report.mjs'
import { scanner, scanCommits, sortFindings } from './lib/rules.mjs'

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

function report(commits, cfg, warnings, opts) {
  const tags = commits.filter((c) => c.tag != null).length
  return reportFindings(scanCommits(commits, cfg), { commits: commits.length - tags, tags }, cfg, warnings, opts)
}

function reportFindings(findings, { commits, tags }, cfg, warnings, { json, show, context }) {
  const reveal = !!show && !!process.stdout.isTTY
  if (show && !reveal) err('disclosegate: --show prints matches only when stdout is a terminal — masked')
  for (const w of warnings) err(`disclosegate: ${w}`)
  const opts = { reveal, mode: cfg.mode, context, commits, tags, version: VERSION, warnings }
  out(json ? toJSON(findings, opts) : formatText(findings, opts))
  return findings.length && cfg.mode === 'block' ? 1 : 0
}

// Under the pre-commit framework, whose pre-push stage has read git's stdin itself and
// passes one ref — the first that sends anything — as PRE_COMMIT_* variables:
// FROM_REF..TO_REF, or only LOCAL_BRANCH when the branch starts at a root commit, where
// everything no ref of the remote has is read, as the git hook reads a new branch.
// Anything missing is a usage error, so the push is refused rather than unchecked.
function preCommitPush(args, cwd) {
  const rest = args.filter((a) => a !== '--json')
  if (rest.length) throw new UsageError('pre-push --pre-commit takes no file names — the hook needs pass_filenames: false, as .pre-commit-hooks.yaml sets it')
  const env = process.env
  const name = env.PRE_COMMIT_REMOTE_NAME
  const url = env.PRE_COMMIT_REMOTE_URL
  if (!name || !url) throw new UsageError('pre-push --pre-commit reads PRE_COMMIT_REMOTE_NAME and PRE_COMMIT_REMOTE_URL, which pre-commit sets in its pre-push stage — run it from there, or install the git hook with `disclosegate install`')
  const from = env.PRE_COMMIT_FROM_REF
  const to = env.PRE_COMMIT_TO_REF
  const local = env.PRE_COMMIT_LOCAL_BRANCH
  const rev = (v) => {
    if (v.startsWith('-')) throw new UsageError('a PRE_COMMIT_* revision cannot begin with "-"')
    return v
  }
  let revs
  let tip
  if (from && to) {
    revs = [`${rev(from)}..${rev(to)}`]
    tip = to
  } else if (local) {
    revs = [rev(local), '--not', `--remotes=${name}`]
    tip = local
  } else throw new UsageError('pre-push --pre-commit needs PRE_COMMIT_FROM_REF and PRE_COMMIT_TO_REF, or PRE_COMMIT_LOCAL_BRANCH — none is set')
  const root = needRepo(cwd)
  const { effective, warnings } = loadConfig({ repoRoot: root })
  const v = remoteVerdict(url, effective.remotes)
  if (!v.enforce) {
    err(`disclosegate: remote ${name} is not enforced (${v.reason}) — not checked`)
    return 0
  }
  return scanReading(streamCommits(cwd, revs), () => tagsAt(cwd, [tip]), effective, warnings, { json: args.includes('--json'), context: 'pre-push' })
}

function prePush(args, cwd) {
  if (args.includes('--pre-commit')) return preCommitPush(args.filter((a) => a !== '--pre-commit'), cwd)
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
  return scanReading(streamSets(cwd, sets), () => (tips.length ? tagsAt(cwd, tips) : []), effective, warnings, { json: args.includes('--json'), context: 'pre-push' })
}

// Every reading is streamed — the hook's, `scan`'s and `scan --history`'s: each commit
// goes through the rules as git writes it and only its findings are kept, so a push or a
// history of any size is read in the memory of its largest commit. The annotated tags
// follow. Same findings, same order, same output as reading it all first.
async function scanReading(commits, tagsOf, cfg, warnings, opts) {
  const scan = scanner(cfg)
  const findings = []
  let ci = 0
  for await (const c of commits) for (const f of scan(c, ci++)) findings.push(f)
  const n = ci
  const tags = tagsOf()
  for (const t of tags) for (const f of scan(t, ci++)) findings.push(f)
  return reportFindings(sortFindings(findings), { commits: n, tags: tags.length }, cfg, warnings, opts)
}

function scan(args, cwd) {
  const flags = parseFlags(args, ['--range', '--staged', '--history', '--json', '--show'])
  if ([flags.range, flags.staged, flags.history].filter(Boolean).length > 1) throw new UsageError('pick one of --range, --staged, --history')
  const root = needRepo(cwd)
  const { effective, warnings } = loadConfig({ repoRoot: root })
  const opts = { json: flags.json, show: flags.show, context: 'scan' }
  if (flags.staged) return report([stagedCommit(cwd)], effective, warnings, opts)
  if (flags.history) return scanReading(streamCommits(cwd, ['--all']), () => allTags(cwd), effective, warnings, opts)
  const revs = flags.range ? [flags.range] : defaultRevs(cwd)
  return scanReading(revs ? streamCommits(cwd, revs) : [], () => [], effective, warnings, opts)
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
  code = await main(process.argv.slice(2))
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
