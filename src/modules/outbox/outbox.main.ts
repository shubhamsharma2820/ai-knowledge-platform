import { redis } from '../../db/redis.js';
import { pool } from '../../db/database.js';
import {
  runOutboxWorker,
  stopOutboxWorker,
} from './outbox.runner.js';

let shuttingDown = false;
let workerPromise: Promise<void> | null = null;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  stopOutboxWorker();

  try {
    if (workerPromise) {
      await workerPromise;
    }
  } finally {
    if (redis.isOpen) {
      await redis.quit();
    }

    await pool.end();
  }
}

process.once('SIGINT', () => {
  void shutdown();
});

process.once('SIGTERM', () => {
  void shutdown();
});

await redis.connect();

workerPromise = runOutboxWorker();
await workerPromise;

await shutdown();