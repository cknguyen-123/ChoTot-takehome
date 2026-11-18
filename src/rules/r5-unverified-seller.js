// R5 — unverified seller. verified: false goes to needs_human.

/**
 * @param {object} _listing
 * @param {{seller: {id: string, verified: boolean}}} context
 * @returns {object[]}
 */
export function r5UnverifiedSeller(_listing, { seller }) {
  if (seller.verified) return [];
  return [{
    rule_id: 'R5',
    message: `seller ${seller.id} is not verified`,
    detail: { seller_id: seller.id, verified: false },
  }];
}
