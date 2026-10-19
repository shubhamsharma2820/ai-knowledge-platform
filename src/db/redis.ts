import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

export const redis = createClient({
  url: redisUrl,
});

redis.on('error', (error) => {
  console.error('Redis client error:', error);
});