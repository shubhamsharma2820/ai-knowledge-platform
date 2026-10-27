
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getUserRole } from './permissions.service.js'

type Role = 'owner' | 'admin' | 'member';

export function requireRole(...allowedRoles: Role[]) {
  return async function (
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const userId = request.user.sub;
    const organisationId = request.user.organisationId;

    let role: Role | null;

    try {
      role = await getUserRole(userId, organisationId);
    } catch (error) {
      request.log.error(
        { err: error },
        'Failed to resolve current user role',
      );

      return reply.status(503).send({
        error: 'AUTHORIZATION_UNAVAILABLE',
        message: 'Authorization is temporarily unavailable',
      });
    }

    if (!role || !allowedRoles.includes(role)) {
      return reply.status(403).send({
        error: 'FORBIDDEN',
        message: 'You do not have permission to perform this action',
      });
    }
  };
}
