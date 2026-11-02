import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runKimiServer } from '../src/lib/real-agents/kimi-server';
import { supportsHarnessSteering } from '../src/lib/harness/registry';
import type { HarnessSteer } from '../src/lib/acpx/types';

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'kimi-bridge-test-'));
  const previous = process.env.KIMI_CODE_TRANSPORT;
  try {
    delete process.env.KIMI_CODE_TRANSPORT;
    assert.equal(supportsHarnessSteering('kimi-code', 'platform_local'), true);
    assert.equal(supportsHarnessSteering('kimi-code', 'remote_ssh'), false);
    assert.equal(supportsHarnessSteering('unknown', 'platform_local'), false);
    for (const name of ['pi-agent', 'codex', 'antigravity']) assert.equal(supportsHarnessSteering(name, 'platform_local'), true);
    process.env.KIMI_CODE_TRANSPORT = 'print';
    assert.equal(supportsHarnessSteering('kimi-code', 'platform_local'), false);
    const base = { binary: path.join(process.cwd(), 'tests/fixtures/kimi-web.cjs'), configPaths: [], prompt: 'original', workingDirectory: dir, timeout: 10000 };
    const long = await runKimiServer({ ...base, prompt: 'x'.repeat(400), env: process.env });
    assert.equal(long.output, 'done:' + 'x'.repeat(400), 'final output is not a short progress preview');
    for (const mode of ['quota', 'success', 'reject', 'unknown', 'disconnect', 'crash', 'hang', 'stop']) {
      const pidFile = path.join(dir, mode + '.json');
      let release = 0, control: HarnessSteer | undefined;
      let receipt: Promise<string> | undefined, duplicate: Promise<string> | undefined;
      const progress: string[] = [];
      const promise = runKimiServer({ ...base, timeout: mode === 'hang' ? 700 : 10000,
        env: { ...process.env, KIMI_SERVER_CASE: mode, KIMI_SERVER_PID_FILE: pidFile },
        onSpawn: child => { if (mode === 'stop') setTimeout(() => child.kill('SIGTERM'), 500); },
        streamCallbacks: {
          onSteeringReady: steer => {
            control = steer;
            if (['success', 'reject', 'unknown'].includes(mode)) {
              receipt = steer('message', 'inserted'); duplicate = steer('message', 'inserted');
            }
            return () => { release++; };
          },
          onStdoutChunk: text => { progress.push(text); },
        },
      });
      if (mode === 'quota') await assert.rejects(promise, error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Kimi 额度已耗尽.*429.*5-hour usage limit/);
        assert.doesNotMatch(error.message, /fixture-private-token|DO_NOT_DISCLOSE/);
        return true;
      });
      else if (['disconnect', 'crash', 'hang', 'stop'].includes(mode)) await assert.rejects(promise, mode === 'disconnect' ? /connection lost/ : mode === 'hang' ? /timed out/ : mode === 'crash' ? /server exited/ : /ended/);
      else if (mode === 'unknown') {
        assert.equal(await new Promise<string>(resolve => {
          const timer = setInterval(() => { if (receipt) { clearInterval(timer); void receipt.then(resolve); } }, 10);
        }), 'unknown');
        // Acknowledgement loss must not cause a second submission. Stop the hung fixture.
        // The runner timeout exercises cleanup after the indeterminate receipt.
        await assert.rejects(promise, /timed out/);
      } else {
        const result = await promise;
        assert.equal(result.output, mode === 'success' ? 'done:original|inserted' : 'done:original');
        assert.equal(await receipt, mode === 'success' ? 'accepted' : 'rejected');
        assert.equal(await duplicate, await receipt);
      }
      if (mode === 'quota') assert.equal(await readFile(pidFile + '.released', 'utf8'), 'released', 'native cleanup finishes before the host handles failure');
      assert.equal(release, 1, mode);
      assert.ok(!progress.join('').includes('DO_NOT_DISCLOSE'));
      assert.equal(await control?.('late', 'too late'), 'rejected');
      const pids: number[] = JSON.parse(await readFile(pidFile, 'utf8'));
      for (const pid of pids) {
        let alive = true;
        try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); alive = !stat.includes(') Z '); } catch { alive = false; }
        assert.equal(alive, false, `${mode}: descendant ${pid} survived`);
      }
    }
    console.log('Kimi bridge: registration, accepted/rejected/unknown receipts, dedup, disconnect, timeout, stop, and descendant cleanup passed');
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_TRANSPORT; else process.env.KIMI_CODE_TRANSPORT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
