// The CHANGELOG, read. Two pure functions: the section a release's notes open
// with, and the rule that a Breaking entry is the first one under its heading — so the
// line an upgrader most needs is the first line they read, in the file and in the notes.
// No filesystem here; `check` and `scripts/release-notes.mjs` pass the text in.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The body of `## [version] — date`: everything after its heading line up to the next
// `## [`, trimmed; null when the version has no section. A prefix is not a match
// ("0.2" does not find "0.2.0").
export function changelogSection(text, version) {
  const lines = String(text).split('\n')
  const start = lines.findIndex((l) => new RegExp(`^## \\[${esc(version)}\\](?:\\s|$)`).test(l))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

// Every `### Heading` block, in every `## [...]` section, whose Breaking entry (a bullet
// starting `- **Breaking`) is not its first bullet: [{ section, heading }].
export function breakingOutOfPlace(text) {
  const out = []
  let section = null
  let heading = null
  let bullets = 0
  for (const line of String(text).split('\n')) {
    const s = line.match(/^## \[([^\]]+)\]/)
    if (s) { section = s[1]; heading = null; bullets = 0; continue }
    const h = line.match(/^### (.+?)\s*$/)
    if (h) { heading = h[1]; bullets = 0; continue }
    if (!section || !heading || !line.startsWith('- ')) continue
    bullets++
    if (bullets > 1 && line.startsWith('- **Breaking')) out.push({ section, heading })
  }
  return out
}
