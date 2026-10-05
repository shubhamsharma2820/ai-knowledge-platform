import { pool } from "../../db/database.js";
import type { CreateOrganisationInput, Organisation } from "./organisation.types.js";

export async function createOrganisation(input: CreateOrganisationInput): Promise<Organisation> {
    const result = await pool.query<Organisation>(
        `INSERT INTO organisation (name, slug)
         VALUES ($1, $2)
         RETURNING id, name, slug, created_at, updated_at`,
        [input.name, input.slug]
    );
    return result.rows[0]!;
}

export async function getOrganisations(): Promise<Organisation[]> {
    const result = await pool.query<Organisation>(
        `SELECT id, name, slug, created_at, updated_at FROM organisation ORDER BY created_at DESC`
    );
    return result.rows;
}

export async function getOrganisationById(id: string): Promise<Organisation | null> {
    const result = await pool.query<Organisation>(
        `SELECT id, name, slug, created_at, updated_at FROM organisation WHERE id = $1`,
        [id]
    );
    return result.rows[0] ?? null;
}

export async function getOrganisationBySlug(slug: string): Promise<Organisation | null> {
    const result = await pool.query<Organisation>(
        `SELECT id, name, slug, created_at, updated_at FROM organisation WHERE slug = $1`,
        [slug]
    );
    return result.rows[0] ?? null;
}
