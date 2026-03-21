import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { prisma } from '@orchestra-engine/prisma';
import { redis, RedisKeys, RedisTTL } from '@orchestra-engine/redis';

const EXEMPT_PATHS = ['/health'];

export async function authHook(request: FastifyRequest, reply: FastifyReply) {
  if (EXEMPT_PATHS.includes(request.url)) return;

  // Support query param key for SSE (EventSource doesn't support custom headers)
  const queryKey = (request.query as Record<string, string>)?.key;
  const authHeader = request.headers.authorization;

  let rawKey: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    rawKey = authHeader.slice(7);
  } else if (queryKey) {
    rawKey = queryKey;
  }

  if (!rawKey) {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
  if (!apiKey) {
    return reply.code(401).send({ error: 'Invalid API key' });
  }

  // Rate limiting: 1000 requests per minute per API key
  const rateLimitKey = RedisKeys.rateLimitKey(apiKey.id);
  const count = await redis.incr(rateLimitKey);
  if (count === 1) {
    await redis.expire(rateLimitKey, RedisTTL.RATE_LIMIT);
  }
  if (count > 1000) {
    return reply.code(429).send({ error: 'Rate limit exceeded' });
  }

  // Update last_used_at (fire-and-orchestrat for performance)
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  // Attach apiKeyId to request for downstream use
  (request as FastifyRequest & { apiKeyId: string }).apiKeyId = apiKey.id;
}
