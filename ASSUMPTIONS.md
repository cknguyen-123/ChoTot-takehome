# ASSUMPTIONS.md

This document records ambiguities and incomplete requirements identified in the Listing Moderation Service assignment, along with the decisions made for the implementation.

## A1 — Trusted Sellers vs. Banned Keywords

**Ambiguity:**

R1 states:

> A listing whose title or description contains any term from `seed/banned_keywords.json` is always rejected.

R4 states:

> A seller with `trust_score >= 80` bypasses moderation entirely — their listings are published immediately.

The brief does not specify which rule takes priority when both conditions apply.

**Decision:**

R1 takes priority over R4. Listings containing banned keywords are always rejected, regardless of the seller's trust score. Trusted sellers bypass the remaining moderation checks.

**Rationale:**

The wording "always rejected" in R1 suggests that banned content should never be published. Trustworthiness of a seller should not override content restrictions.

**Cost of being wrong:**

If trusted sellers were meant to bypass R1 too, their listings that mention a banned
term (including innocent uses such as "not fake, 100% original") are rejected and must
be resubmitted with different wording. This is a one-line precedence change in the
decision function. The opposite mistake (letting banned content from trusted sellers
through) would be worse, which is why we chose this side.

---

## A2 — Trusted Seller Immediate Publication vs. Asynchronous Processing

**Ambiguity:**

The API specification states:

> POST /v1/listings accepts a listing, returns 202 Accepted with an id and status pending. It does not evaluate the listing inline.

However, R4 states that trusted sellers' listings are published immediately.

The brief does not clarify how immediate publication should interact with asynchronous processing.

**Decision:**

All listing submissions initially receive a pending status and are processed asynchronously.

The background worker checks R1 (banned keywords) first. If R1 is triggered, the listing is rejected regardless of seller trust status.

If R1 is not triggered, the worker checks R4. Trusted sellers are automatically approved and bypass R2, R3, and R5. Other sellers proceed through the remaining moderation rules.

**Rationale:**

This preserves the asynchronous API contract while allowing trusted sellers to bypass unnecessary moderation work.

**Cost of being wrong:**

Trusted sellers may experience a short delay before publication instead of receiving immediate publication during submission.

---

## A3 — Definition of Duplicate Listings

**Ambiguity:**

R3 states:

> If the same seller already has another active listing that is the same as this one, the new listing is rejected as a duplicate.

The brief does not define what makes two listings identical.

**Decision:**

Two listings from the same seller are considered duplicates when their normalized title, description, category, and price match.

Text comparisons will be case-insensitive and ignore leading or trailing whitespace.

**Rationale:**

Using multiple listing attributes reduces the risk of rejecting legitimate listings simply because they share a common title.

**Cost of being wrong:**

Listings that are effectively identical but contain slightly different descriptions or prices may not be identified as duplicates.

---

## A4 — Definition of Active Listings

**Ambiguity:**

R3 refers to another "active listing" but does not explicitly define which lifecycle statuses qualify as active.

**Decision:**

A listing is **active** if its status is `pending`, `auto_approved`, `needs_human` or `published`, meaning it is either visible to buyers or still on its way to becoming visible.

A listing is **not active** if its status is `auto_rejected`, `rejected` or `expired`. A seller may resubmit the same listing after it was rejected or has expired.

When two identical listings from the same seller are both active, the **earlier** one (by `created_at`, then by `id`) is the original. Only the later one is rejected under R3; a listing is never rejected as a duplicate of a listing submitted after it.

**Rationale:**

R3 exists to stop a seller from putting the same item on the marketplace twice. Counting only `published` listings would let identical submissions slip through while the first is still in moderation or human review, which is exactly when sellers tend to resubmit. Counting in-progress listings closes that gap.

The tie-break is needed because two identical listings can be evaluated at the same time. Without it, each could see the other as an active duplicate and both would be rejected. The worker serialises R3 checks per seller (see ARCHITECTURE.md §5.2), and the earlier listing always wins.

**Cost of being wrong:**

