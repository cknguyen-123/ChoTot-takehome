// Human resolution of listings in needs_human (the second moderation phase).
// The service does not decide anything: it records the moderator's choice and
// guarantees only one choice is committed (AGENTS.md §6.4).

import { AppError } from '../http/errors.js';
import { commitHumanDecision, findListingById } from '../repositories/listings.js';
import { toApiListing } from './listings.js';

const OUTCOME = {
  approve: { outcome: 'approved', status: 'published', verb: 'approved' },
  reject: { outcome: 'rejected', status: 'rejected', verb: 'rejected' },
};

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} [deps.logger]
 */
export function createReviewService({ pool, logger }) {
  return {
    /**
     * @param {string} id listing id from the path
     * @param {{decision: 'approve'|'reject', moderatorId: string, note?: string}} request validated body
     * @returns {Promise<object>} the updated API Listing (200)
     */
    async decide(id, { decision, moderatorId, note }) {
      const { outcome, status, verb } = OUTCOME[decision];
      const reason = {
        rule_id: 'HUMAN',
        message: `${verb} by moderator ${moderatorId}${note ? `: ${note}` : ''}`,
        detail: { moderator_id: moderatorId, ...(note !== undefined && { note }) },
      };

      const updated = await commitHumanDecision(pool, { id, status, outcome, reason, moderatorId });
      if (updated) {
        logger?.info('human decision committed', { listingId: id, moderatorId, outcome });
        return toApiListing(updated);
      }

      // Nothing changed: either there is no such listing, or it is not (or no
      // longer) awaiting review, e.g. another moderator won the race (A25).
      const current = await findListingById(pool, id);
      if (!current) throw new AppError(404, 'not_found', `Listing ${id} not found`);
      throw new AppError(
        409,
        'not_awaiting_review',
        `Listing ${id} is ${current.status}; only listings in needs_human can be decided`,
      );
    },
  };
}
