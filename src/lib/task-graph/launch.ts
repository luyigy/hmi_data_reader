import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveWorkspaceDirectory } from '../feishu-workspace';
import type { AcpxParticipantRequest } from '../acpx/types';
import { effectiveArchitectureReview, type GraphDefinition } from './domain';
import { assertSpecPackage } from './spec-package';
import { assertIssueSource } from './issue-source';
import { assertExistingIssueAdoption } from './issue-adoption';

const git = promisify(execFile);
const workspaceRoot = process.env.SCHEDULED_JOB_WORKSPACE_ROOTS?.split(':')[0] || '/data1/code';

type LaunchConfig = {
  participant: AcpxParticipantRequest;
  checks?: { name: string; argv: string[] }[];
};

export const validateExecutionTargets = async (definition: GraphDefinition) => {
  if (definition.adoptRun) { await assertExistingIssueAdoption(definition); return []; }
  const issueRoute = await assertIssueSource(definition.issueSource);
  if (issueRoute) {
    const byRef = new Map(issueRoute.tickets.map((ticket) => [ticket.ref, ticket.key]));
    if (definition.nodes.length !== issueRoute.tickets.length || definition.nodes.some((node) => {
      const ticket = issueRoute.tickets.find((ticket) => ticket.key === node.key);
      return !ticket || node.goal !== ticket.title || JSON.stringify([...node.dependsOn].sort()) !== JSON.stringify(ticket.blockedBy.map((ref) => byRef.get(ref)).sort())
        || node.executions.some((job) => !job.instructions.startsWith(`Issue：${ticket.ref}\n${ticket.body}\n\n本仓范围：`));
    })) throw new Error('路线目标或依赖未对应 Issue 来源，请重新生成');
  }
  if (definition.specPackage) {
    definition.specPackage.repository = await resolveWorkspaceDirectory(workspaceRoot, definition.specPackage.repository);
    await assertSpecPackage(definition.specPackage);
  }
  const participants: AcpxParticipantRequest[] = [];
  const repositories = new Map<string, string>();
  for (const node of definition.nodes) {
    const availableChecks = new Set<string>();
    const evidenceNames = [...node.acceptance.checks, 'acceptance:decision'];
    const architect = effectiveArchitectureReview(definition, node);
    if (architect) {
      evidenceNames.push('architecture:scope');
      const review = architect.reviewLaunchConfig as LaunchConfig | undefined;
      if (!review?.participant?.gatewayId || !review.participant.harnessType ||
          review.participant.executionBackend !== 'platform_local') {
        throw new Error(`${node.key}: 架构复核需要完整的本机 Agent 配置`);
      }
      participants.push(review.participant);
    }
    if ((definition.deliveryContract === 'agent_owned_v1' || node.executionMode !== 'implement') && node.acceptance.mode === 'agent') {
      const reviewer = node.acceptance.reviewLaunchConfig as LaunchConfig | undefined;
      if (!reviewer?.participant?.gatewayId || !reviewer.participant.harnessType ||
          reviewer.participant.executionBackend !== 'platform_local') {
        throw new Error(`${node.key}: Agent 验收需要完整的本机复核 Agent 配置`);
      }
      participants.push(reviewer.participant);
    }
    for (const execution of node.executions) {
      if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(execution.gitRef)
        || !/^[a-f0-9]{40}$/.test(execution.baseCommit)) {
        throw new Error(`${node.key}/${execution.key}: Git ref 或基线提交无效`);
      }
      const repository = await resolveWorkspaceDirectory(workspaceRoot, execution.repository);
      const [{ stdout: root }, { stdout: commit }] = await Promise.all([
        git('git', ['rev-parse', '--show-toplevel'], { cwd: repository }),
        git('git', ['rev-parse', '--verify', '--end-of-options', execution.gitRef], { cwd: repository }),
      ]);
      if (root.trim() !== repository || commit.trim() !== execution.baseCommit) {
        throw new Error(`${node.key}/${execution.key}: 仓库根目录或 Git 基线已变化，请重新确认排期`);
      }
      execution.repository = repository;
      const existingBase = repositories.get(repository);
      const base = `${execution.gitRef}:${execution.baseCommit}`;
      if (existingBase && existingBase !== base) {
        throw new Error(`${node.key}/${execution.key}: 同一运行内的同仓任务须使用相同起始 ref 和提交`);
      }
      repositories.set(repository, base);
      const config = execution.launchConfig as LaunchConfig | undefined;
      const participant = config?.participant;
      if (!participant || !participant.gatewayId || !participant.harnessType
        || !participant.role || participant.executionBackend !== 'platform_local') {
        throw new Error(`${node.key}/${execution.key}: 需要一个完整的本机 Agent 配置`);
      }
      if (!Array.isArray(config?.checks) || config.checks.some((check) =>
        !check?.name?.trim() || !Array.isArray(check.argv) || check.argv.length === 0 ||
        check.argv.some((arg) => typeof arg !== 'string' || !arg.trim()))) {
        throw new Error(`${node.key}/${execution.key}: 需要显式的验证命令数组`);
      }
      config.checks.forEach((check) => {
        availableChecks.add(check.name);
        evidenceNames.push(`execution:${encodeURIComponent(execution.key)}:${encodeURIComponent(check.name)}`);
      });
      participants.push(participant);
    }
    const nodeRepositories = new Set(node.executions.map((execution) => execution.repository));
    for (const check of node.acceptance.integrationChecks || []) {
      const repository = await resolveWorkspaceDirectory(workspaceRoot, check.repository);
      if (!nodeRepositories.has(repository)) throw new Error(`${node.key}: 纵向检查必须在本节点的仓库内运行`);
      check.repository = repository;
      availableChecks.add(check.name);
      evidenceNames.push(`integration:${encodeURIComponent(check.repository)}:${encodeURIComponent(check.name)}`);
    }
    if (definition.deliveryContract === 'agent_owned_v1' && new Set(evidenceNames).size !== evidenceNames.length) throw new Error(`${node.key}: 验收证据 ID 重复，请使用唯一检查名称`);
    if ((definition.deliveryContract === 'agent_owned_v1' || node.executionMode !== 'implement') && nodeRepositories.size > 1 && node.acceptance.mode !== 'human' &&
        (!node.acceptance.integrationChecks?.length ||
          node.acceptance.checks.some((check) => !node.acceptance.integrationChecks?.some((item) => item.name === check)))) {
      throw new Error(`${node.key}: 多仓自动或 Agent 验收需要覆盖所有验收项的固定版本纵向检查`);
    }
    if ((definition.deliveryContract === 'agent_owned_v1' || node.executionMode !== 'implement') && node.acceptance.checks.some((check) => !availableChecks.has(check))) {
      throw new Error(`${node.key}: 验收项必须关联至少一个仓内验证命令`);
    }
  }
  if (definition.issueSource && participants.some((participant) => !['codex', 'kimi-code'].includes(participant.harnessType))) throw new Error('本轮 Issue 路线只支持已实测的 Codex / Kimi Code 沙箱；请调整角色');
  return participants;
};

