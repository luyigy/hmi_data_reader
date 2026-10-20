import { readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';

export type SandboxIdentity = Readonly<{
  backend: 'bubblewrap'; host: string; uid: number; bootId: string;
  root: Readonly<{ pid: number; startTime: string }>;
}>;

export function captureSandboxIdentity(pid: number): SandboxIdentity {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (!/^\d+$/.test(fields[19] || '')) throw new Error('Incomplete sandbox root identity');
  return {
    backend: 'bubblewrap', host: hostname(), uid: statSync(`/proc/${pid}`).uid,
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    root: { pid, startTime: fields[19] },
  };
}

export function sameSandboxIdentity(a: SandboxIdentity, b: SandboxIdentity) {
  return a.backend === b.backend && a.host === b.host && a.uid === b.uid && a.bootId === b.bootId
    && a.root.pid === b.root.pid && a.root.startTime === b.root.startTime;
}
