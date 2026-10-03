// The pre-push hook: where it goes, what it says, and the rule that disclosegate
// only ever overwrites or removes a hook it wrote itself — recognised by MARKER. A
// foreign hook moved aside with --force is chained, not dropped.
import { chmodSync, constants, copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { git } from './git.mjs'

export const MARKER = '# disclosegate-managed-hook'
export const BACKUP_SUFFIX = '.before-disclosegate'

// core.hooksPath when it is set (relative to the working tree's top, `~` expanded),
// otherwise the common git directory's hooks/ — shared by every worktree.
export function hooksDir(cwd, root) {
  const hp = git(['config', '--get', 'core.hooksPath'], { cwd })
  if (hp.ok && hp.out.trim()) {
    const p = hp.out.trim().replace(/^~(?=$|\/)/, process.env.HOME || homedir())
    return { dir: resolve(root, p), viaHooksPath: true }
  }
  const common = git(['rev-parse', '--git-common-dir'], { cwd })
  return { dir: resolve(cwd, common.out.trim(), 'hooks'), viaHooksPath: false }
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// The hook names the node and the script that installed it, and falls back to a
// `disclosegate` on PATH when that checkout or package has gone. When neither is
// there it refuses the push: a guard that silently stops guarding is worse than one
// that has to be reinstalled.
//
// A hook `install --force` moved aside sits next to this one as
// pre-push${BACKUP_SUFFIX}, and runs after disclosegate passes the push: the same
// arguments, the same stdin byte for byte (held in a variable — ref lines carry no
// NUL), and its exit code is the hook's. A push disclosegate refuses never reaches it.
// Without one, disclosegate is exec'd on git's own stdin, as before.
export function hookScript({ node, script }) {
  return `#!/bin/sh
${MARKER} — written by \`disclosegate install\`; \`disclosegate uninstall\` removes it.
# It reads the commits this push would publish and refuses the push when they carry
# internal detail. Nothing is sent anywhere. Bypass once, knowingly: git push --no-verify
# A hook it moved aside (pre-push${BACKUP_SUFFIX}) runs after it, when the push passes.
DG_NODE=${sq(node)}
DG_SCRIPT=${sq(script)}
DG_NEXT="$0${BACKUP_SUFFIX}"
[ -x "$DG_NODE" ] || DG_NODE=node
if [ -f "$DG_SCRIPT" ]; then
  dg() { "$DG_NODE" "$DG_SCRIPT" pre-push "$@"; }
elif command -v disclosegate >/dev/null 2>&1; then
  dg() { disclosegate pre-push "$@"; }
else
  echo "disclosegate: the hook cannot find disclosegate (installed from $DG_SCRIPT) — push refused. Reinstall it: npm install -g disclosegate && disclosegate install" >&2
  exit 1
fi
if [ ! -f "$DG_NEXT" ]; then dg "$@"; exit $?; fi
DG_IN=$(cat; echo .)
DG_IN=\${DG_IN%.}
printf '%s' "$DG_IN" | dg "$@" || exit $?
if [ ! -x "$DG_NEXT" ]; then
  echo "disclosegate: $DG_NEXT is not executable — skipped, as git skips a hook that is not" >&2
  exit 0
fi
printf '%s' "$DG_IN" | "$DG_NEXT" "$@"
`
}

// One read, no existence check before it: what the state says is what was read (DG-35).
export const hookState = (file) => {
  try {
    return readFileSync(file, 'utf8').includes(MARKER) ? 'ours' : 'foreign'
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'none'
    throw e
  }
}

// `from` moved to `to` unless something is already at `to`. A rename would replace it
// silently, so the new name is made exclusively — a hard link, or for a symbolic link a
// copy of the link, since macOS link() follows one — and fails with EEXIST; only then is
// `from` removed (DG-35). A file system without hard links gets an exclusive copy.
function moveNoClobber(from, to) {
  if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to)
  else {
    try {
      linkSync(from, to)
    } catch (e) {
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(e.code)) throw e
      copyFileSync(from, to, constants.COPYFILE_EXCL)
    }
  }
  unlinkSync(from)
}
const taken = (e) => e.code === 'EEXIST'

export function install({ dir, force, node, script }) {
  const file = join(dir, 'pre-push')
  const state = hookState(file)
  let moved = null
  if (state === 'foreign') {
    if (!force) return { ok: false, file, message: `a pre-push hook that disclosegate did not write is already there — left alone. \`disclosegate install --force\` moves it to pre-push${BACKUP_SUFFIX}, where it runs after disclosegate.` }
    moved = file + BACKUP_SUFFIX
    try {
      moveNoClobber(file, moved)
    } catch (e) {
      if (!taken(e)) throw e
      return { ok: false, file, message: `pre-push${BACKUP_SUFFIX} already exists — move one of the two hooks yourself first` }
    }
  }
  mkdirSync(dir, { recursive: true })
  // Where nothing was read, nothing is overwritten: a hook that appeared since, or a
  // link to a missing file — which a plain write would create through — is refused.
  try {
    writeFileSync(file, hookScript({ node, script }), { flag: state === 'ours' ? 'w' : 'wx' })
  } catch (e) {
    if (!taken(e)) throw e
    return { ok: false, file, moved, message: `something is at pre-push that could not be read as a hook (a link to a missing file?) — left alone${moved ? `; the hook moved aside is at pre-push${BACKUP_SUFFIX}` : ''}` }
  }
  chmodSync(file, 0o755)
  return { ok: true, file, moved, updated: state === 'ours' }
}

export function uninstall({ dir }) {
  const file = join(dir, 'pre-push')
  const state = hookState(file)
  if (state === 'none') return { ok: true, file, removed: false }
  if (state === 'foreign') return { ok: false, file, message: 'the pre-push hook there was not written by disclosegate — left alone' }
  unlinkSync(file)
  const backup = file + BACKUP_SUFFIX
  let restored = false
  try {
    moveNoClobber(backup, file)
    restored = true
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, file, removed: true, restored }
    if (!taken(e)) throw e
    return { ok: false, file, message: `removed, but a new pre-push appeared — pre-push${BACKUP_SUFFIX} was left where it is` }
  }
  return { ok: true, file, removed: true, restored }
}
