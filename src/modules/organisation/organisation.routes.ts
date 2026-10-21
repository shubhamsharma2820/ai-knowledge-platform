import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import * as organisationService from "./organisation.service.js";
import { getOrganisationById, updateOrganisation } from "./organisations.service.js";
import type { CreateOrganisationInput } from "./organisation.types.js";

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
};

