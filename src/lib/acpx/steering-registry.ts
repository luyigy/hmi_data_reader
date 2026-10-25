import type { HarnessSteer } from './types';

// Both room and Ticket routes use the same native steering lifetime fence.
const runtime = globalThis as typeof globalThis & { harnessSteering?: Map<string, HarnessSteer> };
export function registerHarnessSteering(key: string, send: HarnessSteer) {
  const store = runtime.harnessSteering ??= new Map();
  const steer: HarnessSteer = (id, message) => store.get(key) === steer
    ? send(id, message) : Promise.resolve('rejected');
  store.set(key, steer);
  return { steer, unregister: () => { if (store.get(key) === steer) store.delete(key); } };
}
