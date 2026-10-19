import type { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../auth/authenticate.js';
import { requireActiveUser } from '../auth/require-active-user.js';
import { listDocuments } from './documents.service.js';

export const documentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/',
    {
      preHandler: [authenticate, requireActiveUser],
    },
    async (request, reply) => {
      const organisationId = request.user.organisationId;

      // Fail closed if the authenticated tenant context is missing.
      if (!organisationId) {
        return reply.status(401).send({
          error: 'UNAUTHORIZED',
          message: 'Organization context is unavailable',
        });
      }

      return listDocuments(organisationId);
    },
  );
};