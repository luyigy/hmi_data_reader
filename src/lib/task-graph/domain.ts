import type { AcceptanceModels } from './acceptance-models';
import { parseProjectCapabilityScope } from '../project-capabilities/policy';
import type { ProjectCapabilityScope } from '../project-capabilities/policy';
import { validateExtraRepositories, type ExtraRepository } from './extra-repositories';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateServices, validateServiceLaunch, type GraphService } from './service-contract';
import type { SpecPackageRef } from './spec-package';
import type { IssueSource } from './issue-source';

export type Acceptance = {
  mode: 'automatic' | 'agent' | 'human';
  selfCheckExecution?: string;
  models?: AcceptanceModels;
  reviewerId?: string;
  reviewLaunchConfig?: unknown;
  integrationChecks?: { name: string; repository: string; argv: string[] }[];
  checks: string[];
};

export type ArchitectureReview = {
  reviewerId: string;
  reviewLaunchConfig: unknown;
};

export type GraphExecution = {
  key: string;
  instructions: string;
  repository: string;
  gitRef: string;
  baseCommit: string;
  agentSelector: string;
  launchConfig?: unknown;
  capabilities?: ProjectCapabilityScope;
};

export type GraphNode = {
  key: string;
  goal: string;
  dependsOn: string[];
  extraRepositories?: ExtraRepository[];
  consumeUpstream?: 'direct' | 'none' | string[];
  services?: GraphService[];
  executionMode?: 'full' | 'lean' | 'implement';
  acceptance: Acceptance;
  architectureReview?: ArchitectureReview;
  executions: GraphExecution[];
};

export type GraphDefinition = {
  deliveryContract?: 'agent_owned_v1';
  specRef: string;
  specPackage?: SpecPackageRef;
  issueSource?: IssueSource;
  adoptRun?: { runId: string; snapshotHash: string };
  defaultArchitectureReview?: ArchitectureReview;
  nodes: GraphNode[];
};

export function effectiveArchitectureReview(graph: GraphDefinition, node: GraphNode) {
  if (node.executionMode === 'lean' || node.executionMode === 'implement') return undefined;
  return node.architectureReview || graph.defaultArchitectureReview;
}

/** The unique implementor needs no selection; multiple executions require an approved key. */
export function selfCheckExecution(node: GraphNode) {
  if (node.executionMode === 'implement' || node.acceptance.mode === 'agent') return undefined;
  return node.acceptance.selfCheckExecution || (node.executions.length === 1 ? node.executions[0].key : undefined);
}

export function isCompletedNodeStatus(status: string) {
  return status === 'passed' || status === 'delivered_unverified';
}

