import type { PoolClient } from 'pg';
import { pool } from './database.js';

export async function withTenantTransaction<T>(
  organisationId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionStarted = false;
  let connectionError: unknown = null;

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    // Switch to non-superuser role so PostgreSQL Row-Level Security (RLS) is strictly enforced
    await client.query(`SET LOCAL ROLE app_user`);

    await client.query(
      `SELECT set_config('app.organisation_id', $1, true)`,
      [organisationId],
    );

    const result = await callback(client);

    await client.query('COMMIT');
    transactionStarted = false;

    return result;
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError: unknown) {
        // If rollback fails, capture the error so client.release() destroys
        // the client connection and prevents returning a poisoned client to the pool.
        connectionError = rollbackError;
      }
    } else {
      // If failure occurred before transaction started (e.g. BEGIN failed),
      // discard the connection.
      connectionError = error;
    }

    throw error;
  } finally {
    // Passing an error to release() instructs pg-pool to discard/destroy
    // the connection rather than returning a corrupted client to the pool.
    client.release(connectionError as Error | boolean | undefined);
  }
}