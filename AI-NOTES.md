# AI-NOTES.md

How AI tools were used on this take-home. Written as the work happens, not afterwards.


## What was delegated vs. written by hand

- **By hand:** _(author to confirm: e.g. reading the brief, the decisions in
  `ASSUMPTIONS.md`, the phase plan)_
- **Delegated, then reviewed:** the Phase 1 skeleton (Express app factory, config,
  health probes, error handler, Dockerfile, Compose file, Makefile and helper
  scripts) and its tests. A second agent (Claude Code) then reviewed all docs and code
  for inconsistencies before Phase 2.

## Where the model was wrong and how it was caught

- **`make run` did not stop the stack on SIGTERM.** The first `scripts/run.sh` ran
  `docker compose up` in the foreground; `sh` only runs a trap after the foreground
  command ends. Caught by simulating signals with a fake `docker` binary. Fixed by
  running compose in the background and `wait`-ing on it.
- **Review pass (Claude Code):** the agent file was named `AGENTS.MD` while every
  document referred to `AGENTS.md` (case matters on the Linux grader), the AI notes
  file was misnamed and empty, `package-lock.json` had never been generated (the
  Dockerfile silently fell back to `npm install`), `ASSUMPTIONS.md` A1 had "Cost of
  being wrong: None", and A7 contradicted ARCHITECTURE.md on where failed jobs are
  visible. All fixed.

## Decisions I took on the model's recommendations

The agent listed five gaps in the brief with a recommendation each; I decided
(recorded as A8–A12 in ASSUMPTIONS.md):

| # | Question | Model recommended | I decided |
|---|----------|-------------------|-----------|
| A8 | How the submission key is sent | Required `Idempotency-Key` header | Agreed |
| A9 | `draft` in the diagram but not the enum | Client-side state, never stored | Agreed |
| A10 | When `auto_approved` becomes `published` | Same transaction as the approval | Agreed |
| A11 | What triggers `expired` | Out of scope, nothing sets it | Agreed |
| **A12** | **Should `hàng giả` match the banned term `hang gia`?** | **Yes — strip diacritics before matching** | **Disagreed: no folding, match the seed term as written** |

**Where I disagreed (A12).** The model argued that Vietnamese sellers type both
forms, so R1 should fold accents. I kept the literal match: R1 says to match terms
*from the seed file*, and R1 is an always-reject rule with no human in the loop, so
widening it by normalisation risks rejecting innocent listings whose words differ
only by diacritics. Accented forms can be added to the keyword list as data. The
known cost (accented spellings slip through) is written down in A12.

## A path abandoned

- _(fill in when it happens)_
