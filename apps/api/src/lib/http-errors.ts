// Errors for route handlers to throw: the error handler (error-handler.ts)
// answers with their status and message.

export function notFound(msg = "Not found") {
  return Object.assign(new Error(msg), { statusCode: 404 });
}

export function forbidden(msg = "Forbidden") {
  return Object.assign(new Error(msg), { statusCode: 403 });
}
