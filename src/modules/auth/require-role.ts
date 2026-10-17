import type { FastifyReply, FastifyRequest } from 'fastify';

type Role = 'owner' | 'admin' | 'member';

export function requireRole(...allowedRoles: Role[]) {
  return async function (
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const role = request.user.role as Role | undefined;

    if (!role || !allowedRoles.includes(role)) {
      return reply.status(403).send({
        error: 'FORBIDDEN',
        message: 'You do not have permission to perform this action',
      });
    }
  };
}