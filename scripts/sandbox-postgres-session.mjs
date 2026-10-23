/**
 * S02 手动修复：沙箱会话启动器（宿主侧入口）。
 *
 * 职责（对应 docs/545_PLAN_20261023_运行环境修复手动执行.md 的 S02）：
 * 1. prepare：固定来源与版本地准备一次性 PostgreSQL 测试资源（zonky 完整发行包，含运行库）。
 * 2. run（默认）：用仓库自身的 sandbox 渲染器（prepareSandboxEnvironment + renderBubblewrap）
 *    在实际 Bubblewrap 沙箱内启动一次性数据库并执行选定的数据库回归，保存命令、版本、退出码与清理证据。
 *
 * 边界：只读复用父仓库 node_modules；不扩大 sandbox-env.ts 全局变量白名单；
 * 资源路径经 argv 进入沙箱；沙箱内复用阶段生命周期，再向回归子进程提供一次性连接。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourceHome = path.join(root, '.cache', 'sandbox-postgres');

/** 固定来源与版本：Maven Central zonky embedded-postgres 14.24.0（完整 bin/lib/share，自带 libcrypto/libicu）。 */
const pinned = {
  version: '14.24.0',
  postgresVersion: 'postgres (PostgreSQL) 14.24',
  jarUrl: 'https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/14.24.0/embedded-postgres-binaries-linux-amd64-14.24.0.jar',
  jarSha256: '2722d05eb22c671104c9918d59d8ba9f5656898f5452a0207bb4cce21eef5dc4',
  txzName: 'postgres-linux-x86_64.txz',
  txzSha256: 'a22637a4a9904f6a7ed42ca0849f3db96f29a6d7dc719d9da8487fe4522e5017',
};

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function prepareResources() {
  mkdirSync(resourceHome, { recursive: true });
  const jar = path.join(resourceHome, `zonky-${pinned.version}.jar`);
  const txz = path.join(resourceHome, pinned.txzName);
  const extracted = path.join(resourceHome, `pg${pinned.version}`);
  if (!existsSync(jar)) {
    console.log(`[prepare] 下载固定版本发行包 ${pinned.jarUrl}`);
    execFileSync('curl', ['-fsSL', '-o', jar, pinned.jarUrl]);
  }
  if (sha256(jar) !== pinned.jarSha256) throw new Error(`发行包 jar 校验失败: ${jar}`);
  if (!existsSync(path.join(extracted, 'bin', 'postgres'))) {
    rmSync(extracted, { recursive: true, force: true });
    mkdirSync(extracted, { recursive: true });
    execFileSync('python3', ['-c', `import zipfile; zipfile.ZipFile(${JSON.stringify(jar)}).extract(${JSON.stringify(pinned.txzName)}, ${JSON.stringify(resourceHome)})`]);
    if (sha256(txz) !== pinned.txzSha256) throw new Error('发行包内 txz 校验失败');
    execFileSync('tar', ['-xJf', txz, '-C', extracted]);
    rmSync(txz, { force: true });
  }
  const version = spawnSync(path.join(extracted, 'bin', 'postgres'), ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== pinned.postgresVersion) {
    throw new Error(`固定版本不符: ${version.stdout.trim() || version.stderr.trim()}`);
  }
  return { extracted, version: pinned.postgresVersion };
}

/** 平台 long-file 预检（loadProjectsConfig）会校验 config/projects.yaml 里声明的全部项目路径；它们必须像生产 approved read-only roots 一样在沙箱内可见。 */
function declaredProjectPaths() {
  const manifest = readFileSync(path.join(root, 'config', 'projects.yaml'), 'utf8');
  return Array.from(new Set((manifest.match(/^    path: \S+$/gm) || []).map((line) => line.slice(10)).filter(existsSync)));
}

function runSession(suites, debugSuite = false) {
  const { extracted } = prepareResources();
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}T${now.toTimeString().slice(0, 8).replaceAll(':', '')}`;
  const evidenceDir = path.join(root, 'output', 'sandbox-postgres-runs', `${stamp}-${process.pid}`);
  mkdirSync(evidenceDir, { recursive: true });
  const nodeModules = existsSync(path.join(root, 'node_modules')) ? path.join(root, 'node_modules') : undefined;
  if (!nodeModules) throw new Error('缺少 node_modules 只读复用入口（宿主软链未建立）');
  const innerScript = path.join('scripts', 'sandbox-postgres-inner.mjs');
  const launchConfig = {
    command: process.execPath,
    commandArgs: [innerScript, '--resource-dir', extracted, '--evidence-dir', evidenceDir, '--suite', ...suites, ...(debugSuite ? ['--suite-debug'] : [])],
    cwd: root,
    workspaceRoot: root,
    networkAccess: 'restricted',
    env: { AP_TASK_SANDBOX: '1', AP_PROJECT_REPOSITORY: root, PATH: process.env.PATH, HOME: '/tmp', LANG: 'C.UTF-8' },
    readOnlyPaths: [extracted, nodeModules, '/etc/passwd', '/etc/nsswitch.conf', ...declaredProjectPaths()],
  };
  const configPath = path.join(evidenceDir, 'launch-config.json');
  writeFileSync(configPath, JSON.stringify(launchConfig, null, 2));
  // 用仓库自身的沙箱渲染器编译 bwrap 命令；不复制渲染逻辑，不放宽全局变量白名单。
  const rendered = execFileSync(process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', 'scripts/sandbox-postgres-launch.ts', configPath],
    { cwd: root, encoding: 'utf8', env: { ...process.env, TS_NODE_BASEURL: '.', TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'commonjs', moduleResolution: 'node' }) } });
  const { command, args } = JSON.parse(rendered);
  writeFileSync(path.join(evidenceDir, 'bwrap-command.json'), JSON.stringify({ command, args }, null, 2));
  console.log(`[run] 沙箱会话启动: 套件 ${suites.join(',')}，证据目录 ${path.relative(root, evidenceDir)}`);
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, { cwd: root, env: launchConfig.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const bwrapLog = [];
  const capture = (stream) => (chunk) => {
    process[stream].write(chunk);
    bwrapLog.push(chunk);
  };
  child.stdout.on('data', capture('stdout'));
  child.stderr.on('data', capture('stderr'));
  child.on('close', (code, signal) => {
    const endedAt = new Date().toISOString();
    writeFileSync(path.join(evidenceDir, 'bwrap-session.log'), bwrapLog.join(''));
    writeFileSync(path.join(evidenceDir, 'session-summary.json'), JSON.stringify({
      startedAt, endedAt, bwrapExitCode: code, signal,
      suites, resourceVersion: pinned.version,
      evidence: 'evidence.json（沙箱内写入）',
    }, null, 2));
    console.log(`[run] 沙箱退出码 ${code ?? `signal:${signal}`}${code === 0 ? '' : '，详见 ' + path.relative(root, evidenceDir)}`);
    process.exitCode = code === 0 ? 0 : 1;
  });
}

const argv = process.argv.slice(2);
if (argv[0] === 'prepare') {
  const { extracted, version } = prepareResources();
  console.log(`[prepare] 资源就绪: ${extracted} (${version})`);
} else {
  const suites = (argv[0] === 'run' ? argv.slice(1) : argv).filter(Boolean).filter((value) => value !== '--debug-suite');
  const debugSuite = argv.includes('--debug-suite');
  runSession(suites.length ? suites : ['task-graph-environment-outcome'], debugSuite);
}
