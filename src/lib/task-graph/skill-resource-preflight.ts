import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { wrapWithBubblewrap } from '../harness/bubblewrap';
import { redactSensitiveText } from '../redact-sensitive';
import type { SkillRequirement } from './runtime-contract';

const execute = promisify(execFile);
export type SkillVerification = { id: string; package: string; checkScript: string; output: string; exitCode: 0; dependencies: { id: string; package: string; requiredFiles: string[] }[] };

/** Uses the native sandbox builder; scripts receive no provider access or writable source. */
export async function verifySkillResource(args: {
  skill: SkillRequirement; packageRoot: string; workspace: string; readOnlyPaths: string[]; env: NodeJS.ProcessEnv; dependencies?: SkillVerification['dependencies'];
}): Promise<SkillVerification> {
  const files = Array.from(new Set([...args.skill.requiredFiles, args.skill.checkScript]));
  for (const relative of files) {
    const file = path.join(args.packageRoot, relative);
    if (!(await fs.lstat(file).catch(() => null))?.isFile() || await fs.realpath(file) !== file) throw new Error(`技能必需文件缺失或不是固定普通文件：${relative}`);
  }
  const dependencies = args.dependencies || [];
  const required = dependencies.flatMap(dependency => dependency.requiredFiles.map(file => path.join(dependency.package, file)));
  for (const file of required) {
    if (!(await fs.lstat(file).catch(() => null))?.isFile() || await fs.realpath(file) !== file) throw new Error(`技能依赖必需文件缺失或不是固定普通文件：${file}`);
  }
  const script = `const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');const root=${JSON.stringify(args.packageRoot)};for(const f of ${JSON.stringify(required)})fs.readFileSync(f);for(const f of ${JSON.stringify(files)})fs.readFileSync(path.join(root,f));const r=spawnSync(process.execPath,[path.join(root,${JSON.stringify(args.skill.checkScript)})],{cwd:process.cwd(),env:process.env,encoding:'utf8',maxBuffer:65536});if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr||'skill check exit '+r.status);process.stdout.write(JSON.stringify({output:r.stdout}));`;
  const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', script], workspaceRoot: args.workspace, cwd: args.workspace,
    sandboxMode: 'read-only', networkAccess: 'restricted', strictReadOnlyRoots: true, readOnlyPaths: args.readOnlyPaths, env: args.env });
  const response = await execute(wrapped.command, wrapped.args, { cwd: args.workspace, env: args.env, timeout: 20_000, maxBuffer: 128 * 1024 });
  const result: unknown = JSON.parse(response.stdout);
  if (!result || typeof result !== 'object' || !('output' in result) || typeof result.output !== 'string') throw new Error('技能预检无有效输出');
  return { id: args.skill.id, package: args.packageRoot, checkScript: args.skill.checkScript, output: redactSensitiveText(result.output).slice(-16_000), exitCode: 0, dependencies };
}
