import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { breakingOutOfPlace, changelogSection } from '../bin/lib/changelog.mjs'

// The release notes open with the tag's CHANGELOG section, and a Breaking entry is
// always the first under its heading — so it is the first thing an upgrader reads.
const LOG = `# Changelog

## [Unreleased]

### Added
- something new.

## [0.2.0] — 2026-09-29

One line of context.

### Changed
- **Breaking for repository config files.** A repository file may no longer set mode.
- Report counts only what was saved.

### Fixed
- A fix.

## [0.1.0] — 2026-09-23

First version.
`

test('changelogSection returns the body of one version, without its heading or the next section', () => {
  const s = changelogSection(LOG, '0.2.0')
  assert.ok(s.startsWith('One line of context.'))
  assert.match(s, /### Changed\n- \*\*Breaking/)
  assert.match(s, /### Fixed\n- A fix\.$/)
  assert.doesNotMatch(s, /0\.1\.0|First version|## \[/)
  assert.equal(changelogSection(LOG, '0.1.0'), 'First version.')
  assert.equal(changelogSection(LOG, '9.9.9'), null)
  assert.equal(changelogSection(LOG, '0.2'), null, 'a prefix of a version is not the version')
})

test('breakingOutOfPlace is empty when every Breaking entry leads its heading', () => {
  assert.deepEqual(breakingOutOfPlace(LOG), [])
})

test('breakingOutOfPlace names a Breaking entry that is not first under its heading', () => {
  const bad = LOG.replace('- **Breaking for repository config files.** A repository file may no longer set mode.\n- Report counts only what was saved.', '- Report counts only what was saved.\n- **Breaking for repository config files.** A repository file may no longer set mode.')
  assert.deepEqual(breakingOutOfPlace(bad), [{ section: '0.2.0', heading: 'Changed' }])
  const unreleased = LOG.replace('### Added\n- something new.', '### Added\n- something new.\n- **Breaking change** here.')
  assert.deepEqual(breakingOutOfPlace(unreleased), [{ section: 'Unreleased', heading: 'Added' }])
})

test('scripts/release-notes.mjs prints the section for a version, and fails for a missing one', () => {
  const script = new URL('../scripts/release-notes.mjs', import.meta.url).pathname
  const ok = spawnSync(process.execPath, [script, '0.0.1'], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /^Not released\./)
  assert.match(ok.stdout, /### Added/)
  const missing = spawnSync(process.execPath, [script, '9.9.9'], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no section for 9\.9\.9/)
})
