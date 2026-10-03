import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const app = buildApp();

async function start() {
    try {
        await app.listen({
            port: env.port,
            host: env.host
        });
        const shutdown = async (signal: string) => {
            app.log.info(`Received ${signal}, shutting down gracefully`);
            try {
                await app.close();
                process.exit(0);
            }
            catch (e) {
                app.log.error(e);
                process.exit(1);
            }
        };
        process.on("SIGINT", () => shutdown("SIGINT"));
        process.on("SIGTERM", () => shutdown("SIGTERM"));
        app.log.info('Server started');
    }
    catch (e) {
        app.log.error(e);
        process.exit(1);
    }
}

start();