
# CONTEXT.md

## 1. Project Background

This is a backend engineering take-home assignment
for a marketplace listing moderation system.

The goal is to evaluate submitted listings and determine
whether they should be automatically approved, rejected,
or sent for human review.

## 2. Business Objective

Build a reliable moderation system that:
- Prevents prohibited listings from being published.
- Minimizes unnecessary rejection of legitimate listings.
- Supports human moderation when automated decisions
  are insufficient.
- Maintains listing status and moderation history.

## 3. Core Business Concepts

### Listing
A product or service submitted by a seller.

### Moderation
The process of evaluating a listing against moderation rules.

### Moderation Outcomes
- Approved
- Rejected
- Pending human review

### Active Listing
A listing considered active according to the agreed
business definition in ASSUMPTIONS.md.

## 4. Important Business Rules

Refer to ASSUMPTIONS.md for the complete list of
agreed assumptions and unresolved questions.

Refer to the requirements documentation for the
authoritative moderation rules.

## 5. Technology Stack

- Node.js
- Express.js
- PostgreSQL
- Docker

## 6. Current Implementation Status

Update this section as development progresses.

- [ ] Project initialization
- [ ] Database schema
- [ ] Listing submission API
- [ ] Moderation engine
- [ ] Background worker
- [ ] Human review API
- [ ] Automated tests

## 7. Important Technical Decisions

Document significant decisions here or reference
ARCHITECTURE.md for their detailed explanations.

## 8. Known Limitations

Document features that are intentionally excluded
or not yet implemented.
