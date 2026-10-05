export interface Organisation {
    id: string;
    name: string;
    slug: string;
    created_at: Date;
    updated_at: Date;
}

export interface CreateOrganisationInput {
    name: string;
    slug: string;
}

export interface UpdateOrganisationInput {
    name?: string;
    slug?: string;
}
