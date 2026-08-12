import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GitRefReader,
  readWorkflowContract,
  validateWorkflowDocuments,
  WorkingTreeReader,
} from '../src/lib/scheduled-jobs/workflow-validator';

type Options = Record<string, string>;

const usage = `usage:
  npm run workflow:new -- --kind plan --title <主题> [--plan-kind phase|interrupt]
    [--directory <分支空间>] [--parent-plan <PLAN>] [--parent-slice S01] [--return-to S02]
  npm run workflow:new -- --kind handover --plan <PLAN> --slice S01 [--title <主题>]`;

const git = (cwd: string, ...args: string[]) => new Promise<string>((resolve, reject) => {
  execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || error.message));
    else resolve(stdout);
  });
});

const parseArgs = (args: string[]) => {
  const options: Options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(usage);
    options[key.slice(2)] = value;
  }
  return options;
};

const required = (options: Options, key: string) => {
  const value = options[key]?.trim();
  if (!value) throw new Error(`missing --${key}\n${usage}`);
  return value;
};

const cleanTitle = (value: string) => {
  const title = value.trim().replace(/\s+/g, '');
  if (!title || /[\\/\0\r\n]/.test(title)) throw new Error('title must be a non-empty filename-safe value');
  return title;
};

const templateBlock = (source: string, heading: string) => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`## ${escaped}\\n\\n\\\`\\\`\\\`markdown\\n([\\s\\S]*?)\\n\\\`\\\`\\\``));
  if (!match) throw new Error(`workflow template missing block: ${heading}`);
  return `${match[1]}\n`;
};

const workflowSlices = (content: string, pattern: string) => Array.from(new Set(Array.from(
  content.matchAll(new RegExp(pattern.replace(/^\(\?m\)/, ''), pattern.startsWith('(?m)') ? 'gm' : 'g')),
  (match) => match[1] ?? match[0].trim(),
))).sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));

