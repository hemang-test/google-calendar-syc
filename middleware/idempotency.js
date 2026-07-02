const {
  reserveIdempotencyKey,
  storeIdempotentResponse,
  hashRequestBody,
} = require('../services/idempotency/idempotencyService');

const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Express middleware: deduplicate POST/PUT requests using Idempotency-Key header.
 * Replays stored response for duplicate keys; rejects mismatched request bodies.
 */
function idempotencyMiddleware(options = {}) {
  const methods = options.methods || ['POST', 'PUT'];

  return async (req, res, next) => {
    if (!methods.includes(req.method)) return next();

    const idempotencyKey = req.headers[IDEMPOTENCY_HEADER]
      || req.headers['Idempotency-Key'];

    if (!idempotencyKey) return next();

    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required for idempotent requests' });
    }

    if (idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      return res.status(400).json({ error: 'Idempotency-Key must be 8–255 characters' });
    }

    const requestHash = hashRequestBody(req.body);

    try {
      const result = await reserveIdempotencyKey(req.session.userId, idempotencyKey, {
        method: req.method,
        path: req.originalUrl,
        requestHash,
      });

      if (result.cached) {
        return res.status(result.status).json({
          ...result.body,
          _idempotent: true,
          _replayed: true,
        });
      }

      if (result.inProgress) {
        return res.status(409).json({
          error: 'A request with this Idempotency-Key is already being processed',
          idempotencyKey,
        });
      }

      req.idempotencyKey = idempotencyKey;
      req.idempotencyRequestHash = requestHash;

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        storeIdempotentResponse(req.session.userId, idempotencyKey, {
          method: req.method,
          path: req.originalUrl,
          requestHash,
          status: res.statusCode || 200,
          body,
        }).catch((err) => console.error('Failed to store idempotent response:', err.message));

        return originalJson(body);
      };

      next();
    } catch (err) {
      if (err.code === 'IDEMPOTENCY_MISMATCH') {
        return res.status(422).json({ error: err.message });
      }
      next(err);
    }
  };
}

module.exports = { idempotencyMiddleware, IDEMPOTENCY_HEADER };
