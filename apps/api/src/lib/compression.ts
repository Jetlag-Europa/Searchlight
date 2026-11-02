import fastifyCompress from "@fastify/compress";
import type { FastifyInstance } from "fastify";

// The API compresses its own responses rather than relying on a proxy: not
// every proxy in front of it does, and game revisions are megabytes of JSON
// that phones download over mobile data. Register it before the routes, since
// the plugin hooks each route as it's declared.
//
// - br and gzip only. Left to itself the plugin also offers deflate and, on
//   newer Node, zstd, which it prefers: Chrome would get zstd and Safari br.
// - Responses under 1 KB aren't worth it.
// - The plugin's default types skip text/event-stream, which has to reach the
//   client event by event, and images such as the og map PNG.
// - Request bodies aren't decompressed: no client sends compressed ones.
export async function registerCompression(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCompress, {
    encodings: ["br", "gzip"],
    threshold: 1024,
    globalDecompression: false,
  });
}
