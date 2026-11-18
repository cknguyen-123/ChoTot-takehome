// HTTP layer for /v1/listings: parse and validate, call the service, pick the
// status code. No SQL and no business rules here.

import { Router } from 'express';
import { AppError } from '../http/errors.js';
import { validateIdempotencyKey, validateListingRequest, validateListQuery } from '../http/validation.js';

/** @param {{listingService: ReturnType<import('../services/listings.js').createListingService>}} deps */
export function createListingsRouter({ listingService }) {
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

  return router;
}
