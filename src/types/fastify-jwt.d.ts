import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      organisationId: string;
      role?: 'owner' | 'admin' | 'member';
      sid?: string;
    };
    user: {
      sub: string;
      organisationId: string;
      role?: 'owner' | 'admin' | 'member';
      sid?: string;
    };
  }
}
