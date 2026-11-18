// R3 — duplicate. The same seller already has another active listing that is
// the same as this one (A3: same normalised title/description, category, price;
// A4: active = pending, auto_approved, needs_human, published).
//
// Pure: the caller loads `earlierActiveDuplicates`, i.e. the seller's active
// listings with the same dedup key that were submitted *before* this one
// (created_at, then id). That tie-break means the earlier listing always wins
// and two identical listings never reject each other (A4). Loading that list
// safely under concurrency is the worker's job (ARCHITECTURE.md §5.2).

/**
 * @param {{seller_id: string}} listing
 * @param {{earlierActiveDuplicates: Array<{id: string, status: string}>}} context
 * @returns {object[]}
 */
export function r3Duplicate(listing, { earlierActiveDuplicates }) {
  if (!earlierActiveDuplicates?.length) return [];
  const original = earlierActiveDuplicates[0];
  return [{
    rule_id: 'R3',
    message: `duplicate of listing ${original.id} (${original.status}) from the same seller`,
    detail: {
      duplicate_of: original.id,
      duplicate_status: original.status,
      seller_id: listing.seller_id,
    },
  }];
}
