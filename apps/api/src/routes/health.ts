import { FastifyInstance } from 'fastify';

export async function healthRoutes(server: FastifyInstance) {
  server.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', service: 'api' });
  });
}
