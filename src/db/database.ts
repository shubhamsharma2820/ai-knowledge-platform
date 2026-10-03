import { Pool } from 'pg';
import { env } from '../config/env.js';

export const pool = new Pool({

    user: env.db.user,
    host: env.db.host,
    database: env.db.name,
    password: env.db.password,
    port: env.db.port,
    max: 10 //poll size 10
});

export async function query<T = any>(text: string, params?: any[]) {
    const res = await pool.query(text, params);
    return res as { rows: T[] };
}