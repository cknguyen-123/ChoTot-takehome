// R2 — price anomaly. More than 3x, or less than one-third of, the category
// median goes to needs_human. Exact boundaries do not fire; price 0 does (A18).
//
// Integer arithmetic only, via BigInt: price x 3 can exceed
// Number.MAX_SAFE_INTEGER for the largest allowed prices.

const vnd = (n) => `${n.toLocaleString('en-US')} VND`;

/**
 * @param {{price_vnd: number}} listing
 * @param {{category: {id: string, medianPriceVnd: number}}} context
 * @returns {object[]}
 */
export function r2PriceAnomaly(listing, { category }) {
  const price = BigInt(listing.price_vnd);
  const median = BigInt(category.medianPriceVnd);

  let direction = null;
  if (price > median * 3n) direction = 'above';
  else if (price * 3n < median) direction = 'below';
  if (!direction) return [];

  const bound = direction === 'above'
    ? `more than 3 times the ${category.id} median of ${vnd(category.medianPriceVnd)}`
    : `less than one-third of the ${category.id} median of ${vnd(category.medianPriceVnd)}`;

  return [{
    rule_id: 'R2',
    message: `price ${vnd(listing.price_vnd)} is ${bound}`,
    detail: {
      price_vnd: listing.price_vnd,
      category_id: category.id,
      median_price_vnd: category.medianPriceVnd,
      direction,
    },
  }];
}
