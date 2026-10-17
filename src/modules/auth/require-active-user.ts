import type {
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { pool } from '../../db/database.js';

export async function requireActiveUser(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.user.sub;

  const result = await pool.query(
    `SELECT id, organisation_id, role, is_active, is_deleted
     FROM users
     WHERE id = $1`,
    [userId],
  );

  const user = result.rows[0];

  if (!user || user.is_active !== 1 || user.is_deleted !== 0) {
    return reply.status(401).send({
      error: 'UNAUTHORIZED',
      message: 'The account is unavailable',
    });
  }

  request.user.organisationId = user.organisation_id;
  request.user.role = user.role;
}