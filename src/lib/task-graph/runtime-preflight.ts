import { reuseRuntimeProbes, type RuntimeProbeScope } from './runtime-probes';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactSensitiveText } from '../redact-sensitive';
import type { PriorOutputArtifact } from './prior-output-artifacts';
import { runtimeDeclaration, runtimeResourceDigest, type RuntimeResource, type RuntimeDeclarationSource } from './runtime-contract';
import type { SkillVerification } from './skill-resource-preflight';
import { prepareLegacyRuntime } from './runtime-preflight-legacy';

export type RuntimeFailure = { code: string; detail: string; action: string; owner: 'platform'; requiresUserDecision: false; affectedPaths: string[]; fingerprint: string };
export class RuntimePreparationError extends Error {
  readonly failure: RuntimeFailure;
  constructor(public readonly kind: 'missing' | 'invalid' | 'transient', detail: string, paths: string[], identity = '') {
    super(detail); this.name = 'RuntimePreparationError'; Object.setPrototypeOf(this, new.target.prototype);
    this.failure = { code: kind === 'missing' ? 'runtime_capability_missing' : kind === 'invalid' ? 'runtime_resource_invalid' : 'runtime_preflight_transient', detail: redactSensitiveText(detail),
      action: kind === 'missing' ? '在运行能力声明中绑定已获宿主授权的必需资源，并通过预检后继续' : kind === 'invalid' ? '修正运行资源声明或恢复匹配的资源，再执行预检' : '按退避策略重试运行能力预检', owner: 'platform', requiresUserDecision: false, affectedPaths: paths,
      fingerprint: createHash('sha256').update(JSON.stringify(identity ? { kind, paths, identity } : { kind, paths, detail })).digest('hex') };
  }
}
const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