If only published listings should count as active, a seller whose first listing is still pending or in human review will see the second one rejected rather than both going through moderation. If the first listing is later rejected, the seller has to resubmit the second.

---


## A5 — Multiple Moderation Rules Triggered

**Ambiguity:**

The brief defines the individual outcomes of R1–R5 but does not fully specify the precedence when multiple rules trigger for the same listing.

**Decision:**

The moderation engine evaluates all applicable rules and records their results.

Decision precedence:

1. R1: Banned keywords → `auto_rejected`.
2. R3: Duplicate listing → `auto_rejected`.
3. R2: Price anomaly → `needs_human`.
4. R5: Unverified seller → `needs_human`.
5. No rejection or escalation rules triggered → `auto_approved`.

R4 is handled as a trusted-seller bypass, subject to A1.

**Rationale:**

Rejection conditions take priority over human-review conditions. This prevents a listing that must be rejected from being escalated unnecessarily.

**Cost of being wrong:**

If the expected behavior is to escalate listings whenever any human-review rule triggers, even when a rejection rule also triggers, this implementation would reject them automatically instead.

---

## A6 — Trusted but Unverified Sellers (R4 vs. R5)

**Ambiguity:**

R4 states:

> A seller with `trust_score >= 80` (`seed/sellers.json`) **bypasses moderation entirely** — their listings are published immediately.

R5 states:

> A listing from a seller with `verified: false` goes to `needs_human`.

Seller `s-1005` ("unverified, high trust", `trust_score` 88, `verified: false`) meets both conditions. R4 says the listing skips moderation and is published; R5 says it must go to a human. Both cannot be true.

**Decision:**

R4 takes priority over R5. A seller with `trust_score >= 80` bypasses R5 (and R2, R3) even when `verified` is `false`, so listings from `s-1005` are approved automatically. R1 still applies to them (A1).

The decision's reasons record that R4 was applied and that the seller is unverified, so a moderator can see that R5 was overridden.

**Rationale:**

R4 is phrased as an absolute: "bypasses moderation entirely". R5 is an ordinary moderation check, and moderation is exactly what R4 bypasses. The seed data names this case on purpose, and a trust score of 88 reflects a track record on the platform, which is stronger evidence than a missing verification step. This is also consistent with A2, where trusted sellers skip R2, R3 and R5.

To decide differently we would need to know whether `verified` is a legal or compliance requirement (e.g. KYC). If it is, verification must win over trust.

**Cost of being wrong:**

If verification is a compliance requirement, listings from trusted but unverified sellers are published without the human review they legally needed. Changing this is a one-line precedence change in the decision function, but listings already published under this rule would need to be found and reviewed retroactively.

---

## A7 — Worker Failure and Retry Behavior

**Ambiguity:**

The brief requires incomplete evaluations to be retried or brought to an operator's attention but does not prescribe a retry strategy.

**Decision:**

Failed moderation jobs will be retried using a bounded retry strategy (backoff between
attempts). After exhausting the retry limit, the job is marked `failed` in the
`moderation_jobs` table with its attempt count and last error, and an error-level log
line is written. An operator finds failed jobs by querying that table (ARCHITECTURE.md
§6); the listing itself stays `pending`. An admin API for this is deferred
(ARCHITECTURE.md §6.1).

**Rationale:**

This prevents transient failures from permanently leaving listings unprocessed while avoiding unlimited retries for persistent failures. A log line alone is easy to miss and disappears with the container, so the failure is also stored durably where it can be queried.

**Cost of being wrong:**

A bounded retry strategy may stop retrying a job that could eventually succeed. Manual intervention or an additional recovery mechanism may then be necessary.

---





## A8 — How the submission key is carried

**Ambiguity:** The brief says "two requests to `POST /v1/listings` with the same key must produce exactly one listing", and `openapi.yaml` describes a 409 when "a submission key from an earlier request was reused with a different request body". Neither says what the key is or how it is sent.

**Decision:** The client sends the key in a **required** `Idempotency-Key` request header (1–200 printable characters). A request without it gets `400`. The key is stored with a hash of the request body: same key and same body → `200` with the original `{id, status}`; same key and different body → `409`. This is an addition to the contract, which the brief allows.

