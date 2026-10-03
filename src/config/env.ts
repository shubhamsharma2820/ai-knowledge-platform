import 'dotenv/config';

export const env = {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    db: {
        host: process.env.DATABASE_HOST ?? 'localhost',
        port: Number(process.env.DATABASE_PORT ?? 5432),
        user: process.env.DATABASE_USER ?? 'postgres',
        password: process.env.DATABASE_PASSWORD ?? 'password',
        name: process.env.DATABASE_NAME ?? 'ai-knowledge-platform',
        url: process.env.DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/ai-knowledge-platform',
    }
};