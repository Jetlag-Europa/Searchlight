import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

// Client errors (4xx, including validation) keep Fastify's default response
// and message. Anything else gets a generic message: an unexpected error's
// message can carry internals, such as Prisma's query details.
export function errorHandler(
  error: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 400 && statusCode < 500) {
    // Passes the error on to Fastify's default handler.
    return reply.send(error);
  }
  const serverStatus = statusCode >= 500 ? statusCode : 500;
  req.log.error({ err: error }, "Request failed");
  return reply.status(serverStatus).send({
    statusCode: serverStatus,
    error: "Internal Server Error",
    message: "Internal Server Error",
  });
}
