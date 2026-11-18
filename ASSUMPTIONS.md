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

A seller's trustworthiness should not give them permission to use banned words in their listings. Content restrictions should apply equally to all sellers, regardless of their trust score.

**Cost of being wrong:**

If trusted sellers were supposed to bypass R1, some legitimate listings could be rejected just because they contain a banned word. Sellers would need to change their wording and resubmit but, allowing banned content from trusted sellers could be a bigger problem, so we chose to reject it regardless of trust score.

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

This preserves the asynchronous API contract while allowing trusted sellers to bypass unnecessary moderation work while still statisfying the decision from A!.

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

R3 refers to another "active listing" but does not explicitly define which lifecycle statuses qualify as active, nor which of two identical listings is the "original".

**Decision:**

A listing is **active** if its status is `pending`, `auto_approved`, `needs_human` or `published`, meaning it is either visible to buyers or still on its way to becoming visible.

A listing is **not active** if its status is `auto_rejected`, `rejected` or `expired`. A seller may resubmit the same listing after it was rejected or has expired.

When the same seller has identical active listings, a listing is rejected under R3 if another one is:

- **already decided** (`needs_human`, `published`, `auto_approved`), or
- **still pending and was submitted earlier** (by `created_at`, then by `id`).

In short: the first listing to be decided wins; among listings still pending, the first submitted wins.

**Rationale:**

R3 exists to stop a seller from putting the same item on the marketplace twice. Counting only `published` listings would let identical submissions slip through while the first is still in moderation or human review, which is exactly when sellers tend to resubmit. Counting in-progress listings closes that gap.

A tie-break is needed because two identical listings can be evaluated at the same time; without one, each could see the other as an active duplicate and both would be rejected. "Earlier `created_at`" alone is not enough: `created_at` is set when a submission's transaction *starts*, but the listing only becomes visible when it *commits*, so an older listing can appear after a newer one was already published. Letting already-decided listings win first closes that gap. The worker runs R3 checks and commits for one seller at a time under a per-seller lock (ARCHITECTURE.md §5.2), so the "already decided" set is always up to date. Two identical listings can therefore never both be published, and never both be rejected by R3.

**Cost of being wrong:**

If only published listings should count as active, a seller whose first listing is still pending or in human review will see the second one rejected rather than both going through moderation. If the first listing is later rejected, the seller has to resubmit the second. In the rare race described above, the listing with the earlier `created_at` is the one rejected ("first decided wins" rather than "first submitted wins").
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

Rejection conditions take priority over human-review conditions. This prevents a listing that must be rejected from being later proccessed unnecessarily.

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

R4 is phrased as an absolute: "bypasses moderation entirely". R5 is an ordinary moderation check, and moderation is exactly what R4 bypasses. The seed data names this case on purpose, and a trust score of 88 reflects a track record on the platform, which is stronger evidence than a missing verification step.

**Cost of being wrong:**

If verification is a compliance requirement, listings from trusted but unverified sellers are published without the human review they legally needed. Changing this is a one-line precedence change in the decision function, but listings already published under this rule would need to be found and reviewed retroactively.

---

## A7 — Worker Failure and Retry Behavior

**Ambiguity:**

The brief requires incomplete evaluations to be retried or brought to an operator's attention but does not prescribe a retry strategy.

**Decision:**

When the worker can’t finish checking a listing, it tries again, a few times, waiting a bit longer each time. If it still fails after 5 tries, it stops, marks the job as “failed” and writes down why, so a person can find it and fix it.

Like this:

Try. It breaks (for example, the database hiccups).
Wait 2 seconds, try again. Most problems are gone by now, so this usually works.
Still broken? Wait longer each time: 4 s, then 8 s, then 16 s.
After 5 tries, give up, and:
mark the job failed in the database
save the error message, so someone knows what went wrong
leave the listing as pending, because it was never decided

A person can then see the failed jobs with one query, fix the problem, and send the job back to the worker.

**Rationale:**

This prevents transient failures from permanently leaving listings unprocessed while avoiding unlimited retries for persistent failures. A log line alone is easy to miss and disappears with the container, so the failure is also stored durably where it can be queried.

**Cost of being wrong:**

A bounded retry strategy may stop retrying a job that could eventually succeed. Manual intervention or an additional recovery mechanism may then be necessary.

---

## A8 — How the submission key is carried

**Ambiguity:**

The brief says "two requests to `POST /v1/listings` with the same key must produce exactly one listing", and `openapi.yaml` describes a 409 when "a submission key from an earlier request was reused with a different request body". Neither says what the key is or how it is sent.

**Decision:**

The client sends the key in a **required** `Idempotency-Key` request header (1–200 printable characters). A request without it gets `400`. The key is stored with a hash of the request body: same key and same body → `200` with the original `{id, status}`; same key and different body → `409`. This is an addition to the contract, which the brief allows.

**Rationale:**

