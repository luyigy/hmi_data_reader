import assert from 'node:assert/strict';
import test from 'node:test';
import { compactStreamWrites, createStreamWriteBuffer } from '../src/lib/acpx/stream-write-buffer';

test('batches adjacent stream chunks and drains once', async () => {
  const batches: ReturnType<typeof compactStreamWrites>[] = [];
  const buffer = createStreamWriteBuffer(async (writes) => { batches.push(writes); }, 60_000);

  buffer.push({ stream: 'stdout', content: 'hel', interactionDetected: false });
  buffer.push({ stream: 'stdout', content: 'lo', interactionDetected: false });
  buffer.push({ stream: 'stderr', content: '!', interactionDetected: false });
  await buffer.drain();

  assert.deepEqual(batches, [[
    { stream: 'stdout', content: 'hello', interactionDetected: false },
    { stream: 'stderr', content: '!', interactionDetected: false },
  ]]);
});
