import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import { requireGraphRunActiveTx } from './run-control';
import type { SkillVerification } from './skill-resource-preflight';

type RuntimeProbes = { browserVersion?: string; skills: SkillVerification[] };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
function parseProbes(value: unknown): RuntimeProbes {
  const item = record(value);
  if (item.browserVersion !== undefined && typeof item.browserVersion !== 'string' || !Array.isArray(item.skills)) throw new Error('Invalid saved resource probes');
  const skills = item.skills.map((value): SkillVerification => {
    const skill = record(value);
    if (typeof skill.id !== 'string' || typeof skill.package !== 'string' || typeof skill.checkScript !== 'string' || typeof skill.output !== 'string' || skill.exitCode !== 0 || !Array.isArray(skill.dependencies)) throw new Error('Invalid saved skill probe');
    const dependencies = skill.dependencies.map(value => {
      const dep = record(value);
      if (typeof dep.id !== 'string' || typeof dep.package !== 'string' || !Array.isArray(dep.requiredFiles) || !dep.requiredFiles.every((name): name is string => typeof name === 'string')) throw new Error('Invalid saved skill dependency');
      return { id: dep.id, package: dep.package, requiredFiles: dep.requiredFiles };
    });
    return { id: skill.id, package: skill.package, checkScript: skill.checkScript, output: skill.output, exitCode: 0, dependencies };
  });
  return { ...(typeof item.browserVersion === 'string' ? { browserVersion: item.browserVersion } : {}), skills };
}
// Project-owned probes may inspect source; a host-registered resource bundle is shared across code commits.
export type RuntimeProbeScope = { runId: string; nodeId: string; repository: string; policy: string; pythonIdentity: string | null; sourceIdentity: string | null };

/** Reuse successful resource probes; callers still validate current bytes and permissions. */
export async function reuseRuntimeProbes(scope: RuntimeProbeScope | undefined, identity: string, run: () => Promise<RuntimeProbes>): Promise<RuntimeProbes> {
  if (!scope) return run();
  const { nodeId, ...binding } = scope;
  const key = `runtime-probes:${createHash('sha256').update(JSON.stringify({ ...binding, identity })).digest('hex')}`;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const saved = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: scope.runId, idempotencyKey: key } } });
    if (saved) return parseProbes(saved.payload);
    const result = parseProbes(await run());
    await requireGraphRunActiveTx(tx, scope.runId);
    await tx.taskGraphEvent.create({ data: { runId: scope.runId, nodeId, kind: 'runtime_probes_verified', idempotencyKey: key, payload: result } });
    return result;
  }, { maxWait: 120_000, timeout: 120_000 });
}
