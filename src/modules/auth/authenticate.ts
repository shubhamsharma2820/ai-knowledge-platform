import type {
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { redis } from '../../db/redis.js'

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'A valid access token is required',
    });
  }

  const userId = request.user.sub;
  const sessionId = request.user.sid;

  if (!sessionId) {
    return reply.code(401).send({
      message: 'Invalid session',
    });
  }

  let sessionRaw: string | null;
  let currentVersionRaw: string | null;

  try {
    [sessionRaw, currentVersionRaw] = await Promise.all([
      redis.get(`session:${sessionId}`),
      redis.get(`user-session-version:${userId}`),
    ]);
  } catch (error) {
    request.log.error(
      { err: error },
      'Session validation unavailable',
    );

    return reply.code(503).send({
      message: 'Authentication temporarily unavailable',
    });
  }

  if (sessionRaw === null) {
    return reply.code(401).send({
      message: 'Session revoked or expired',
    });
  }

  const session = JSON.parse(sessionRaw);
  const currentVersion = currentVersionRaw === null
    ? 0
    : Number(currentVersionRaw);

  if (
    session.userId !== userId ||
    !Number.isSafeInteger(session.sessionVersion) ||
    session.sessionVersion !== currentVersion
  ) {
    return reply.code(401).send({
      message: 'Session invalid',
    });
  }
}