// A sandbox per test: a temporary home, an empty global git config (so the machine's
// own hooksPath, signing or pager settings cannot leak in), a working repository and
// a bare one as its remote. Every value is neutral — example.com, example.internal,
// personal.example — and the home paths the tests need are assembled, not written,
// so `disclosegate check` finds none in this file.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/disclosegate.mjs', import.meta.url))
export const HOME_PATH = ['', 'home', 'user', 'notes.txt'].join('/')
export const ALICE = { name: 'Alice', email: 'alice@personal.example' }
export const BOB = { name: 'Bob', email: 'bob@example.internal' }

export function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'disclosegate-')))
  const home = join(base, 'home')
  const work = join(base, 'work')
  const remote = join(base, 'remote.git')
  mkdirSync(home)
  mkdirSync(work)
  const gitconfig = join(base, 'gitconfig')
  writeFileSync(gitconfig, '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n')
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'C',
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    DISCLOSEGATE_CONFIG: join(home, '.disclosegate.json'),
  }
  const ident = (who, committer = who) => ({
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  })

  const sh = (cmd, args, { cwd = work, input, extraEnv = {} } = {}) => {
    const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env: { ...env, ...ident(ALICE), ...extraEnv } })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` }
  }
  const git = (args, opts) => {
    const r = sh('git', args, opts)
    if (r.code !== 0 && !opts?.allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    return r
  }

  git(['init', '-q', '--bare', remote], { cwd: base })
  git(['init', '-q'])
  git(['remote', 'add', 'origin', remote])

  let n = 0
  const sb = {
    base,
    home,
    work,
    remote,
    env,
    git,
    // One commit: a file with content, a message, an author and a committer.
    commit({ file = `file-${++n}.txt`, content = `line ${n}\n`, message = `change ${n}`, author = ALICE, committer = author } = {}) {
      mkdirSync(dirname(join(work, file)), { recursive: true })
      writeFileSync(join(work, file), content)
      git(['add', file])
      git(['commit', '-q', '-m', message], { extraEnv: ident(author, committer) })
      return git(['rev-parse', 'HEAD']).stdout.trim()
    },
    run(args, opts = {}) {
      return sh(process.execPath, [BIN, ...args], opts)
    },
    push(args = ['origin', 'main']) {
      return git(['push', ...args], { allowFail: true })
    },
    remoteHas(ref) {
      return git(['rev-parse', '--verify', '-q', ref], { cwd: remote, allowFail: true }).code === 0
    },
    userConfig(obj) {
      writeFileSync(env.DISCLOSEGATE_CONFIG, typeof obj === 'string' ? obj : JSON.stringify(obj))
    },
    repoConfig(obj) {
      writeFileSync(join(work, '.disclosegate.json'), JSON.stringify(obj))
    },
  }
  return sb
}
