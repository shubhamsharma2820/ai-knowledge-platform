import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      organisationId: string;
      role?: 'owner' | 'admin' | 'member';
    };
    user: {
      sub: string;
      organisationId: string;
      role?: 'owner' | 'admin' | 'member';
    };
  }
}
