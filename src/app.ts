import Fastify from "fastify";
import { pool } from "./db/database.js";
import { organisationRoutes } from "./modules/organisation/organisation.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { registerErrorHandler } from "./errors/error-handler.js";
import { env } from "./config/env.js";
import jwt from '@fastify/jwt';

export function buildApp() {
    const app = Fastify({
        logger: process.env.NODE_ENV === 'test' ? false : true,
        ajv: {
            customOptions: {
                coerceTypes: false,
                removeAdditional: false,
            },
        },
    });
    registerErrorHandler(app);

    app.register(jwt, {
        secret: env.jwtSecret,
        sign: {
            expiresIn: '15m',
        },
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
    });

    app.register(organisationRoutes, { prefix: '/organisations' });
    app.register(authRoutes, { prefix: '/auth' });

    return app;
}