/** Validate versioned capabilities within existing permissions; this function grants no new host roots. */
export type RuntimePreflightReceipt = { version: 1; identity: string; manifestHash: string; commit: string; resources: { kind: string; path: string; sha256: string; origin: RuntimeResource }[]; browserVersion?: string; skills?: SkillVerification[]; validation?: { owner: 'agent'; argv: string[] } };
export type PreparedRuntime = { identity: string; manifestHash: string; readOnlyPaths: string[]; env: Record<string, string>; instructions: string; receipt: RuntimePreflightReceipt | null; verifiedResources: RuntimePreflightReceipt['resources'] };
export async function assertRuntimeResourcesUnchanged(resources: RuntimePreflightReceipt['resources']) {
  for (const resource of resources) if (await runtimeResourceDigest(resource.path) !== resource.sha256) throw new RuntimePreparationError('invalid', '运行资源在预检后改变', [resource.path]);
}
export async function prepareDeclaredRuntime(args: { workspace: string; approvedReadOnlyRoots: string[]; outputDirectory: string; priorArtifacts?: PriorOutputArtifact[]; writerNonce?: string; sourceDeclaration?: RuntimeDeclarationSource | null; resourceWorkspace?: string; strictReadOnlyRoots?: boolean; probeScope?: RuntimeProbeScope }): Promise<PreparedRuntime> {
  const empty: PreparedRuntime = { identity: '', manifestHash: '', readOnlyPaths: [], env: {}, instructions: '', receipt: null, verifiedResources: [] };
  let declaration: Awaited<ReturnType<typeof runtimeDeclaration>>;
  try { declaration = args.sourceDeclaration === undefined ? await runtimeDeclaration(args.workspace) : args.sourceDeclaration; }
  catch (error) { throw new RuntimePreparationError('invalid', error instanceof Error ? error.message : String(error), [path.join(args.workspace, '.agent-platform/runtime.json')]); }
  if (!declaration) return empty;
  const approved = await Promise.all([args.workspace, ...args.approvedReadOnlyRoots].map(root => fs.realpath(root))).catch(error => { throw new RuntimePreparationError('invalid', `已批准运行目录不可用：${error instanceof Error ? error.message : String(error)}`, args.approvedReadOnlyRoots, declaration.manifestHash); });
  const manifestHash = declaration.manifestHash;
  const resources: { kind: string; path: string; sha256: string; origin: RuntimeResource }[] = [];
  const resolve = async (ref: RuntimeResource, kind: string) => {
    const output = ref.kind === 'output' ? args.priorArtifacts?.find(artifact => artifact.eventId === ref.eventId) : undefined;
    if (ref.kind === 'output' && !output) throw new RuntimePreparationError('missing', `尚未绑定运行资源产物事件：${ref.eventId}`, [ref.relativePath], manifestHash);
    let target: string;
    if (ref.kind === 'output') { if (!output) throw new RuntimePreparationError('missing', `尚未绑定运行资源产物事件：${ref.eventId}`, [ref.relativePath], manifestHash); target = path.join(output.directory, ref.relativePath); }
    else target = path.resolve(args.resourceWorkspace || args.workspace, ref.path);
    if (!approved.some(root => within(root, target))) throw new RuntimePreparationError('invalid', `${kind} 资源超出已批准目录：${target}`, [target], manifestHash);
    let canonical: string;
    try { canonical = await fs.realpath(target); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new RuntimePreparationError('missing', `缺少 ${kind} 资源：${target}`, [target], manifestHash); throw error; }
    if (canonical !== target || !approved.some(root => within(root, canonical))) throw new RuntimePreparationError('invalid', `${kind} 资源超出已批准目录或使用链接：${target}`, [target], manifestHash);
    const sha256 = await runtimeResourceDigest(canonical).catch(error => {
      throw new RuntimePreparationError('invalid', error instanceof Error ? error.message : String(error), [target], manifestHash);
    });
    if (sha256 !== ref.sha256) throw new RuntimePreparationError('invalid', `${kind} 资源 SHA256 与版本化声明不一致：${target}`, [target], manifestHash);
    resources.push({ kind, path: target, sha256, origin: ref }); return target;
  };
  const legacy = declaration.declaration.version === 1
    ? await prepareLegacyRuntime(args, declaration.declaration, manifestHash, approved, resources, resolve) : null;
  const env: Record<string, string> = legacy?.env || {};
  let validation: RuntimePreflightReceipt['validation'];
  if (declaration.declaration.version === 2) {
    const paths: Record<string, string> = {};
    for (const entry of declaration.declaration.resources) paths[entry.id] = await resolve(entry.resource, `资源 ${entry.id}`);
    const check = declaration.declaration.validation;
    for (const id of [check.interpreter, check.script]) {
      if (!(await fs.stat(paths[id])).isFile()) throw new RuntimePreparationError('invalid', `项目验证 ${id} 必须是固定普通文件`, [paths[id]], manifestHash);
    }
    validation = { owner: 'agent', argv: [paths[check.interpreter], paths[check.script], ...check.args] };
    env.AP_GRAPH_RUNTIME_RESOURCES_JSON = JSON.stringify(paths);
    env.AP_GRAPH_RUNTIME_VALIDATION_JSON = JSON.stringify(validation);
  }
  const identity = createHash('sha256').update(JSON.stringify({ manifestHash, resources: resources.map(({ kind, sha256, origin }) => ({ kind, sha256, origin })) })).digest('hex');
  env.AP_GRAPH_RUNTIME_IDENTITY = identity;
  const probeIdentity = createHash('sha256').update(JSON.stringify({ identity, resources })).digest('hex');
  const verified = legacy ? await reuseRuntimeProbes(args.probeScope, probeIdentity, async () => {
    const result = await legacy.verify(identity);
    for (const resource of resources) if (await runtimeResourceDigest(resource.path) !== resource.sha256) throw new RuntimePreparationError('invalid', '运行资源在预检期间改变', [resource.path], identity);
    return result;
  }) : { skills: [] };
  for (const resource of resources) if (await runtimeResourceDigest(resource.path) !== resource.sha256) throw new RuntimePreparationError('invalid', '运行资源在预检期间改变', [resource.path], identity);
  const receipt: RuntimePreflightReceipt = { version: 1, identity, manifestHash, commit: declaration.commit, resources,
    ...(verified.browserVersion ? { browserVersion: verified.browserVersion } : {}), ...(verified.skills.length ? { skills: verified.skills } : {}), ...(validation ? { validation } : {}) };
  await fs.writeFile(path.join(args.outputDirectory, `runtime-preflight-${identity}.json`), JSON.stringify(receipt, null, 2) + '\n');
  return { identity, manifestHash, readOnlyPaths: approved.filter(root => root !== args.workspace).concat(resources.map(resource => resource.path)), env, receipt, verifiedResources: resources,
    instructions: legacy ? `\n运行资源身份 ${identity}。` + legacy.instructions : `\n项目运行资源已核验路径授权和 SHA256，身份 ${identity}，声明提交 ${declaration.commit}；这不代表项目环境验证通过。` +
      `实施者 Agent 在当前隔离环境执行项目验证 argv=${JSON.stringify(validation?.argv)}（也见 AP_GRAPH_RUNTIME_VALIDATION_JSON）；资源路径见 AP_GRAPH_RUNTIME_RESOURCES_JSON。` +
      '验证同样遵循任务权限、Writer 和预算，资源及源仓只读，报告写本阶段输出目录。将固定候选、实际解释器、依赖版本、运行资源身份和输出日志纳入自测证据及 environmentFingerprint；缺依赖如实报告 environment_failed，不伪造通过。平台不执行或重复运行该项目验证。' };
}
