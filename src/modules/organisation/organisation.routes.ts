import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import * as organisationService from "./organisation.service.js";
import type { CreateOrganisationInput } from "./organisation.types.js";

export const organisationRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    fastify.post<{ Body: CreateOrganisationInput }>('/', async (request, reply) => {
        const { name, slug } = request.body ?? {};
        if (!name || !slug) {
            return reply.status(400).send({ error: "Name and slug are required" });
        }
        try {
            const org = await organisationService.createOrganisation({ name, slug });
            return reply.status(201).send(org);
        } catch (error: any) {
            if (error?.code === '23505') {
                return reply.status(409).send({ error: "Organisation with this slug already exists" });
            }
            throw error;
        }
    });

    fastify.get('/', async () => {
        return await organisationService.getOrganisations();
    });

    fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const { id } = request.params;
        const org = await organisationService.getOrganisationById(id);
        if (!org) {
            return reply.status(404).send({ error: "Organisation not found" });
        }
        return org;
    });
};
