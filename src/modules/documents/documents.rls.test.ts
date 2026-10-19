import { describe, it, before as beforeAll, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../db/database.js';
import { withTenantTransaction } from '../../db/tenant-transaction.js';

// Jest-compatible assertion helper
function expect<T>(actual: T[]) {
  return {
    toContain: (item: T) => {
      assert.ok(actual.includes(item), `Expected array to contain ${String(item)}`);
    },
    not: {
      toContain: (item: T) => {
        assert.ok(!actual.includes(item), `Expected array not to contain ${String(item)}`);
      },
    },
  };
}

describe('knowledge_documents RLS', () => {
  let organisationA: string;
  let organisationB: string;
  let documentA: string;
  let documentB: string;

  beforeAll(async () => {
    // Use two existing test organizations.
    let result = await pool.query(
      `SELECT id
       FROM organisation
       ORDER BY id
       LIMIT 2`,
    );

    if (result.rows.length < 2) {
      await pool.query(
        `INSERT INTO organisation (name, slug)
         VALUES ('Test Org Alpha', $1), ('Test Org Beta', $2)
         ON CONFLICT DO NOTHING`,
        [`test-org-alpha-${Date.now()}`, `test-org-beta-${Date.now()}`],
      );

      result = await pool.query(
        `SELECT id
         FROM organisation
         ORDER BY id
         LIMIT 2`,
      );
    }

    const ids = result.rows.map((row: { id: string }) => row.id);
    const orgA = ids[0];
    const orgB = ids[1];

    if (!orgA || !orgB) {
      throw new Error('Create two test organizations before running this test');
    }

    organisationA = orgA;
    organisationB = orgB;

    const titleA = `rls-test-a-${Date.now()}`;
    const titleB = `rls-test-b-${Date.now()}`;

    documentA = await withTenantTransaction(organisationA, async (client) => {
      const inserted = await client.query(
        `INSERT INTO knowledge_documents (organisation_id, title)
         VALUES ($1, $2)
         RETURNING id`,
        [organisationA, titleA],
      );

      return inserted.rows[0].id;
    });

    documentB = await withTenantTransaction(organisationB, async (client) => {
      const inserted = await client.query(
        `INSERT INTO knowledge_documents (organisation_id, title)
         VALUES ($1, $2)
         RETURNING id`,
        [organisationB, titleB],
      );

      return inserted.rows[0].id;
    });
  });

  it('only exposes documents belonging to the current organization', async () => {
    const visibleToA = await withTenantTransaction(
      organisationA,
      async (client) => {
        const result = await client.query(
          `SELECT id FROM knowledge_documents`,
        );

        return result.rows.map((row: { id: string }) => row.id);
      },
    );

    const visibleToB = await withTenantTransaction(
      organisationB,
      async (client) => {
        const result = await client.query(
          `SELECT id FROM knowledge_documents`,
        );

        return result.rows.map((row: { id: string }) => row.id);
      },
    );

    expect(visibleToA).toContain(documentA);
    expect(visibleToA).not.toContain(documentB);

    expect(visibleToB).toContain(documentB);
    expect(visibleToB).not.toContain(documentA);
  });

  afterAll(async () => {
    if (organisationA && documentA) {
      await withTenantTransaction(organisationA, async (client) => {
        await client.query(
          `DELETE FROM knowledge_documents WHERE id = $1`,
          [documentA],
        );
      });
    }

    if (organisationB && documentB) {
      await withTenantTransaction(organisationB, async (client) => {
        await client.query(
          `DELETE FROM knowledge_documents WHERE id = $1`,
          [documentB],
        );
      });
    }
  });
});
