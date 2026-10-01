#!/usr/bin/env node
// Print the CHANGELOG section for one version — the top of that release's notes.
//
//   node scripts/release-notes.mjs 0.1.0
//
// Exit 1 when the version has no section, so release.yml stops rather than publishing
// notes without it. Repository tooling: not in the npm tarball (package.json#files).
import { readFileSync } from 'node:fs'
import { changelogSection } from '../bin/lib/changelog.mjs'

const version = process.argv[2]
const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const section = version ? changelogSection(text, version) : null
if (!section) {
  console.error(`release-notes: CHANGELOG.md has no section for ${version ?? '(no version given)'}`)
  process.exit(1)
}
console.log(section)
