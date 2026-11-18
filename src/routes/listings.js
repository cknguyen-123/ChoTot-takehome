// HTTP layer for /v1/listings: parse and validate, call the service, pick the
// status code. No SQL and no business rules here.

import { Router } from 'express';
import { AppError } from '../http/errors.js';
import {
  validateDecisionRequest,
  validateIdempotencyKey,
  validateListingRequest,
  validateListQuery,
} from '../http/validation.js';

/**
 * @param {object} deps
 * @param {ReturnType<import('../services/listings.js').createListingService>} deps.listingService
 * @param {ReturnType<import('../services/review.js').createReviewService>} [deps.reviewService]
 */
export function createListingsRouter({ listingService, reviewService }) {
  const router = Router();

  router.post('/v1/listings', async (req, res) => {
    // A16: all 400 checks first (key, then body).
    const key = validateIdempotencyKey(req.get('Idempotency-Key'));
    const listing = validateListingRequest(req.body);
    const { httpStatus, body } = await listingService.submit(key, listing);
    res.status(httpStatus).json(body);
  });

  router.get('/v1/listings', async (req, res) => {
    const items = await listingService.list(validateListQuery(req.query));
    res.json({ items });
  });

  router.get('/v1/listings/:id', async (req, res) => {
    const listing = await listingService.get(req.params.id);
    if (!listing) throw new AppError(404, 'not_found', `Listing ${req.params.id} not found`);
    res.json(listing);
  });

  if (reviewService) {
    // Human resolution: 200 for the single winning request, 409 otherwise (A25).
    router.post('/v1/listings/:id/decision', async (req, res) => {
      const request = validateDecisionRequest(req.body);
      res.json(await reviewService.decide(req.params.id, request));
    });
  }

  return router;
}
