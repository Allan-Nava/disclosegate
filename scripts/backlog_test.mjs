#!/usr/bin/env node
// The planner is what gets tested: every failure mode of the sync is a wrong
// decision — a duplicate opened on every push, an issue closed for open work.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lint, parse, plan, roadmap } from './backlog.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const model = parse(readFileSync(join(here, 'fixtures', 'backlog.md'), 'utf8'))
assert.deepEqual(lint(model), [], 'fixture lints clean')

const existing = new Map(
  readFileSync(join(here, 'fixtures', 'issues.tsv'), 'utf8').trim().split('\n').map((l) => {
    const [id, num, state, title, milestone] = l.split('\t')
    return [id, { num, state, title, milestone }]
  }),
)
const actions = plan(model, existing)
assert.deepEqual(actions, [
  ['OK', 'DG-1', '11'],
  ['CREATE', 'DG-2', '-'],
  ['REOPEN', 'DG-3', '13'],
  ['CLOSE', 'DG-4', '14'],
  ['SKIP', 'DG-5', '-'],
  ['RETITLE', 'DG-6', '16'],
  ['MILESTONE', 'DG-6', '16'],
  ['OK', 'DG-6', '16'],
])
assert.deepEqual(plan(model, existing, ['v0.0.0']), [], 'milestone filter excludes everything else')
assert.deepEqual(plan(model, existing), actions, 'planning is deterministic')

// Lint catches the things that bit a sibling project: duplicate ids, missing meta, ver
// on an open item.
const bad = parse(`## v1.0.0 — X <!-- ms: phase=now -->\n\n- [ ] **DG-1 — a**: b. <!-- dg: prio=high size=S labels=nope ver=1 -->\n- [ ] **DG-1 — c**: d.\n- [x] **DG-2 — e**: f. <!-- dg: prio=zzz size=S labels=nope -->\n`)
const errs = lint(bad)
for (const needle of ['already used', 'no <!-- dg:', 'carries ver=', 'prio must be', 'unknown label', 'shipped but has no ver='])
  assert.ok(errs.some((e) => e.includes(needle)), `lint reports: ${needle}\n${errs.join('\n')}`)

assert.ok(roadmap(model).includes('| **v9.9.0 — Fixture milestone** | now |'), 'roadmap table row')
console.log('ok — backlog planner: 8 actions as expected, lint catches 6 faults')