`Idempotency-Key` is the common convention, so client libraries already know it. Making it required removes the ambiguous case: an optional key would let a retried request without a key create a second listing, which is exactly what the guarantee forbids. Deriving the key from the body was rejected because a seller may legitimately submit the same content twice (R3 decides that, not the transport layer). To decide differently we would need to know whether existing clients can send a header.

**Cost of being wrong:**

If the conformance suite sends no header, or uses another name, every submission fails with `400`. Switching to an optional header, or accepting another name too, is a small change in the route; the storage and the unique constraint stay the same.

---

## A9 — The `draft` status

**Ambiguity:**

The lifecycle diagram starts with `draft ──► pending`, but the API `Status` enum in `openapi.yaml` has no `draft`, and no endpoint creates or edits drafts.

**Decision:**

`draft` is a client-side state (the seller is still writing the listing). The service never stores it. A listing exists in the service from `pending` onwards.

**Rationale:**

The enum is normative and cannot be changed, and `POST /v1/listings` is defined to return `pending`. Storing drafts would need new endpoints nobody asked for.

**Cost of being wrong:**

If drafts must be saved server-side, we would need a draft endpoint, a new status value (an addition to the enum) and a "submit draft" transition. The existing moderation flow would not change.

---

## A10 — When an approved listing becomes `published`

**Ambiguity:**

The lifecycle shows `auto_approved ──► published`, R4 says trusted sellers' listings are "published immediately", and the brief says "publication after approval and expiry are lifecycle changes, not additional moderation phases". It does not say when publication happens.

**Decision:**

The worker publishes in the **same transaction** that commits the approval: `status` moves `pending → auto_approved → published` atomically, and the API never shows `auto_approved` as a resting state. `decision.outcome` stays `approved` and `decided_at` is set. Human approval goes straight to `published`.

**Rationale:**

There is no scheduled publication or other condition in the brief, so a separate step would only add a delay and a second failure point. Publishing atomically is as close as an asynchronous design gets to R4's "immediately".

**Cost of being wrong:**

If publication must be a separate step (e.g. scheduled go-live), approved listings would need to stop at `auto_approved` and a publisher would move them on with a guarded `UPDATE … WHERE status='auto_approved'`. Listings already published would not be affected.

---

## A11 — What makes a listing `expired`

**Ambiguity:**

`expired` is in the lifecycle and the enum, but the brief gives no listing lifetime or trigger.

**Decision:**

Out of scope. The value is accepted as a status filter, but nothing sets it. Expired listings already count as not active for R3 (A4).

**Rationale:**

Without a lifetime there is no correct value to choose, and expiry is a lifecycle change, not a moderation phase, so it does not affect the guarantees being tested. Recorded as a known limitation in README.

**Cost of being wrong:**

If expiry is expected, published listings stay published forever. Adding it is a periodic guarded `UPDATE … WHERE status='published' AND published_at < now() - <lifetime>`; no schema change beyond a `published_at` column.

---

## A12 — R1 and Vietnamese diacritics

**Ambiguity:**

R1 requires a "case-insensitive, word-boundary match" against `seed/banned_keywords.json`, which contains unaccented Vietnamese terms (`"hang gia"`, `"hang nhai"`). The brief does not say whether the accented spelling (`hàng giả`) should match.

**Decision:**

No accent folding. Terms are matched **exactly as written in the seed**, case-insensitively, with Unicode-aware word boundaries. `hang gia` matches "Hang Gia" but **not** "hàng giả".

**Rationale:**

The service follows the seed data strictly: `seed/banned_keywords.json` is the source of truth for what is banned, and the program matches exactly the terms it lists, without adding variants of its own. R1 says to match terms *from the seed file*, and the seed file says `hang gia`, so that is the term that is matched.

Folding accents would mean the program deciding on its own that other spellings are banned too. That changes what a term means: Vietnamese words that differ only by diacritics can be unrelated, so folding risks rejecting innocent listings, and R1 is an always-reject rule with no human review. If accented forms should be banned, the fix belongs in the data: add them to the keyword list, and the program picks them up without a code change.

**Cost of being wrong:**

Listings that write the banned term with diacritics (the normal way to write Vietnamese) are not caught by R1 and may be published. Fixing it is a normalisation step (NFD + strip combining marks) applied to both terms and text before matching, plus re-checking listings already published.

---

## A13 — Fields the spec does not define

**Ambiguity:**

`ListingRequest` in `openapi.yaml` lists five properties but does not say `additionalProperties: false`, and the brief says the contract is "extensible where it does not [speak]". What should `POST /v1/listings` do with a body like `{…, "color": "red"}`?

**Decision:**

Reject it with `400 invalid_request`, naming the unknown field(s). Only `seller_id`, `title`, `description`, `price_vnd` and `category_id` are accepted. (Query parameters on `GET /v1/listings` that the spec does not define are ignored; this decision is about the request body.)

**Rationale:**

