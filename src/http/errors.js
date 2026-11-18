// Error types and the Express handlers that turn errors into the API's error shape:
//   { "error": { "code": "<machine_code>", "message": "<human message>" } }
// (openapi.yaml, components.schemas.Error)

export class AppError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

export function notFoundHandler(req, res) {
  sendError(res, 404, 'not_found', `No route for ${req.method} ${req.path}`);
}

// Maps errors raised by express.json() (body-parser) to client errors.
function bodyParserError(err) {
  switch (err.type) {
    case 'entity.parse.failed':
      return { status: 400, code: 'invalid_json', message: 'Request body is not valid JSON' };
    case 'entity.too.large':
      return { status: 413, code: 'payload_too_large', message: 'Request body is too large' };
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return { status: 415, code: 'unsupported_encoding', message: 'Unsupported request body encoding' };
    default:
      return null;
  }
}

export function createErrorHandler(logger) {
  // Express recognises error handlers by their four parameters.
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) {
      // Too late to send an error body; Express's default handler closes the connection.
      logger.error('error after response started', { err, method: req.method, path: req.path });
      next(err);
      return;
    }

    if (err instanceof AppError) {
      sendError(res, err.status, err.code, err.message);
      return;
    }

    const parsed = bodyParserError(err);
    if (parsed) {
      sendError(res, parsed.status, parsed.code, parsed.message);
      return;
    }

    // Anything else is a bug or an infrastructure failure. Log the details,
    // return a generic message so internals (stack traces, SQL) never leak.
    logger.error('unhandled error', { err, method: req.method, path: req.path });
    sendError(res, 500, 'internal_error', 'An unexpected error occurred');
  };
}
