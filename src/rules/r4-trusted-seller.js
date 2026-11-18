// R4 — trusted seller. trust_score >= 80 (80 included) bypasses moderation:
// R2, R3 and R5 are not applied (A2, A6). R1 still is (A1); that precedence is
// in moderation/decide.js, not here.

export const TRUST_THRESHOLD = 80;

/**
 * @param {object} _listing
 * @param {{seller: {id: string, trustScore: number, verified: boolean}}} context
 * @returns {object[]}
 */
export function r4TrustedSeller(_listing, { seller }) {
  if (seller.trustScore < TRUST_THRESHOLD) return [];
  // A6: say that the seller is unverified, so a moderator can see R5 was skipped.
  const unverified = seller.verified
    ? ''
    : '; seller is not verified, but R5 does not apply to trusted sellers';
  return [{
    rule_id: 'R4',
    message:
      `seller ${seller.id} has trust score ${seller.trustScore} (at least ${TRUST_THRESHOLD}): ` +
      `moderation bypassed${unverified}`,
    detail: {
      seller_id: seller.id,
      trust_score: seller.trustScore,
      threshold: TRUST_THRESHOLD,
      verified: seller.verified,
    },
  }];
}