A field we silently drop is a field the client thinks we stored. A typo such as `price` instead of `price_vnd` is caught immediately instead of producing a confusing "price_vnd is required", and nothing we do not understand ever reaches moderation. When the contract grows, the new field is added to the accepted list deliberately. To decide differently we would need to know that clients send extra fields we must tolerate.

**Cost of being wrong:**

If the conformance suite or real clients send extra fields, every such submission fails with `400` and nothing is stored. Switching to "ignore unknown fields" is a one-line change in the validator; the request hash already covers only the five known fields, so retries would behave the same.

---

## A14 — Whitespace in titles and descriptions

**Ambiguity:**

 `title` has `minLength: 1`. A title of `"   "` satisfies that literally but is empty to a reader. The brief does not say whether text is trimmed.

**Decision:**

Text is validated and stored exactly as sent; no trimming. `"   "` is a valid title. (R3's duplicate comparison still ignores leading/trailing whitespace and case, per A3; that normalisation is only used for comparison, never stored.)

**Rationale:**

The spec is the contract and says "at least one character". Adding rules it does not state risks rejecting requests the conformance suite considers valid. What a seller typed is what a moderator sees.

**Cost of being wrong:**

Listings with blank-looking titles can be stored and reach moderation or publication. Rejecting them is a small validator change, but listings already stored would need cleaning up.

---

## A15 — Which reasons a decision reports

**Ambiguity:**

The brief says `GET /v1/listings/{id}` "must report which rules fired and why", and A5 says the engine "records their results". When several rules fire (e.g. a banned term *and* an unusual price), it is not said whether rules that did not determine the outcome are reported.

**Decision:**

A decision reports only the rules that **determined its outcome**. Where several rules lead to the same outcome they are all reported: every matched banned term for an R1 rejection, and both R2 and R5 when both escalate. Rules overridden by a higher-precedence rule are not listed (e.g. a listing rejected by R1 does not also report its R2 price anomaly).

**Rationale:**

`reasons` answers "why did this listing end up here?", and a short list with only the deciding reasons answers it without the moderator having to work out which reasons mattered. Both escalation reasons are kept because a human reviewer needs to check both. (This refines A5, which said all applicable rules are evaluated: they are, but only the deciding ones are reported.)

**Cost of being wrong:**

If moderators need the full picture (e.g. to spot a seller who triggers R2 repeatedly but is always rejected by R1 first), that information is not stored. Reporting overridden rules too is a change in the decision function only; decisions already stored would stay without them.

---

## A16 — Reasons for an approval where no rule fired

**Ambiguity:**

`Decision.reasons` is required, and AGENTS.md says approvals carry reasons too, but when no rule fires there is no rule to cite. `openapi.yaml` allows "a rule id you introduce".

**Decision:**

An approval with no rule fired carries one reason: `{"rule_id": "PASS", "message": "No moderation rule matched (checked R1, R2, R3, R5)"}`. An R4 approval carries the R4 reason instead.

**Rationale:**

An empty list looks like missing data. An explicit reason tells the moderator that the listing was checked and what it was checked against.

**Cost of being wrong:**

 A client that expects every `rule_id` to be R1–R5 sees an unfamiliar value. Returning `[]` instead is a one-line change.

---

## A17 — Spacing inside multi-word banned terms

**Ambiguity:**

R1 requires a "word-boundary match" and the seed has multi-word terms (`"hang gia"`, `"hang nhai"`). It does not say whether `hang  gia` (two spaces) or `hang` and `gia` on separate lines match.

**Decision:**

Any run of whitespace between the words of a term matches: `hang gia`, `hang  gia`, `hang\ngia`. Words must still be complete words (Unicode-aware boundaries: a letter, digit or combining accent mark next to the term means it is part of a longer word). Accented spellings do not match (A12).

**Rationale:**

Otherwise a seller could avoid R1 just by typing two spaces. Allowing extra whitespace does not change what the term means, unlike accent folding.

**Cost of being wrong:**

A listing where the words of a term are separated by a line break, for an innocent reason, is rejected. Requiring a single space is a one-line change in the R1 pattern.

---

## A18 — Price 0 and R2

**Ambiguity:**

 R2 sends a listing to `needs_human` when the price is "less than one-third of the median price for its category". `price_vnd` may be `0` (`minimum: 0` in the spec), and 0 is less than a third of any median. The brief does not say whether free listings are exempt.

**Decision:**

No exemption. A price of 0 goes to `needs_human` under R2, like any other price below one-third of the median. Boundaries are exact: a price of exactly three times, or exactly one-third of, the median does **not** fire R2. The comparison uses integers only (`price × 3 < median`, `price > median × 3`).

**Rationale:**

It is what the rule says, and "free" is a common bait pattern, so human review of free items is defensible. Exempting 0 would be an exception the brief never mentions.

**Cost of being wrong:**

Every free / give-away listing from a seller without R4 trust waits for a moderator, adding review load. Exempting 0 is a one-line change in R2.
