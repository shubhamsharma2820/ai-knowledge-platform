import type { CreateOrganisationInput, Organisation } from "./organisation.types.js";
import { AppError } from "../../errors/app-error.js";
import * as organisationRepository from './organisation.repository.js';

function isSlugUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  if (!('code' in error) || error.code !== '23505') {
    return false;
  }

  // PostgreSQL default unique constraint name on table organisation column slug is organisation_slug_key
  return !('constraint' in error) || error.constraint === 'organisation_slug_key';
}

export async function createOrganisation(
  input: CreateOrganisationInput,
): Promise<Organisation> {
  try {
    return await organisationRepository.insertOrganisation(input);
  } catch (error: unknown) {
    if (isSlugUniqueViolation(error)) {
      throw new AppError(
        'Organisation with this slug already exists',
        409,
        'ORGANISATION_SLUG_CONFLICT',
      );
    }

    throw error;
  }
}

export async function getOrganisations(): Promise<Organisation[]> {
  return organisationRepository.findOrganisations();
}

export async function getOrganisationById(id: string): Promise<Organisation | null> {
  return organisationRepository.findOrganisationById(id);
}

export async function getOrganisationBySlug(slug: string): Promise<Organisation | null> {
  return organisationRepository.findOrganisationBySlug(slug);
}
