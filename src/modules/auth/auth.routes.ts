import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { register } from './auth.service.js';

export const authRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstance,
) => {
  fastify.post(
    '/register',
    {
      schema: {
        body: {
          type: 'object',
          required: [
            'organisationName',
            'slug',
            'name',
            'email',
            'password',
          ],
          additionalProperties: false,
          properties: {
            organisationName: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
            },
            slug: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
            },
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
            },
            email: {
              type: 'string',
              format: 'email',
              maxLength: 254,
            },
            password: {
              type: 'string',
              minLength: 12,
              maxLength: 128,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await register(request.body as {
        organisationName: string;
        slug: string;
        name: string;
        email: string;
        password: string;
      });

      return reply.status(201).send(result);
    },
  );
};