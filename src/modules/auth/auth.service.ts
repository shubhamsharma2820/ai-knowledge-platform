import { pool } from '../../db/database.js';
import { hashPassword } from '../../security/password.js';
import { AppError } from '../../errors/app-error.js';
import type { RegisterInput } from './auth.types.js';

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
         is_deleted
       )
       VALUES ($1, $2, $3, $4, 1, 0)
       RETURNING id, organisation_id, name, email`,
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