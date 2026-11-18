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

- **A test that could not fail (Phase 4).** To prove R1 uses Unicode-aware word
  boundaries, the model wrote a test expecting `'fakế'` not to match "fake". It passed,
  but for the wrong reason: `'fakế'` does not contain "fake" at all, so the naive `\b`
  version AGENTS.md warns about would pass it too. Caught by running the naive pattern
  against the test inputs before trusting the green result. Fixed to `'fakeế'`, which
  the naive pattern does match. Rule added to AGENTS.md: check that the *wrong*
  implementation fails a boundary test.

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

**Where I disagreed (unknown fields, Phase 3, A13).** The model recommended
*ignoring* request fields the spec does not define, so older or newer clients keep
working. I chose to **reject them with 400**: a silently dropped field is one the
client believes was stored, and a typo like `price` for `price_vnd` should fail loudly.
I accepted its other four Phase 3 recommendations (strict types, no trimming, error
order 400 → 422 → 409/200, replay returns the current status; A14–A17).

**Where I disagreed (which reasons to report, Phase 4, A18).** The model recommended
listing *every* rule that fired, marking the overridden ones. I chose to report **only
the rules that decided the outcome**: `reasons` should answer "why is it here?"
without the moderator having to work out which reasons mattered. Accepted its other
four Phase 4 recommendations (A19–A22: an explicit `PASS` reason, one R1 reason per
term, any whitespace inside multi-word terms, price 0 escalates under R2).

**Where I disagreed (migration tool, Phase 2).** The model recommended a ~80-line
hand-written migration runner (no dependency, every line explainable in review) over
`node-pg-migrate`. It even wrote the runner. After reading it and asking what
migrations are for and how the library differs, I chose **node-pg-migrate**: this
service is meant to go to production and live for years, not be a short-lived
exercise. A maintained tool gives down-migrations for rollbacks, ordering checks and
edge cases (e.g. `CREATE INDEX CONCURRENTLY`) that a home-grown runner would have to
grow into. The model's runner was deleted; the schema SQL was kept and converted to
the library's up/down format.

## A path abandoned

- **Hand-written migration runner** (Phase 2): built, reviewed, then replaced by
  node-pg-migrate within the same session (see above). What made me stop: thinking
  about the service's lifetime rather than the exercise's.
