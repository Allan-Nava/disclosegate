# 03 · Structure — DG-1 Internal detail stopped before the push

**Written against:** `<commit — git rev-parse --short HEAD when this phase ran>`

---

## Reference

Design: [`02-design.md`](./02-design.md)

---

## Steps

### S1 · <title>

- **Goal:** <one line>
- **Touches:** `src/...`, `tests/...`
- **Depends on:** — (none)
- **Who:** agent — or `human` / `live` (a real harness, or real time); such a step is
  verified by a written observation: say where it is recorded and the grep that checks it
- **Verify:** `pytest tests/test_x.py -q` passes
- **Repo state after:** working, feature not yet exposed

### S2 · <title>

- **Goal:**
- **Touches:**
- **Depends on:** S1
- **Who:**
- **Verify:**
- **Repo state after:**

### S3 · <title>

- **Goal:**
- **Touches:**
- **Depends on:** S1
- **Who:**
- **Verify:**
- **Repo state after:**

---

## Dependency graph

```
<the steps above and their edges, e.g.  S1 ──┬── S2
                                              └── S3>
```

**Parallelisable:** <steps that can run on separate worktrees, and why — no shared files>.

---

## Recommended execution order

1. <S1>
2. <S2 ‖ S3 — parallel steps on one line>

---

## Per-step risks

| Step | Risk | Fallback |
|---|---|---|
| | | |

---

## Status

- [ ] Decomposition complete
- [ ] Every step has a verification command
- [ ] Every step leaves the repo working
- [ ] Dependencies and parallelism mapped

> Next phase: **Plan**. It receives: this file + `02-design.md`.
