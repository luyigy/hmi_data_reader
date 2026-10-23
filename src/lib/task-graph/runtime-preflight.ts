import { reuseRuntimeProbes, type RuntimeProbeScope } from './runtime-probes';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { wrapWithBubblewrap } from '../harness/bubblewrap';
import { redactSensitiveText } from '../redact-sensitive';
import type { PriorOutputArtifact } from './prior-output-artifacts';
import { runtimeDeclaration, runtimeResourceDigest, type RuntimeResource, type RuntimeDeclarationSource } from './runtime-contract';
import { verifySkillResource, type SkillVerification } from './skill-resource-preflight';

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
const execute = promisify(execFile);

/** Validate versioned capabilities within existing permissions; this function grants no new host roots. */
export type RuntimePreflightReceipt = { version: 1; identity: string; manifestHash: string; commit: string; resources: { kind: string; path: string; sha256: string; origin: RuntimeResource }[]; browserVersion?: string; skills?: SkillVerification[] };
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
    const sha256 = await runtimeResourceDigest(canonical);
    if (sha256 !== ref.sha256) throw new RuntimePreparationError('invalid', `${kind} 资源 SHA256 与版本化声明不一致：${target}`, [target], manifestHash);
    resources.push({ kind, path: target, sha256, origin: ref }); return target;
  };
  const env: Record<string, string> = {};
  const skills: { skill: NonNullable<RuntimeDeclarationSource['declaration']['skills']>[number]; packageRoot: string; dependencies: { id: string; package: string; requiredFiles: string[] }[] }[] = [];
  try {
    if (declaration.declaration.ocr) {
      const ocr = declaration.declaration.ocr;
      const weights = await resolve(ocr.weights, 'OCR 权重');
      for (const file of ocr.requiredFiles) {
        const filename = path.join(weights, file);
        const required = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!required?.isFile() || await fs.realpath(filename) !== filename) throw new RuntimePreparationError('missing', `OCR 必需文件不可用：${filename}`, [filename], manifestHash);
      }
      env.AP_GRAPH_OCR_MODEL_DIR = weights;
    }
    if (declaration.declaration.browser) {
      env.AP_GRAPH_BROWSER_MODULE = await resolve(declaration.declaration.browser.module, 'Playwright 模块');
      env.AP_GRAPH_BROWSER_EXECUTABLE = await resolve(declaration.declaration.browser.executable, 'Chromium 可执行文件');
      env.TMPDIR = '/tmp';
      env.PLAYWRIGHT_MODULE = env.AP_GRAPH_BROWSER_MODULE; env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = env.AP_GRAPH_BROWSER_EXECUTABLE;
    }
    for (const skill of declaration.declaration.skills || []) {
      const packageRoot = await resolve(skill.package, `技能 ${skill.id}`);
      const hostRoots = await Promise.all(args.approvedReadOnlyRoots.map(root => fs.realpath(root)));
      if (within(args.workspace, packageRoot) || !hostRoots.includes(packageRoot)) throw new RuntimePreparationError('invalid', '技能包必须有明确的宿主只读目录授权，不能由仓内声明自授', [packageRoot], manifestHash);
      const dependencies = [];
      for (const dependency of skill.dependencies || []) {
        const directory = await resolve(dependency.package, `技能依赖 ${dependency.id}`);
        if (within(args.workspace, directory) || !hostRoots.includes(directory)) throw new RuntimePreparationError('invalid', '技能依赖必须逐包获得明确宿主只读授权', [directory], manifestHash);
        dependencies.push({ id: dependency.id, package: directory, requiredFiles: dependency.requiredFiles });
      }
      skills.push({ skill, packageRoot, dependencies });
    }
  } catch (error) {
    if (error instanceof RuntimePreparationError) throw error;
    throw new RuntimePreparationError('invalid', error instanceof Error ? error.message : String(error), resources.map(resource => resource.path), manifestHash);
  }
  const identity = createHash('sha256').update(JSON.stringify({ manifestHash, resources: resources.map(({ kind, sha256, origin }) => ({ kind, sha256, origin })) })).digest('hex');
  env.AP_GRAPH_RUNTIME_IDENTITY = identity;
  const probeIdentity = createHash('sha256').update(JSON.stringify({ identity, resources })).digest('hex');
  const verified = await reuseRuntimeProbes(args.probeScope, probeIdentity, async () => {
    let browserVersion: string | undefined;
    const skillChecks: SkillVerification[] = [];
    for (const skill of skills) {
      const probeEnv = { ...process.env, ...env, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', AP_PROJECT_REPOSITORY: args.resourceWorkspace || args.workspace, HOME: args.outputDirectory, TMPDIR: '/tmp', AP_GRAPH_OUTPUT_DIR: args.outputDirectory,
        AP_GRAPH_OUTPUT_BINDINGS_JSON: JSON.stringify([{ source: args.outputDirectory, target: args.outputDirectory, readOnly: false }]) };
      try { skillChecks.push(await verifySkillResource({ ...skill, workspace: args.workspace, readOnlyPaths: approved, env: probeEnv })); }
      catch (error) { throw new RuntimePreparationError('missing', `技能完整包预检失败：${error instanceof Error ? error.message : String(error)}`, [skill.packageRoot], identity); }
    }
    if (declaration.declaration.browser) {
      const script = 'const{chromium}=require(process.env.AP_GRAPH_BROWSER_MODULE);(async()=>{const b=await chromium.launch({headless:true,executablePath:process.env.AP_GRAPH_BROWSER_EXECUTABLE,args:["--no-sandbox","--disable-background-networking"]});try{const p=await b.newPage();await p.setContent("<title>ap-runtime-ready</title>");if(await p.title()!=="ap-runtime-ready")throw Error("browser smoke failed");process.stdout.write(JSON.stringify({version:b.version()}))}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})';
      const probeEnv = { ...process.env, ...env, ...(args.writerNonce ? { AP_GRAPH_WRITER_NONCE: args.writerNonce } : {}), AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', AP_PROJECT_REPOSITORY: args.resourceWorkspace || args.workspace, HOME: args.outputDirectory, TMPDIR: '/tmp', XDG_CACHE_HOME: args.outputDirectory, AP_GRAPH_OUTPUT_DIR: args.outputDirectory, AP_GRAPH_OUTPUT_BINDINGS_JSON: JSON.stringify([{ source: args.outputDirectory, target: args.outputDirectory, readOnly: false }]) };
      const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', script], cwd: args.workspace, workspaceRoot: args.workspace, sandboxMode: 'read-only', networkAccess: 'restricted', readOnlyPaths: approved, strictReadOnlyRoots: args.strictReadOnlyRoots, env: probeEnv });
      try {
        const result = await execute(wrapped.command, wrapped.args, { cwd: args.workspace, env: probeEnv, timeout: 20_000, maxBuffer: 128 * 1024 });
        const parsed: unknown = JSON.parse(result.stdout); if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || typeof parsed.version !== 'string') throw new Error('浏览器预检没有有效回执'); browserVersion = parsed.version;
      } catch (error) {
        const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
        const timedOut = error && typeof error === 'object' && Reflect.get(error, 'killed') === true;
        const transient = timedOut || ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(String(code));
        throw new RuntimePreparationError(transient ? 'transient' : 'missing', `浏览器启动预检失败：${String(error && typeof error === 'object' && Reflect.get(error, 'stderr') || (error instanceof Error ? error.message : error)).slice(-4000)}`, resources.map(resource => resource.path), identity);
      }
    }
    for (const resource of resources) if (await runtimeResourceDigest(resource.path) !== resource.sha256) throw new RuntimePreparationError('invalid', '运行资源在预检期间改变', [resource.path], identity);
    return { ...(browserVersion ? { browserVersion } : {}), skills: skillChecks };
  });
  for (const resource of resources) if (await runtimeResourceDigest(resource.path) !== resource.sha256) throw new RuntimePreparationError('invalid', '运行资源在预检期间改变', [resource.path], identity);
  const receipt: RuntimePreflightReceipt = { version: 1, identity, manifestHash, commit: declaration.commit, resources, ...(verified.browserVersion ? { browserVersion: verified.browserVersion } : {}), ...(verified.skills.length ? { skills: verified.skills } : {}) };
  await fs.writeFile(path.join(args.outputDirectory, `runtime-preflight-${identity}.json`), JSON.stringify(receipt, null, 2) + '\n');
  return { identity, manifestHash, readOnlyPaths: approved.filter(root => root !== args.workspace).concat(resources.map(resource => resource.path)), env, receipt, verifiedResources: resources,
    instructions: `\n运行能力已按${declaration.origin === 'host_registration' ? '平台显式登记' : '仓内版本化声明'}预检，资源身份 ${identity}。浏览器和 OCR 路径见 AP_GRAPH_RUNTIME_* / AP_GRAPH_BROWSER_* / AP_GRAPH_OCR_MODEL_DIR；这些资源只读，缓存和报告写本阶段输出目录。` +
      (verified.skills.length ? `\n本次可用技能包：${JSON.stringify(skills.map(({ skill, packageRoot, dependencies }) => ({ id: skill.id, path: packageRoot, entrypoints: skill.requiredFiles.filter(file => path.basename(file) === 'SKILL.md'), dependencies })))}` : '') };
}
