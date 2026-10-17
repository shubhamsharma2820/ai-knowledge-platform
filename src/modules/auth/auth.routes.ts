import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { register, login } from './auth.service.js';
import { authenticate } from './authenticate.js';
import {requireActiveUser} from './require-active-user.js'
import {requireRole} from './require-role.js'

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

  fastify.post(
  '/login',
  {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        additionalProperties: false,
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  },
  async (request, reply) => {
    const identity = await login(request.body as {
      email: string;
      password: string;
    });

    const accessToken = fastify.jwt.sign({
      sub: identity.id,
      organisationId: identity.organisationId,
    });

    return reply.status(200).send({
      accessToken,
      tokenType: 'Bearer',
      expiresIn: 900,
      user: {
        id: identity.id,
        name: identity.name,
        email: identity.email,
      },
    });
  },
);

fastify.get(
  '/me',
  { preHandler: [authenticate,requireActiveUser,requireRole('owner', 'admin')] },
  async (request) => {
    return {
      userId: request.user.sub,
      organisationId: request.user.organisationId,
    };
  },
);

};