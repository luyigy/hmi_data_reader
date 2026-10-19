import type { GraphDefinition } from '../task-graph/domain';
import { projectCapabilityPolicy, restrictProjectCapabilities } from './policy';

/** Resolve defaults before the confirmation card is hashed; missing scopes never expand at execution time. */
export async function inheritProjectCapabilityScopes(definition: GraphDefinition) {
  const result: GraphDefinition = structuredClone(definition);
  if (result.adoptRun) return result;
  for (const node of result.nodes) for (const job of node.executions) {
    const policy = await projectCapabilityPolicy(job.repository);
    if (!policy) {
      if (job.capabilities) throw new Error('任务引用未登记的项目能力');
      continue;
    }
    if (job.capabilities) restrictProjectCapabilities(policy, job.capabilities);
    else job.capabilities = { policyHash: policy.hash, sources: policy.sources.map(source => source.key), readOnlyRoots: policy.readOnlyRoots };
  }
  return result;
}
