import { FastifyInstance } from 'fastify';
import { redisSubscriber, PubSubChannels } from '@node-forge-engine/redis';

export async function eventsRoutes(server: FastifyInstance) {
  server.get('/events', async (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    // Keep-alive ping every 15 seconds
    const pingInterval = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15_000);

    const handleMessage = (channel: string, message: string) => {
      reply.raw.write(`event: ${channel}\ndata: ${message}\n\n`);
    };

    // Subscribe to both pub/sub channels
    await redisSubscriber.subscribe(
      PubSubChannels.JOB_EVENTS,
      PubSubChannels.WORKFLOW_EVENTS,
    );
    redisSubscriber.on('message', handleMessage);

    request.raw.on('close', () => {
      clearInterval(pingInterval);
      redisSubscriber.off('message', handleMessage);
    });

    // Prevent Fastify from auto-terminating the response
    return reply;
  });
}
