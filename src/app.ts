import Fastify from "fastify";
import { pool } from "./db/database.js";

export function buildApp() {
    const app = Fastify({
        logger: true
    });

    app.get('/health', async () => {
        return {
            status: "ok"
        };
    });

    app.get('/health/db', async () => {
        const result = await pool.query('SELECT NOW()');
        return {
            status: 'ok',
            dbTime: result.rows[0].now
        };
    })


    return app;
}