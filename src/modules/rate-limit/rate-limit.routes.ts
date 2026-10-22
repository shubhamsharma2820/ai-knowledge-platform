import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/authenticate.js';
import { requireActiveUser } from '../auth/require-active-user.js';
import { checkRateLimit } from './rate-limit.service.js';

export async function rateLimitRoutes(app: FastifyInstance) {
  app.get(
    '/rate-limit-test',
    {
      preHandler: [authenticate, requireActiveUser],
    },
    async (request, reply) => {
      const userId = request.user.sub;
      const key = `rate-limit:user:${userId}`;

      const result = await checkRateLimit(key, 5, 60);

      reply.header('X-RateLimit-Limit', result.limit);
      reply.header('X-RateLimit-Remaining', result.remaining);

      if (!result.allowed) {
        return reply
          .code(429)
          .header('Retry-After', '60')
          .send({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Try again later.',
          });
      }

      return {
        message: 'Request allowed',
        count: result.count,
        remaining: result.remaining,
      };
    },
  );
}