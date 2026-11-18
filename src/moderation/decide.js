// The decision function: combines R1–R5 into one automated result.
// This is the ONLY place rule precedence exists (AGENTS.md §4). Pure: no I/O;
// the caller loads everything into `context`.
//
// Precedence (ASSUMPTIONS A1, A2, A5, A6):
//   1. R1 banned term            → rejected  (even for trusted sellers, A1)
//   2. R4 trusted seller (>= 80) → approved  (R2, R3, R5 not applied, A2/A6)
//   3. R3 duplicate              → rejected
//   4. R2 price and/or R5 unverified → escalated (both reported if both fire)
//   5. nothing fired             → approved with a PASS reason (A16)
// Only the rules that determined the outcome are reported (A15).
// An approval is published in the same commit (A10).

import { r1BannedKeywords } from '../rules/r1-banned-keywords.js';
import { r2PriceAnomaly } from '../rules/r2-price-anomaly.js';
import { r3Duplicate } from '../rules/r3-duplicate.js';
import { r4TrustedSeller } from '../rules/r4-trusted-seller.js';
import { r5UnverifiedSeller } from '../rules/r5-unverified-seller.js';

/** Listing status committed for each outcome. */
export const STATUS_FOR_OUTCOME = Object.freeze({
  approved: 'published', // A10: auto_approved → published in the same transaction
  rejected: 'auto_rejected',
  escalated: 'needs_human',
});

const PASS_REASON = Object.freeze({
  rule_id: 'PASS',
  message: 'No moderation rule matched (checked R1, R2, R3, R5)',
});

const result = (outcome, reasons) => ({ outcome, status: STATUS_FOR_OUTCOME[outcome], reasons });

/**
 * @param {{seller_id: string, title: string, description: string, price_vnd: number}} listing
 * @param {object} context
 * @param {{id: string, trustScore: number, verified: boolean}} context.seller
 * @param {{id: string, medianPriceVnd: number}} context.category
 * @param {ReturnType<import('../rules/r1-banned-keywords.js').compileBannedTerms>} context.bannedTerms
 * @param {Array<{id: string, status: string}>} context.earlierActiveDuplicates
 * @returns {{outcome: 'approved'|'rejected'|'escalated', status: string, reasons: object[]}}
 */
export function decide(listing, context) {
  const banned = r1BannedKeywords(listing, context);
  if (banned.length) return result('rejected', banned);

  const trusted = r4TrustedSeller(listing, context);
  if (trusted.length) return result('approved', trusted);

  const duplicate = r3Duplicate(listing, context);
  if (duplicate.length) return result('rejected', duplicate);

  const review = [...r2PriceAnomaly(listing, context), ...r5UnverifiedSeller(listing, context)];
  if (review.length) return result('escalated', review);

  return result('approved', [PASS_REASON]);
}
