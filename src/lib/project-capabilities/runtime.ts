import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { executionProgress } from '../task-graph/execution-progress';
import { prisma } from '../prisma';
import { platformRepository } from '../platform-repository';
import { redactSensitiveText } from '../redact-sensitive';
import { object } from './policy';
import { projectCapabilityContext } from './context';
import { digest, privateDirectory, publishCachedImage } from './material-cache';
import { queryTableImages, tableImageReference, downloadTableImage, attachmentVersion } from './table-data';

export const capabilityRoot = () => path.join(homedir(), '.agent-platform', 'project-materials');
type Context = NonNullable<Awaited<ReturnType<typeof projectCapabilityContext>>>;
export const publicationDirectory = (context: Context, taskId: string, root = capabilityRoot()) => path.join(root, 'published', digest(JSON.stringify([taskId, context.policy.repository, context.policy.hash, context.principal])));
type RuntimeArgs = { taskId: string; workspace: string; policyFile?: string; root?: string; roomMessageId?: string; executionId?: string; allowedReadOnlyRoots?: string[] } &
  ({ taskRunId: string; platformCheck?: never } | { taskRunId?: never; platformCheck: { writerNonce: string } });
type Access = { env: Record<string, string>; readOnlyPaths: string[]; instructions: string };

/** Per-turn Unix socket: no host credentials, arbitrary URLs, send operation or network grant. */
export async function withProjectCapabilities<T>(args: RuntimeArgs, action: (access: Access) => Promise<T>) {
  const resolve = () => projectCapabilityContext(args);
  const context = await resolve();
  if (!context) return action({ env: {}, readOnlyPaths: [], instructions: '' });
  if (args.allowedReadOnlyRoots && context.policy.readOnlyRoots.some(root => !args.allowedReadOnlyRoots!.some(allowed => root === allowed || root.startsWith(allowed + path.sep)))) throw new Error('项目资料目录超出本次显式文件权限，不能增加挂载');
  const checkAuthority = args.platformCheck;
  const accessId = args.taskRunId || (checkAuthority ? `platform-check:${checkAuthority.writerNonce}` : '');
  if (!accessId) throw new Error('资料请求缺少执行身份');
  const publication = publicationDirectory(context, args.taskId, args.root);
  await privateDirectory(publication);
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'ap-cap-')), socket = path.join(directory, 'socket');
  const secret = randomBytes(32).toString('hex'), sessionId = randomUUID();
  let requests = 0, receiptSequence = 0, closing = false, serial: Promise<void> = Promise.resolve(), currentPrincipals = context.principals;
  type Selection = { query: string; cursor?: string; images: Awaited<ReturnType<typeof queryTableImages>>['records'][number]['images'] };
  const seen = new Map<string, Map<string, Selection>>();
  const record = async (kind: string, payload: object) => {
    if (context.job) await prisma.taskGraphEvent.create({ data: { runId: context.job.node.runId, nodeId: context.job.nodeId, kind,
      idempotencyKey: `project-capability:${accessId}:${sessionId}:${kind}:${receiptSequence++}`, payload: JSON.parse(JSON.stringify({ taskRunId: args.taskRunId || null, executionId: context.job.id,
        claimToken: context.job.claimToken, project: context.policy.repository, policyHash: context.policy.hash, principals: currentPrincipals, ...payload })) } });
  };
  const authorize = async () => {
    if (closing) throw new Error('本轮资料接口已关闭');
    const latest = await resolve();
    if (!latest || latest.policy.hash !== context.policy.hash || latest.principal !== context.principal || latest.job?.claimToken !== context.job?.claimToken) throw new Error('项目授权或任务归属已改变，本轮资料访问已关闭');
    currentPrincipals = latest.principals;
    if (!checkAuthority && args.taskRunId) {
      const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: args.taskRunId } });
      if (run.taskId !== args.taskId || !['running', 'pending', 'waiting_for_input'].includes(run.status)) throw new Error('资料接口不属于活动执行');
    } else {
      const progress = executionProgress(latest.job?.dispatchMetadata);
      if (!progress || !['active', 'ready'].includes(progress.state) || progress.workerReleasedAt || !checkAuthority || progress.worker?.nonce !== checkAuthority.writerNonce) throw new Error('平台检查没有当前 writer 归属');
    }
    return latest;
  };
  const handle = async (raw: unknown) => {
    await authorize();
    const request = object(raw);
    if (request.operation === 'sources') {
      if (Object.keys(request).some(key => key !== 'operation')) throw new Error('资料源列表参数无效');
      return { sources: context.policy.sources.map(source => ({ key: source.key, searchField: source.searchField, imageFields: source.imageFields })), localReadOnlyRoots: context.policy.readOnlyRoots };
    }
    const source = context.policy.sources.find(source => source.key === request.source);
    if (!source) throw new Error('资料源别名未获批准');
    if (request.operation === 'query') {
      if (Object.keys(request).some(key => !['operation', 'source', 'query', 'cursor'].includes(key)) || typeof request.query !== 'string' || request.cursor !== undefined && typeof request.cursor !== 'string') throw new Error('资料查询参数无效');
      const result = await queryTableImages(source, request.query, request.cursor);
      await authorize();
      const issued = seen.get(source.key) || new Map<string, Selection>();
      for (const row of result.records) issued.set(row.id, { query: request.query, images: row.images, ...(request.cursor ? { cursor: request.cursor } : {}) });
      seen.set(source.key, issued);
      await record('project_material_query', { source: source.key, query: request.query, responseHash: digest(JSON.stringify(result)), recordIds: result.records.map(record => record.id), hasMore: result.hasMore, cursor: request.cursor || null, nextCursor: result.cursor });
      return result;
    }
    if (request.operation !== 'image' || Object.keys(request).some(key => !['operation', 'source', 'recordId', 'field', 'index'].includes(key)) ||
      typeof request.recordId !== 'string' || typeof request.field !== 'string' || typeof request.index !== 'number' || !seen.get(source.key)?.has(request.recordId)) throw new Error('图片必须来自本轮已授权查询结果');
    const issued = seen.get(source.key)?.get(request.recordId);
    if (!issued || !(await queryTableImages(source, issued.query, issued.cursor)).records.some(record => record.id === request.recordId)) throw new Error('记录已不在原查询范围内，请重新查询');
    const reference = await tableImageReference(source, request.recordId, request.field, request.index);
    if (issued.images.find(item => item.field === request.field && item.index === request.index)?.version !== attachmentVersion(reference)) throw new Error('选中图片版本已改变，请重新查询后选择');
    await authorize();
    const image = await publishCachedImage({ cache: path.join(args.root || capabilityRoot(), 'cache'), publication,
      namespace: JSON.stringify([platformRepository(), context.policy.appId, context.policy.repository, context.principal, source]),
      version: JSON.stringify([request.recordId, request.field, reference.token, reference.size]), load: async () => (await downloadTableImage(reference)).content, beforePublish: authorize });
    await authorize();
    const provenance = { source: source.key, recordId: request.recordId, field: request.field, attachmentIndex: request.index, fileToken: reference.token, ...image };
    const receipt = path.join(publication, digest(JSON.stringify(provenance)) + '.json');
    await fs.writeFile(receipt, JSON.stringify({ kind: 'unverified_business_input', obtainedAt: new Date().toISOString(), ...provenance }), { flag: 'wx', mode: 0o400 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await record('project_material_added', { ...provenance, receipt });
    return { ...image, receipt, notice: '新增不可变资料，须核对原图；不构成独立验收通过。' };
  };
  const server = createServer((request, response) => {
    const provided = Buffer.from(request.headers.authorization || ''), expected = Buffer.from('Bearer ' + secret);
    if (closing || request.method !== 'POST' || request.url !== '/' || provided.length !== expected.length || !timingSafeEqual(provided, expected)) { response.writeHead(403).end(); return; }
    if (++requests > 40) { response.writeHead(429).end('本轮资料请求已达上限'); return; }
    const work = async () => {
      try {
        let body = '';
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 4096) throw new Error('资料请求过大'); }
        const result = await handle(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: redactSensitiveText(error instanceof Error ? error.message : String(error)) }));
      }
    };
    serial = serial.then(work, work);
  });
  server.requestTimeout = 40_000; server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => resolve()); });
    await fs.chmod(socket, 0o600);
    await record('project_capability_pinned', { publication, readOnlyRoots: context.policy.readOnlyRoots });
    const client = path.join(platformRepository(), 'scripts/project-capability-client.cjs');
    return await action({ env: { AP_PROJECT_CAPABILITY_SOCKET: socket, AP_PROJECT_CAPABILITY_TOKEN: secret }, readOnlyPaths: [directory, publication, client, ...context.policy.readOnlyRoots],
      instructions: `\n项目能力由宿主按当前任务和用户授权提供；凭据不可见。只读图集：${JSON.stringify(context.policy.readOnlyRoots)}。\n资料命令：node ${client} sources；node ${client} query <资料源别名> <查询文本> [下一页游标]；node ${client} image <别名> <查询返回的记录ID> <图片字段> <图片序号>。不要自行运行 lark-cli、传入URL或猜测授权。查询分页只代表已读范围。\n下载后返回的 path 是可直接打开的原图；新增资料有独立来源回执，不会替换旧快照。向用户展示时，在最终回复使用 Markdown 图片引用实际 path，宿主只向本任务绑定话题发送。语法示例放在代码块中。` });
  } finally {
    closing = true;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await serial;
    await fs.rm(directory, { recursive: true, force: true });
  }
}
