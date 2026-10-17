process.env.NODE_ENV = 'test';
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/database.js';

describe('POST /organisations - Centralized error handling & creation tests', () => {
  const app = buildApp();
  const originalQuery = pool.query;

  after(async () => {
    pool.query = originalQuery;
    await app.close();
  });

  beforeEach(() => {
    // Default mock implementation of database query
    pool.query = (async (text: string, params?: any[]) => {
      if (typeof text === 'string' && text.includes('INSERT INTO organisation')) {
        const [name, slug] = params || [];
        return {
          rows: [
            {
              id: 'd9b9776b-9c3f-4e0d-b4ef-1d573133cb65',
              name,
              slug,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    }) as any;
  });

  test('Case 1: Valid payload {"name":"Acme","slug":"acme"} -> 201 Created', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/organisations',
      payload: { name: 'Acme', slug: 'acme' },
    });

    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);
    assert.equal(body.name, 'Acme');
    assert.equal(body.slug, 'acme');
    assert.ok(body.id);
  });

  test('Case 2: Missing required field slug {"name":"Acme"} -> 400 Bad Request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/organisations',
      payload: { name: 'Acme' },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
  });

  test('Case 3: Wrong type for name {"name":123,"slug":"acme"} -> 400 Bad Request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/organisations',
      payload: { name: 123, slug: 'acme' },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
  });

  test('Case 4: Additional properties {"name":"Acme","slug":"acme","admin":true} -> 400 Bad Request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/organisations',
      payload: { name: 'Acme', slug: 'acme', admin: true },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
  });

  test('Case 5: Duplicate slug (Postgres 23505 -> AppError) -> 409 Conflict', async () => {
    pool.query = (async () => {
      const error: any = new Error('duplicate key value violates unique constraint');
      error.code = '23505';
      throw error;
    }) as any;

    const response = await app.inject({
      method: 'POST',
      url: '/organisations',
      payload: { name: 'Acme', slug: 'acme' },
    });

    assert.equal(response.statusCode, 409);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'ORGANISATION_SLUG_CONFLICT',
      message: 'Organisation with this slug already exists',
    });
  });

  test('Case 6: Empty strings {"name":"","slug":"acme"} -> 400 Bad Request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/organisations',
      payload: { name: '', slug: 'acme' },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
  });

  test('Case 7: Unhandled database error -> 500 Internal Server Error', async () => {
    pool.query = (async () => {
      throw new Error('Database connection lost');
    }) as any;

    const response = await app.inject({
      method: 'POST',
      url: '/organisations',
      payload: { name: 'Acme', slug: 'acme' },
    });

    assert.equal(response.statusCode, 500);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    });
  });
});