export function validateTaskGraphDefinition(input: GraphDefinition): GraphDefinition {
  if (!input.specRef?.trim() || !Array.isArray(input.nodes) || input.nodes.length === 0) {
    throw new Error('Task graph requires a spec reference and at least one node');
  }
  if (input.deliveryContract !== undefined && input.deliveryContract !== 'agent_owned_v1') throw new Error('Unknown delivery contract');
  const keys = new Set<string>();
  if (input.adoptRun && (!input.adoptRun.runId?.trim() || !/^[a-f0-9]{64}$/.test(input.adoptRun.snapshotHash))) throw new Error('Invalid existing run association');
  if (input.specPackage && (!isAbsolute(input.specPackage.repository) ||
      !/^[a-f0-9]{40}$/.test(input.specPackage.commit) || !/^[a-f0-9]{64}$/.test(input.specPackage.hash) ||
      !input.specPackage.manifestPath?.startsWith('docs/specs/'))) throw new Error('Invalid frozen Spec package');
  const validArchitectureReview = (review: ArchitectureReview | undefined) =>
    review === undefined || (!!review.reviewerId?.trim() && !!review.reviewLaunchConfig);
  if (!validArchitectureReview(input.defaultArchitectureReview)) {
    throw new Error('Invalid default architecture reviewer');
  }
  for (const node of input.nodes) {
    if (node.executionMode !== undefined && !['full', 'lean', 'implement'].includes(node.executionMode)) {
      throw new Error(`Invalid execution mode for ${node.key}`);
    }
    if (!node.key?.trim() || !node.goal?.trim() || keys.has(node.key)) throw new Error(`Duplicate or empty node key/goal: ${node.key}`);
    keys.add(node.key);
  }
  for (const node of input.nodes) {
    if (!validArchitectureReview(node.architectureReview)) {
      throw new Error(`Invalid architecture reviewer for ${node.key}`);
    }
    if (!Array.isArray(node.dependsOn) || new Set(node.dependsOn).size !== node.dependsOn.length ||
        node.dependsOn.some((key) => !keys.has(key) || key === node.key)) {
      throw new Error(`Invalid dependencies for ${node.key}`);
    }
    if (node.consumeUpstream !== undefined && node.consumeUpstream !== 'direct' && node.consumeUpstream !== 'none' &&
        (!Array.isArray(node.consumeUpstream) || node.consumeUpstream.some(ref => typeof ref !== 'string' || !input.nodes.some(parent => parent.executions.some(job => `${parent.key}/${job.key}` === ref))) || new Set(node.consumeUpstream).size !== node.consumeUpstream.length)) throw new Error('Invalid upstream consumption references');
    validateExtraRepositories(node.extraRepositories);
    validateServices(node.services);
    if (node.services?.some(service => !input.nodes.some(parent => parent.executions.some(job => `${parent.key}/${job.key}` === service.input)))) throw new Error('Service input must name an approved execution');
    const gate = node.acceptance;
    if (!gate || !['automatic', 'agent', 'human'].includes(gate.mode) || !Array.isArray(gate.checks) ||
        (node.executionMode !== 'implement' && gate.checks.length === 0) || gate.checks.some((check) => !check?.trim()) ||
        (gate.mode !== 'automatic' && !gate.reviewerId?.trim())) {
      throw new Error(`Invalid acceptance gate for ${node.key}`);
    }
    if (gate.mode === 'agent' && !gate.reviewLaunchConfig) {
      throw new Error(`Agent review launch config is required for ${node.key}`);
    }
    if (gate.integrationChecks !== undefined && (!Array.isArray(gate.integrationChecks) ||
        gate.integrationChecks.some((check) => !check?.name?.trim() || !isAbsolute(check.repository) ||
          !Array.isArray(check.argv) || !check.argv.length ||
          check.argv.some((arg) => typeof arg !== 'string' || !arg.trim())))) {
      throw new Error(`Invalid integrated checks for ${node.key}`);
    }
    if (!Array.isArray(node.executions) || node.executions.length === 0) {
      throw new Error(`Node ${node.key} needs at least one repository execution`);
    }
    if (input.deliveryContract === 'agent_owned_v1' && node.executionMode !== 'implement' && gate.mode !== 'agent' &&
        !node.executions.some(job => job.key === selfCheckExecution(node))) {
      throw new Error(`Ticket ${node.key} requires an explicit selfCheckExecution from its approved executions`);
    }
    if (node.services?.length) {
      if (node.consumeUpstream === 'none') throw new Error('Services require consumed upstream input');
      if (gate.mode === 'agent') validateServiceLaunch(gate.reviewLaunchConfig);
      const architecture = effectiveArchitectureReview(input, node);
      if (architecture) validateServiceLaunch(architecture.reviewLaunchConfig);
    }
    const executionKeys = new Set<string>();
    for (const job of node.executions) {
      if (job.capabilities !== undefined) parseProjectCapabilityScope(job.capabilities);
      if (node.services?.length) validateServiceLaunch(job.launchConfig);
      if (!job.key?.trim() || !job.instructions?.trim() || executionKeys.has(job.key) || !isAbsolute(job.repository) ||
          !job.gitRef?.trim() || !/^[0-9a-f]{40,64}$/i.test(job.baseCommit) || !job.agentSelector?.trim()) {
        throw new Error(`Invalid repository execution in ${node.key}: ${job.key}`);
      }
      executionKeys.add(job.key);
    }
  }
  for (const node of input.nodes) {
    const ancestors = new Set<string>();
    const visit = (key: string) => { for (const predecessor of input.nodes.find(item => item.key === key)!.dependsOn) if (!ancestors.has(predecessor)) { ancestors.add(predecessor); visit(predecessor); } };
    // Consumption references must resolve within the approved dependency closure.
    if (Array.isArray(node.consumeUpstream) || node.services?.length) visit(node.key);
    if (node.services?.some(service => !input.nodes.some(parent => ancestors.has(parent.key) && parent.executions.some(job => `${parent.key}/${job.key}` === service.input)))) throw new Error('Service must reference an approved predecessor');
    if (Array.isArray(node.consumeUpstream)) {
      if (node.consumeUpstream.some(ref => !input.nodes.some(parent => ancestors.has(parent.key) && parent.executions.some(job => `${parent.key}/${job.key}` === ref)))) throw new Error('Consumption must reference an approved predecessor');
    }
  }
  const byKey = new Map(input.nodes.map((node) => [node.key, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function walk(key: string) {
    if (visiting.has(key)) throw new Error(`Task graph cycle at ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)!.dependsOn) walk(dependency);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of Array.from(keys)) walk(key);
  // The serialized copy is the only value persisted. Reject functions, cycles,
  // undefined and non-finite numbers rather than silently changing a plan.
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error('Task graph must be JSON serializable');
  }
  if (!serialized || JSON.stringify(JSON.parse(serialized)) !== serialized ||
      hasUnserializableValue(input)) throw new Error('Task graph contains non-JSON values');
  return JSON.parse(serialized) as GraphDefinition;
}

function hasUnserializableValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' ||
      (typeof value === 'number' && !Number.isFinite(value))) return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const invalid = Object.values(value).some((child) => hasUnserializableValue(child, seen));
  seen.delete(value);
  return invalid;
}

export function taskGraphSnapshotHash(definition: GraphDefinition): string {
  // JSONB reorders object keys; approval hashes must depend on content, while preserving array order.
  const serialized = JSON.stringify(validateTaskGraphDefinition(definition), (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    return value;
  });
  return createHash('sha256').update(serialized).digest('hex');
}

export function verificationInputs(jobs: { id: string; commit: string | null }[]) {
  return jobs.map(job => ({ executionId: job.id, commit: job.commit })).sort((a, b) => a.executionId.localeCompare(b.executionId));
}
