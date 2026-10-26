// Version 1 replay only. New project declarations never invoke these business probes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { wrapWithBubblewrap } from '../harness/bubblewrap';
import { verifySkillResource, type SkillVerification } from './skill-resource-preflight';
import { RuntimePreparationError, type PreparedRuntime, type prepareDeclaredRuntime } from './runtime-preflight';
import type { LegacyRuntimeDeclaration, RuntimeResource, SkillRequirement } from './runtime-contract';
const execute = promisify(execFile);
const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
export async function prepareLegacyRuntime(args: Parameters<typeof prepareDeclaredRuntime>[0], declaration: LegacyRuntimeDeclaration,
  manifestHash: string, approved: string[], resources: PreparedRuntime['verifiedResources'], resolve: (ref: RuntimeResource, kind: string) => Promise<string>) {
  const env: Record<string, string> = {};
  const skills: { skill: SkillRequirement; packageRoot: string; dependencies: { id: string; package: string; requiredFiles: string[] }[] }[] = [];
  try {
    if (declaration.postgres) await resolve(declaration.postgres.resource, 'PostgreSQL');
    if (declaration.ocr) {
      const ocr = declaration.ocr;
      const weights = await resolve(ocr.weights, 'OCR 权重');
      for (const file of ocr.requiredFiles) {
        const filename = path.join(weights, file);
        const required = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!required?.isFile() || await fs.realpath(filename) !== filename) throw new RuntimePreparationError('missing', `OCR 必需文件不可用：${filename}`, [filename], manifestHash);
      }
      env.AP_GRAPH_OCR_MODEL_DIR = weights;
    }
    if (declaration.browser) {
      env.AP_GRAPH_BROWSER_MODULE = await resolve(declaration.browser.module, 'Playwright 模块');
      env.AP_GRAPH_BROWSER_EXECUTABLE = await resolve(declaration.browser.executable, 'Chromium 可执行文件');
      env.TMPDIR = '/tmp';
      env.PLAYWRIGHT_MODULE = env.AP_GRAPH_BROWSER_MODULE; env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = env.AP_GRAPH_BROWSER_EXECUTABLE;
    }
    for (const skill of declaration.skills || []) {
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
  return { env, async verify(identity: string) {
    let browserVersion: string | undefined;
    const skillChecks: SkillVerification[] = [];
    for (const skill of skills) {
      const probeEnv = { ...process.env, ...env, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', AP_PROJECT_REPOSITORY: args.resourceWorkspace || args.workspace, HOME: args.outputDirectory, TMPDIR: '/tmp', AP_GRAPH_OUTPUT_DIR: args.outputDirectory,
        AP_GRAPH_OUTPUT_BINDINGS_JSON: JSON.stringify([{ source: args.outputDirectory, target: args.outputDirectory, readOnly: false }]) };
      try { skillChecks.push(await verifySkillResource({ ...skill, workspace: args.workspace, readOnlyPaths: approved, env: probeEnv })); }
      catch (error) { throw new RuntimePreparationError('missing', `技能完整包预检失败：${error instanceof Error ? error.message : String(error)}`, [skill.packageRoot], identity); }
    }
    if (declaration.browser) {
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
    return { ...(browserVersion ? { browserVersion } : {}), skills: skillChecks };
  }, instructions: '\n旧版运行能力已预检；浏览器和 OCR 路径见 AP_GRAPH_BROWSER_* / AP_GRAPH_OCR_MODEL_DIR。资源只读，缓存和报告写本阶段输出目录。' +
    (skills.length ? `\n本次可用技能包：${JSON.stringify(skills.map(({ skill, packageRoot, dependencies }) => ({ id: skill.id, path: packageRoot, entrypoints: skill.requiredFiles.filter(file => path.basename(file) === 'SKILL.md'), dependencies })))}` : '') };
}
