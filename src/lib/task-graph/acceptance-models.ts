import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { loadKimiCodeModelCatalog } from '../real-agents/kimi-code-model-catalog';
import { loadCodexModelCatalog } from '../codex-model-catalog';
import type { AcpxParticipantRequest } from '../acpx/types';
import type { GraphDefinition, GraphNode } from './domain';

type Model = { harness: string; selection: string; model: string };
export type AcceptanceModels = { version: 1; implementations: (Model & { execution: string })[]; reviewer: Model };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const name = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value) ? value : undefined;

/** Use the same shared config as prepareGraphHarnessRuntime; never return provider credentials. */
export async function resolveGraphModel(participant: AcpxParticipantRequest): Promise<Model> {
  const harness = participant.harnessType;
  if (participant.executionBackend !== 'platform_local' || !['codex', 'kimi-code'].includes(harness)) throw new Error('独立验收模型无法解析：需要已支持的本机运行器');
  const home = harness === 'codex' ? process.env.CODEX_HOME || path.join(homedir(), '.codex')
    : process.env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code');
  let config: Record<string, unknown> = {};
  try { config = parse(await readFile(path.join(home, 'config.toml'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('独立验收模型配置无法读取或解析'); }
  const profile = harness === 'codex' && typeof config.profile === 'string' ? record(record(config.profiles)[config.profile]) : {};
  const selection = name(participant.model ?? (harness === 'codex' ? profile.model ?? config.model : config.default_model));
  if (!selection) throw new Error('独立验收模型未知：请明确配置实施和验收模型');
  if (harness === 'codex') {
    if (!(await loadCodexModelCatalog()).some(model => model.id === selection)) throw new Error(`独立验收模型不可用：${selection} 不在运行器目录中`);
    return { harness, selection, model: selection.toLowerCase() };
  }
  if (!Object.hasOwn(await loadKimiCodeModelCatalog(), selection)) throw new Error(`独立验收模型不可用：${selection} 不在运行器目录中`);
  const configured = record(record(config.models)[selection]);
  const provider = name(configured.provider), model = name(configured.model);
  if (!model || !provider || !Object.keys(record(record(config.providers)[provider])).length) throw new Error(`独立验收模型未知或不可用：${selection} 未解析到已配置的模型和供应商`);
  // Compare the actual model, not the Kimi alias or provider name (both can point at the same model).
  return { harness, selection, model: model.toLowerCase() };
}

function participant(config: unknown): AcpxParticipantRequest {
  const value = record(config).participant;
  if (!value || typeof value !== 'object') throw new Error('独立验收缺少运行配置');
  return value as AcpxParticipantRequest;
}

export async function resolveAcceptanceModels(node: GraphNode): Promise<AcceptanceModels> {
  const implementations = await Promise.all(node.executions.map(async job => ({ execution: job.key, ...await resolveGraphModel(participant(job.launchConfig)) })));
  const reviewer = await resolveGraphModel(participant(node.acceptance.reviewLaunchConfig));
  if (implementations.some(item => item.model === reviewer.model)) throw new Error(`${node.key}: 独立验收不能使用同模型，请选择不同模型的验收者`);
  return { version: 1, implementations, reviewer };
}

/** Pin before hashing a proposal; approval and dispatch only verify the approved binding. */
export async function configureAcceptanceModels(graph: GraphDefinition, mode: 'pin' | 'verify' = 'pin') {
  if (graph.deliveryContract !== 'agent_owned_v1' || graph.adoptRun) return;
  for (const node of graph.nodes) {
    if (node.executionMode === 'implement' || node.acceptance.mode !== 'agent') {
      if (mode === 'pin') delete node.acceptance.models;
      continue;
    }
    const models = await resolveAcceptanceModels(node);
    if (mode === 'verify') {
      if (!isDeepStrictEqual(models, node.acceptance.models)) throw new Error(`${node.key}: 实施/验收模型已变化或未固定，请重新配置并确认路线`);
    } else {
      node.executions.forEach((job, i) => { participant(job.launchConfig).model = models.implementations[i].selection; });
      participant(node.acceptance.reviewLaunchConfig).model = models.reviewer.selection;
      node.acceptance.models = models;
    }
  }
}

export async function assertAcceptanceModels(node: GraphNode) {
  // Previously approved snapshots have no binding and retain their original contract.
  if (node.acceptance.models && !isDeepStrictEqual(await resolveAcceptanceModels(node), node.acceptance.models)) {
    throw new Error(`${node.key}: 已批准的实施/验收模型发生漂移，停止派发`);
  }
}
