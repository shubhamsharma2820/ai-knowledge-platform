import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import * as organisationService from "./organisation.service.js";
import { getOrganisationById, updateOrganisation } from "./organisations.service.js";
import type { CreateOrganisationInput } from "./organisation.types.js";
import { authenticate } from '../auth/authenticate.js';
import { requireActiveUser } from '../auth/require-active-user.js';
import { requireRole } from '../auth/require-role.js';
import { updateUserRole, type Role } from '../auth/permissions.service.js';

export const organisationRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    
fastify.post<{ Body: CreateOrganisationInput }>(
  '/',
  {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'slug'],
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
          },
          slug: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
          },
        },
      },
    },
  },
  async (request, reply) => {
    const organisation = await organisationService.createOrganisation({
      name: request.body.name,
      slug: request.body.slug,
    });

    return reply.status(201).send(organisation);
  },
);


    fastify.get('/', async () => {
        return await organisationService.getOrganisations();
    });

    fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const { id } = request.params;
        const org = await getOrganisationById(id);
        if (!org) {
            return reply.status(404).send({ error: "Organisation not found" });
        }
        return org;
    });

    const updateSchema = {
        params: {
            type: 'object',
            required: ['id'],
            properties: {
                id: { type: 'string' },
            },
        },
        body: {
            type: 'object',
            required: ['name'],
            additionalProperties: false,
            properties: {
                name: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 255,
                },
            },
        },
    };

    fastify.patch<{ Params: { id: string }; Body: { name: string } }>(
        '/:id',
        { schema: updateSchema },
        async (request, reply) => {
            const { id } = request.params;
            const { name } = request.body;
            const org = await updateOrganisation(id, { name });
            if (!org) {
                return reply.status(404).send({ error: "Organisation not found" });
            }
            return reply.status(200).send(org);
        },
    );

    fastify.put<{ Params: { id: string }; Body: { name: string } }>(
        '/:id',
        { schema: updateSchema },
        async (request, reply) => {
            const { id } = request.params;
            const { name } = request.body;
            const org = await updateOrganisation(id, { name });
            if (!org) {
                return reply.status(404).send({ error: "Organisation not found" });
            }
            return reply.status(200).send(org);
        },
    );

    fastify.patch<{
        Params: { id: string; userId: string };
        Body: { role: Role };
    }>(
        '/:id/users/:userId/role',
        {
            preHandler: [authenticate, requireActiveUser, requireRole('owner', 'admin')],
            schema: {
                params: {
                    type: 'object',
                    required: ['id', 'userId'],
                    properties: {
                        id: { type: 'string' },
                        userId: { type: 'string' },
                    },
                },
                body: {
                    type: 'object',
                    required: ['role'],
                    additionalProperties: false,
                    properties: {
                        role: {
                            type: 'string',
                            enum: ['owner', 'admin', 'member'],
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const { id: organisationId, userId } = request.params;
            const { role } = request.body;

            // Security check: an admin/owner can only modify users in their own organisation
            if (request.user.organisationId !== organisationId) {
                return reply.code(403).send({
                    error: 'FORBIDDEN',
                    message: 'Cannot modify users in another organisation',
                });
            }

            const updatedRole = await updateUserRole(userId, organisationId, role);
            if (!updatedRole) {
                return reply.code(404).send({
                    error: 'NOT_FOUND',
                    message: 'User not found in this organisation',
                });
            }

            return reply.code(200).send({
                message: 'Role updated successfully',
                userId,
                organisationId,
                role: updatedRole,
            });
        },
    );
};

