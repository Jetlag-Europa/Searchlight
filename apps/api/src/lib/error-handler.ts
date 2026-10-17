import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

// Client errors (4xx, including validation) keep Fastify's default response
// and message. Server errors get a generic message: an unexpected error's
// message can carry internals, such as Prisma's query details.
export function errorHandler(
  error: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  // Like Fastify's default handler: the error's status, else one set with
  // reply.code() before throwing, else 500.
  const errorStatus = error?.statusCode ?? (error as { status?: unknown } | undefined)?.status;
  const statusCode =
    typeof errorStatus === "number" && errorStatus >= 400
      ? errorStatus
      : reply.statusCode >= 400
        ? reply.statusCode
        : 500;
  if (statusCode < 500) {
    // Passes the error on to Fastify's default handler, which keeps the
    // status set here.
    return reply.status(statusCode).send(error);
  }
  req.log.error({ err: error }, "Request failed");
  return reply.status(statusCode).send({
    statusCode,
    error: "Internal Server Error",
    message: "Internal Server Error",
  });
}
