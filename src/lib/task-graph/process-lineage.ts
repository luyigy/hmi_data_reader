import { promises as fs } from 'node:fs';

export type ProcessIdentity = { pid: number; parentPid: number; startTime: string; state: string };
export type ProcessAncestor = Pick<ProcessIdentity, 'pid' | 'parentPid' | 'startTime'>;

export function parseProcessAncestry(value: unknown, owner: { pid: number; startTime: string }): ProcessAncestor[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 64) return null;
  const result: ProcessAncestor[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const pid: unknown = Reflect.get(item, 'pid'), parentPid: unknown = Reflect.get(item, 'parentPid'), startTime: unknown = Reflect.get(item, 'startTime');
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || typeof parentPid !== 'number' || !Number.isSafeInteger(parentPid) || parentPid < 1 || typeof startTime !== 'string' || !/^\d+$/.test(startTime) || result.some(before => before.pid === pid)) return null;
    if (result.length && (result[result.length - 1].parentPid !== pid || BigInt(startTime) > BigInt(result[result.length - 1].startTime))) return null;
    result.push({ pid, parentPid, startTime });
  }
  return result[0].pid === owner.pid && result[0].startTime === owner.startTime && result[result.length - 1].parentPid === 1 ? result : null;
}

export async function readProcessAncestry(owner: { pid: number; startTime: string }): Promise<ProcessAncestor[]> {
  const chain: ProcessAncestor[] = [];
  let pid = owner.pid;
  while (pid > 1 && chain.length < 64) {
    const identity = await readProcessIdentity(pid);
    chain.push({ pid: identity.pid, parentPid: identity.parentPid, startTime: identity.startTime });
    pid = identity.parentPid;
  }
  const parsed = parseProcessAncestry(chain, owner);
  if (!parsed) throw new Error('Cannot capture stable process ancestry');
  for (const before of parsed) {
    const after = await readProcessIdentity(before.pid);
    if (after.parentPid !== before.parentPid || after.startTime !== before.startTime) throw new Error('Process ancestry changed during capture');
  }
  return parsed;
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (!fields[19] || !/^\d+$/.test(fields[19]) || !/^\d+$/.test(fields[1]) || !fields[0]) throw new Error('Incomplete process identity');
  return { pid, state: fields[0], parentPid: Number(fields[1]), startTime: fields[19] };
}

export async function hasIndependentProcessOrigin(args: {
  pid: number; owner: { pid: number; startTime: string }; ancestry?: ProcessAncestor[];
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
    let owner: ProcessIdentity | undefined;
    try { owner = await capture(args.owner.pid); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return false;
      const history = parseProcessAncestry(args.ancestry, args.owner);
      if (!history) return false;
      for (const before of history) {
        ownerPids.add(before.pid);
        try {
          const after = await capture(before.pid);
          if (after.parentPid !== before.parentPid || after.startTime !== before.startTime) return false;
        } catch (readError) {
          if (!(readError instanceof Error && 'code' in readError && readError.code === 'ENOENT')) return false;
        }
      }
    }
    if (owner) {
      if (owner.startTime !== args.owner.startTime || ['Z', 'X'].includes(owner.state)) return false;
      for (let depth = 0; ; depth++) {
        if (depth >= 64 || owner.pid <= 1 || owner.parentPid <= 0) return false;
        ownerPids.add(owner.pid);
        if (owner.parentPid === 1) break;
        owner = await capture(owner.parentPid);
      }
      if (args.ancestry !== undefined) {
        const history = parseProcessAncestry(args.ancestry, args.owner);
        if (!history || history.length !== ownerPids.size) return false;
        for (const before of history) {
          const current = snapshot.get(before.pid);
          if (!current || current.startTime !== before.startTime || current.parentPid !== before.parentPid) return false;
        }
      }
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
