// Automated moderation of one claimed job: load data, decide, commit at most once.
// Precedence lives in moderation/decide.js only; this file does I/O and transactions.

import { withTransaction } from '../db/pool.js';
import { decide } from '../moderation/decide.js';
import { completeJob, failJob, rescheduleJob } from '../repositories/jobs.js';
import {
  commitAutomatedDecision,
  findEarlierActiveDuplicates,
  findListingForModeration,
  lockSellerForDuplicateCheck,
} from '../repositories/listings.js';
import { compileBannedTerms } from '../rules/r1-banned-keywords.js';

/** Retry delay after attempt `attempt` failed: base × 2^(attempt-1), capped. */
export function backoffMs(attempt, { backoffBaseMs, backoffMaxMs }) {
  return Math.min(backoffBaseMs * 2 ** (attempt - 1), backoffMaxMs);
}

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {{sellers: Map, categories: Map, bannedKeywords: readonly string[]}} deps.seed
 * @param {{maxAttempts: number, backoffBaseMs: number, backoffMaxMs: number}} deps.settings
 * @param {object} deps.logger
 */
export function createModerationService({ pool, seed, settings, logger }) {
  const bannedTerms = compileBannedTerms(seed.bannedKeywords);

  /**
   * Evaluates and commits in ONE transaction, holding the seller lock, so the
   * R3 check and the commit cannot interleave with another listing of the
   * same seller.
   * @returns {Promise<{committed: boolean, outcome?: string, status?: string, skipped?: string}>}
   */
  async function evaluateAndCommit(job, log) {
    return withTransaction(pool, async (client) => {
      const listing = await findListingForModeration(client, job.listingId);
      if (!listing) {
        // Cannot happen (FK with cascade), but never loop on it.
        await completeJob(client, job);
        return { committed: false, skipped: 'listing not found' };
      }
      if (listing.status !== 'pending') {
        // Another attempt or a human already committed. Nothing to do.
        await completeJob(client, job);
        return { committed: false, skipped: `listing already ${listing.status}` };
      }

      const seller = seed.sellers.get(listing.seller_id);
      const category = seed.categories.get(listing.category_id);
      // Only possible if the seed changed after submission; retry, then fail visibly.
      if (!seller) throw new Error(`seller ${listing.seller_id} not in seed data`);
      if (!category) throw new Error(`category ${listing.category_id} not in seed data`);

      await lockSellerForDuplicateCheck(client, listing.seller_id);
      const earlierActiveDuplicates = await findEarlierActiveDuplicates(client, listing);

      const result = decide(listing, { seller, category, bannedTerms, earlierActiveDuplicates });
      const decision = { outcome: result.outcome, reasons: result.reasons };

      const committed = await commitAutomatedDecision(client, {
        id: listing.id,
        status: result.status,
        decision,
      });
      await completeJob(client, job);
      if (!committed) {
        log.info('result discarded: listing no longer pending');
        return { committed: false, skipped: 'listing no longer pending' };
      }
      return { committed: true, outcome: result.outcome, status: result.status };
    });
  }

  return {
    /**
     * Processes one claimed job. Never throws for job-level problems: failures
     * are recorded on the job (retry with backoff, or failed after the limit).
     * @param {{listingId: string, attempt: number}} job
     */
    async processJob(job) {
      const log = logger.child({ listingId: job.listingId, attempt: job.attempt });

      // The previous attempt was the last one but never finished (worker crash or
      // lease expiry). Do not evaluate again past the limit.
      if (job.attempt > settings.maxAttempts) {
        const error = `gave up: attempt ${job.attempt - 1} of ${settings.maxAttempts} did not finish (worker crash or lease expiry)`;
        await failJob(pool, { ...job, error });
        log.error('moderation job failed', { error });
        return { committed: false, failed: true };
      }

      try {
        const result = await evaluateAndCommit(job, log);
        if (result.committed) {
          log.info('moderation committed', { outcome: result.outcome, status: result.status });
        } else {
          log.info('moderation skipped', { reason: result.skipped });
        }
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (job.attempt >= settings.maxAttempts) {
          await failJob(pool, { ...job, error });
          // A7: visible in moderation_jobs (state = 'failed', last_error) and here.
          log.error('moderation job failed', { error, maxAttempts: settings.maxAttempts });
          return { committed: false, failed: true };
        }
        const delayMs = backoffMs(job.attempt, settings);
        await rescheduleJob(pool, { ...job, delayMs, error });
        log.warn('moderation attempt failed, will retry', { error, retryInMs: delayMs });
        return { committed: false, retrying: true };
      }
    },
  };
}