const nextNumber = async (cwd: string, directory: string, pattern: string, width: number) => {
  await mkdir(path.resolve(cwd, directory), { recursive: true });
  const working = await readdir(path.resolve(cwd, directory));
  const tracked = (await git(cwd, 'ls-tree', '-r', '--name-only', 'HEAD', '--', directory))
    .split('\n').filter((file) => path.posix.dirname(file) === directory).map((file) => path.posix.basename(file));
  const filename = new RegExp(pattern.replace(/\(\?P<[^>]+>/g, '('));
  const maximum = Array.from(new Set([...working, ...tracked])).reduce((current, file) => {
    const match = filename.exec(file);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return String(maximum + 1).padStart(width, '0');
};

export const createWorkflowDocument = async (cwd: string, args: string[]) => {
  const options = parseArgs(args);
  const kind = required(options, 'kind');
  if (!['plan', 'handover'].includes(kind)) throw new Error(`--kind must be plan or handover\n${usage}`);

  const signal = new AbortController().signal;
  const refReader = new GitRefReader(cwd, 'HEAD', signal);
  const contractPath = 'docs/workflow/workflow-contract.yaml';
  const contract = await readWorkflowContract(cwd, 'HEAD', contractPath, signal, refReader);
  const planPath = options.plan?.replace(/^\.\//, '');
  const directory = kind === 'handover'
    ? path.posix.dirname(required({ plan: planPath ?? '' }, 'plan'))
    : (options.directory?.replace(/\/$/, '') || contract.branch_spaces.root);
  if (!directory || path.isAbsolute(directory) || directory.split('/').includes('..')
    || (directory !== contract.branch_spaces.root && !directory.startsWith(`${contract.branch_spaces.root}/`))) {
    throw new Error(`workflow directory must stay inside ${contract.branch_spaces.root}`);
  }

  const number = await nextNumber(cwd, directory, contract.documents.filename_pattern, contract.numbering.width);
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  let content: string;
  let filePath: string;

  if (kind === 'plan') {
    const title = cleanTitle(required(options, 'title'));
    const planKind = options['plan-kind'] || contract.documents.plan.phase_kind;
    if (!contract.documents.plan.kinds.includes(planKind)) throw new Error(`invalid --plan-kind: ${planKind}`);
    filePath = path.posix.join(directory, `${number}_PLAN_${date}_${title}.md`);
    const templatePath = contract.templates?.plan;
    if (!templatePath) throw new Error('workflow contract missing templates.plan');
    const template = await refReader.read(templatePath);
    if (planKind === contract.documents.plan.interrupt_kind) {
      const parentPlan = required(options, 'parent-plan').replace(/^\.\//, '');
      const parentSlice = required(options, 'parent-slice');
      const returnTo = required(options, 'return-to');
      content = templateBlock(template, 'Interrupt PLAN')
        .replaceAll('docs/<父PLAN>.md', parentPlan)
        .replace('parent_slice: S01', `parent_slice: ${parentSlice}`)
        .replace('return_to: S02', `return_to: ${returnTo}`)
        .replaceAll('<编号>_PLAN_<日期>_<主题>', path.posix.basename(filePath, '.md'))
        .replace('<阻塞修复主题>', title)
        .replace('<修复 Slice>', '待填写')
        .replace('<范围与完成标准>', '请填写范围与完成标准。');
    } else {
      content = templateBlock(template, 'Phase PLAN')
        .replaceAll('<编号>_PLAN_<日期>_<主题>', path.posix.basename(filePath, '.md'))
        .replaceAll('<主题>', title)
        .replace('<首个 Slice>', '待填写')
        .replace('<范围与完成标准>', '请填写范围与完成标准。');
    }
  } else {
    const slice = required(options, 'slice');
    const normalizedPlan = required({ plan: planPath ?? '' }, 'plan');
    const planContent = await new WorkingTreeReader(cwd, 'HEAD', signal).read(normalizedPlan);
    const slices = workflowSlices(planContent, contract.documents.slice_pattern);
    const position = slices.indexOf(slice);
    if (position < 0) throw new Error(`${path.posix.basename(normalizedPlan)} does not contain ${slice}`);
    const nextSlice = slices[position + 1];
    const title = cleanTitle(options.title || `${slice}${nextSlice ? '交付' : '完成'}`);
    filePath = path.posix.join(directory, `${number}_HANDOVER_${date}_${title}.md`);
    const templatePath = contract.templates?.handover;
    if (!templatePath) throw new Error('workflow contract missing templates.handover');
    const template = await refReader.read(templatePath);
    content = templateBlock(template, nextSlice ? '继续下一 Slice' : '终止并等待验收')
      .replaceAll('docs/<本HANDOVER>.md', filePath)
      .replaceAll('docs/<PLAN>.md', normalizedPlan)
      .replace('slice: S01', `slice: ${slice}`)
      .replace(nextSlice ? '<S01 结果>' : '<完成结果>', title)
      .replace(nextSlice ? '<完成内容、验证和遗留事项>' : '<完成内容、验证、验收入口和遗留事项>', '请填写完成内容与验证结果。');
    if (nextSlice) content = content.replace('只执行 S02', `只执行 ${nextSlice}`);
  }

  try {
    const [result] = await validateWorkflowDocuments({
      cwd,
      ref: 'HEAD',
      filePaths: [filePath],
      signal,
      contentOverrides: { [filePath]: content },
      reader: new WorkingTreeReader(cwd, 'HEAD', signal),
      contractReader: refReader,
    });
    await writeFile(path.resolve(cwd, filePath), content, { flag: 'wx' });
    return { filePath, action: result.action, issues: result.issues };
  } catch (error) {
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(path.resolve(cwd, temporaryPath), content);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nscaffold retained at ${temporaryPath}`);
  }
};

async function main() {
  const result = await createWorkflowDocument(process.cwd(), process.argv.slice(2));
  console.log(`PASS ${result.filePath} action=${result.action}`);
}

if (require.main === module) void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
