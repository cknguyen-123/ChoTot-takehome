// R1 — banned keywords. A title or description containing a term from
// seed/banned_keywords.json is always rejected.
//
// Matching (A12, A20, A21):
// - case-insensitive;
// - whole words only, with Unicode-aware boundaries. JavaScript's \b treats
//   accented letters as non-word characters, so "fake" would match inside
//   "fakế"; we use lookarounds on letters (\p{L}), digits (\p{N}) and combining
//   marks (\p{M}, accents typed as separate characters) instead;
// - any whitespace between the words of a multi-word term ("hang  gia");
// - no accent folding: "hang gia" does not match "hàng giả" (A12).

const WORD_CHAR = String.raw`[\p{L}\p{N}\p{M}]`;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compiles the seed terms once (at startup), so evaluating a listing does no
 * regex construction.
 * @param {readonly string[]} terms
 */
export function compileBannedTerms(terms) {
  return Object.freeze(terms.map((term) => {
    const words = term.trim().split(/\s+/).map(escapeRegExp);
    const pattern = new RegExp(`(?<!${WORD_CHAR})${words.join(String.raw`\s+`)}(?!${WORD_CHAR})`, 'iu');
    return Object.freeze({ term, pattern });
  }));
}

const FIELDS = ['title', 'description'];

/**
 * @param {{title: string, description: string}} listing
 * @param {{bannedTerms: ReturnType<typeof compileBannedTerms>}} context
 * @returns {object[]} one Reason per matched term (A20); empty if none.
 */
export function r1BannedKeywords(listing, { bannedTerms }) {
  const reasons = [];
  for (const { term, pattern } of bannedTerms) {
    const hits = FIELDS
      .map((field) => ({ field, match: pattern.exec(listing[field]) }))
      .filter((h) => h.match);
    if (hits.length === 0) continue;

    const fields = hits.map((h) => h.field);
    const where = fields.length === 1 ? `${fields[0]} contains` : `${fields.join(' and ')} contain`;
    reasons.push({
      rule_id: 'R1',
      // The term exactly as in the seed file; openapi.yaml requires it in message.
      message: `${where} banned term "${term}"`,
      detail: {
        term,
        fields,
        matched: Object.fromEntries(hits.map((h) => [h.field, h.match[0]])),
      },
    });
  }
  return reasons;
}
