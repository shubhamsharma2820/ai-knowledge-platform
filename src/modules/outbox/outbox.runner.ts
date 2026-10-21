import { processOutboxBatch } from './outbox.worker.js';

const POLL_INTERVAL_MS = 1_000;

let stopping = false;
let activeRun: Promise<void> | null = null;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function stopOutboxWorker(): void {
  stopping = true;
}

export async function runOutboxWorker(): Promise<void> {
  if (activeRun) {
    return activeRun;
  }

  activeRun = (async () => {
    while (!stopping) {
      try {
        const processed = await processOutboxBatch(10);

        if (processed === 0 && !stopping) {
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (error) {
        console.error('Outbox worker batch failed:', error);

        if (!stopping) {
          await sleep(POLL_INTERVAL_MS);
        }
      }
    }
  })();

  try {
    await activeRun;
  } finally {
    activeRun = null;
  }
}