**Rationale:** `Idempotency-Key` is the common convention (Stripe, the IETF draft), so client libraries already know it. Making it required removes the ambiguous case: an optional key would let a retried request without a key create a second listing, which is exactly what the guarantee forbids. Deriving the key from the body was rejected because a seller may legitimately submit the same content twice (R3 decides that, not the transport layer). To decide differently we would need to know whether existing clients can send a header.

**Cost of being wrong:** If the conformance suite sends no header, or uses another name, every submission fails with `400`. Switching to an optional header, or accepting another name too, is a small change in the route; the storage and the unique constraint stay the same.

---

## A9 — The `draft` status

**Ambiguity:** The lifecycle diagram starts with `draft ──► pending`, but the API `Status` enum in `openapi.yaml` has no `draft`, and no endpoint creates or edits drafts.

**Decision:** `draft` is a client-side state (the seller is still writing the listing). The service never stores it. A listing exists in the service from `pending` onwards.

**Rationale:** The enum is normative and cannot be changed, and `POST /v1/listings` is defined to return `pending`. Storing drafts would need new endpoints nobody asked for.

**Cost of being wrong:** If drafts must be saved server-side, we would need a draft endpoint, a new status value (an addition to the enum) and a "submit draft" transition. The existing moderation flow would not change.

---

## A10 — When an approved listing becomes `published`

**Ambiguity:** The lifecycle shows `auto_approved ──► published`, R4 says trusted sellers' listings are "published immediately", and the brief says "publication after approval and expiry are lifecycle changes, not additional moderation phases". It does not say when publication happens.

**Decision:** The worker publishes in the **same transaction** that commits the approval: `status` moves `pending → auto_approved → published` atomically, and the API never shows `auto_approved` as a resting state. `decision.outcome` stays `approved` and `decided_at` is set. Human approval goes straight to `published`.

**Rationale:** There is no scheduled publication or other condition in the brief, so a separate step would only add a delay and a second failure point. Publishing atomically is as close as an asynchronous design gets to R4's "immediately".

**Cost of being wrong:** If publication must be a separate step (e.g. scheduled go-live), approved listings would need to stop at `auto_approved` and a publisher would move them on with a guarded `UPDATE … WHERE status='auto_approved'`. Listings already published would not be affected.

---

## A11 — What makes a listing `expired`

**Ambiguity:** `expired` is in the lifecycle and the enum, but the brief gives no listing lifetime or trigger.

**Decision:** Out of scope. The value is accepted as a status filter, but nothing sets it. Expired listings already count as not active for R3 (A4).

**Rationale:** Without a lifetime there is no correct value to choose, and expiry is a lifecycle change, not a moderation phase, so it does not affect the guarantees being tested. Recorded as a known limitation in README.

**Cost of being wrong:** If expiry is expected, published listings stay published forever. Adding it is a periodic guarded `UPDATE … WHERE status='published' AND published_at < now() - <lifetime>`; no schema change beyond a `published_at` column.

---

## A12 — R1 and Vietnamese diacritics

**Ambiguity:** R1 requires a "case-insensitive, word-boundary match" against `seed/banned_keywords.json`, which contains unaccented Vietnamese terms (`"hang gia"`, `"hang nhai"`). The brief does not say whether the accented spelling (`hàng giả`) should match.

**Decision:** No accent folding. Terms are matched **exactly as written in the seed**, case-insensitively, with Unicode-aware word boundaries. `hang gia` matches "Hang Gia" but **not** "hàng giả".

**Rationale:** The rule says to match terms from the seed file, and the seed file says `hang gia`. Folding accents would change what the term means: Vietnamese words that differ only by diacritics can be unrelated, so folding risks rejecting innocent listings, and R1 is an always-reject rule with no human review. If accented forms should be banned, they can be added to the keyword list as data.

**Cost of being wrong:** Listings that write the banned term with diacritics (the normal way to write Vietnamese) are not caught by R1 and may be published. Fixing it is a normalisation step (NFD + strip combining marks) applied to both terms and text before matching, plus re-checking listings already published.
