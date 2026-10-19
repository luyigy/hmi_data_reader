import { promises as fs } from 'node:fs';

export type ProcessIdentity = { pid: number; parentPid: number; startTime: string; state: string };

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (!fields[19] || !/^\d+$/.test(fields[19]) || !/^\d+$/.test(fields[1]) || !fields[0]) throw new Error('Incomplete process identity');
  return { pid, state: fields[0], parentPid: Number(fields[1]), startTime: fields[19] };
}

export async function hasIndependentProcessOrigin(args: {
  pid: number; owner: { pid: number; startTime: string };
  readIdentity?: (pid: number) => Promise<ProcessIdentity>;
}): Promise<boolean> {
  const read = args.readIdentity || readProcessIdentity;
  const snapshot = new Map<number, ProcessIdentity>();
  const capture = async (pid: number) => {
    const identity = await read(pid);
    if (identity.pid !== pid || snapshot.has(pid)) throw new Error('Process lineage changed or loops');
    snapshot.set(pid, identity);
    return identity;
  };
  try {
    const ownerPids = new Set<number>();
    let owner = await capture(args.owner.pid);
    if (owner.startTime !== args.owner.startTime || ['Z', 'X'].includes(owner.state)) return false;
    for (let depth = 0; ; depth++) {
      if (depth >= 64 || owner.pid <= 1 || owner.parentPid <= 0) return false;
      ownerPids.add(owner.pid);
      if (owner.parentPid === 1) break;
      owner = await capture(owner.parentPid);
    }
    let pid = args.pid;
    let independent = false;
    for (let depth = 0; depth < 64 && pid > 1; depth++) {
      if (ownerPids.has(pid)) return false;
      const identity = await capture(pid);
      if (BigInt(identity.startTime) < BigInt(args.owner.startTime)) { independent = true; break; }
      pid = identity.parentPid;
    }
    if (!independent) return false;
    for (const before of Array.from(snapshot.values())) {
      const after = await read(before.pid);
      if (after.pid !== before.pid || after.parentPid !== before.parentPid || after.startTime !== before.startTime || ['Z', 'X'].includes(after.state)) return false;
    }
    return true;
  } catch { return false; }
}
