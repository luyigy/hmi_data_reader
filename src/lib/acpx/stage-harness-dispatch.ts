import type { HarnessAdapter, HarnessExecutionContext, HarnessTask } from '../harness/types';
import type { AcpxParticipantRequest, AcpxRunRequest } from './types';
import { harnessContinuationInput, isGraphStageRequest } from './prompt';
import { StageExecutionRequest, W001StageContractError, type StageAuthority, type StageRuntimeContract } from './stage-execution-request';

export function stageRuntimeContract(context: HarnessExecutionContext): StageRuntimeContract {
  if (!context.permissionConfig || context.networkAccess !== context.permissionConfig.networkAccess) {
    throw new W001StageContractError('missing or inconsistent runtime permissions');
  }
  return { workingDirectory: context.workingDirectory, workspaceRoot: context.workspaceRoot,
    permissionConfig: context.permissionConfig, extraReadOnlyPaths: context.extraReadOnlyPaths || [],
    extraWritableRoots: context.extraWritableRoots || [], outputDirectory: context.taskEnvironment?.AP_GRAPH_OUTPUT_DIR || '',
    outputBindings: context.taskEnvironment?.AP_GRAPH_OUTPUT_BINDINGS_JSON || '',
    inputManifest: context.taskEnvironment?.TASK_GRAPH_UPSTREAM_INPUTS_JSON };
}

/** The only local dispatch point. Session selection cannot substitute a different stage input. */
export async function executePreparedStageHarness({ adapter, request, participant, task, context, stageRequest, authority, continuationContext }: {
  adapter: Pick<HarnessAdapter, 'execute' | 'resume'>; request: AcpxRunRequest; participant: AcpxParticipantRequest;
  task: HarnessTask; context: HarnessExecutionContext; stageRequest: StageExecutionRequest | null; authority: StageAuthority | null;
  continuationContext?: Parameters<typeof harnessContinuationInput>[3];
}) {
  if (isGraphStageRequest(request) && !stageRequest) throw new W001StageContractError('missing current stage request');
  if (stageRequest) {
    if (!authority) throw new W001StageContractError('missing fresh stage authority');
    const runtime = stageRuntimeContract(context);
    stageRequest.assertMatches({ authority, runtime });
  }
  const continuing = adapter.resume && (participant.resumeSessionId || participant.resumeThreadId);
  const message = stageRequest ? stageRequest.prompt : harnessContinuationInput(request,
    continuing ? participant : { ...participant, continuationMessage: undefined }, task.description || '', continuationContext);
  const currentTask = { ...task, description: message };
  return continuing && adapter.resume
    ? adapter.resume({ task: currentTask, context, sessionId: participant.resumeSessionId || participant.resumeThreadId || '', continuationMessage: message })
    : adapter.execute({ task: currentTask, context });
}
