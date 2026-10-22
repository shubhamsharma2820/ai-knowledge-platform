import { pool } from '../../db/database.js';
import { hashPassword, verifyPassword } from '../../security/password.js';
import { AppError } from '../../errors/app-error.js';
import type {
  RegisterInput,
  LoginInput
} from './auth.types.js';
import { redis } from '../../db/redis.js';
import { randomUUID } from 'node:crypto';
import { CREATE_SESSION_SCRIPT } from './sessions.service.js';

export async function register(input: RegisterInput) {
  const passwordHash = await hashPassword(input.password);
  const email = input.email.trim().toLowerCase();

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const organisationResult = await client.query(
      `INSERT INTO organisation (name, slug)
       VALUES ($1, $2)
       RETURNING id, name, slug, created_at, updated_at`,
      [input.organisationName.trim(), input.slug.trim()],
    );

    const organisation = organisationResult.rows[0];

    const userResult = await client.query(
      `INSERT INTO users (
         organisation_id,
         name,
         email,
         password_hash,
         is_active,
         is_deleted,
         role
       )
       VALUES ($1, $2, $3, $4, 1, 0, 'owner')
       RETURNING id, organisation_id, name, email, role`,
      [
        organisation.id,
        input.name.trim(),
        email,
        passwordHash,
      ],
    );

    await client.query('COMMIT');

    return {
      organisation,
      user: userResult.rows[0],
    };
  } catch (error: unknown) {
    await client.query('ROLLBACK');

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      if ('constraint' in error && error.constraint === 'users_email_lower_uidx') {
        throw new AppError(
          'User with this email already exists',
          409,
          'USER_EMAIL_CONFLICT',
        );
      }

      // Default 23505 conflict in registration is organisation slug
      throw new AppError(
        'Organisation with this slug already exists',
        409,
        'ORGANISATION_SLUG_CONFLICT',
      );
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function login(input: LoginInput) {
  const email = input.email.trim().toLowerCase();

  const result = await pool.query(
    `SELECT id, organisation_id, name, email, password_hash,
            is_active, is_deleted
     FROM users
     WHERE lower(trim(email)) = $1
     LIMIT 1`,
    [email],
  );

  const user = result.rows[0];

  if (
    !user ||
    !user.password_hash ||
    !(await verifyPassword(user.password_hash, input.password))
  ) {
    throw new AppError(
      'Invalid email or password',
      401,
      'INVALID_CREDENTIALS',
    );
  }

  if (user.is_active !== 1 || user.is_deleted !== 0) {
    throw new AppError(
      'Account is unavailable',
      403,
      'ACCOUNT_UNAVAILABLE',
    );
  }
  const sessionId = randomUUID();

  const sessionKey = `session:${sessionId}`;
  const userSessionsKey = `user-sessions:${user.id}`;
  const sessionVersionKey = `user-session-version:${user.id}`;

  const sessionData = JSON.stringify({
    userId: user.id,
    organisationId: user.organisation_id,
  });

  await redis.eval(CREATE_SESSION_SCRIPT, {
    keys: [
      sessionKey,
      userSessionsKey,
      sessionVersionKey,
    ],
    arguments: [
      sessionData,
      '900',
      sessionId,
    ],
  });

  return {
    id: user.id,
    organisationId: user.organisation_id,
    name: user.name,
    email: user.email,
    sessionId,
  };
}