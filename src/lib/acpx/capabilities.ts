import type { AcpxExecutionBackend, AcpxHarnessType, HarnessCapability } from './types';

const DEFAULT_CAPABILITIES: HarnessCapability = {
  supportsQueuedUserMessages: false,
  supportsImmediateInterrupt: false,
  supportsResumeAfterInterrupt: false,
  supportsLiveSessionControl: false,
  supportsSoftStop: false,
};

export const getHarnessCapabilities = (
  harnessType: AcpxHarnessType,
  executionBackend: AcpxExecutionBackend
): HarnessCapability => {
  if (executionBackend === 'platform_local' && harnessType === 'codex') {
    return {
      supportsQueuedUserMessages: true,
      supportsImmediateInterrupt: true,
      supportsResumeAfterInterrupt: true,
      supportsLiveSessionControl: true,
      supportsSoftStop: true,
    };
  }

  if (executionBackend === 'platform_local' && harnessType === 'claude') {
    return {
      supportsQueuedUserMessages: true,
      supportsImmediateInterrupt: true,
      supportsResumeAfterInterrupt: true,
      supportsLiveSessionControl: false,
      supportsSoftStop: true,
    };
  }

  if (executionBackend === 'platform_local' && harnessType === 'deepseek') {
    return {
      supportsQueuedUserMessages: false,
      supportsImmediateInterrupt: false,
      supportsResumeAfterInterrupt: false,
      supportsLiveSessionControl: false,
      supportsSoftStop: true,
    };
  }

  if (executionBackend === 'platform_local' && harnessType === 'gemini-cli') {
    return {
      supportsQueuedUserMessages: true,
      supportsImmediateInterrupt: true,
      supportsResumeAfterInterrupt: true,
      supportsLiveSessionControl: false,
      supportsSoftStop: true,
    };
  }

  if (executionBackend === 'gateway_openclaw') {
    return {
      supportsQueuedUserMessages: true,
      supportsImmediateInterrupt: false,
      supportsResumeAfterInterrupt: false,
      supportsLiveSessionControl: false,
      supportsSoftStop: false,
    };
  }

  if (executionBackend === 'remote_ssh') {
    return {
      supportsQueuedUserMessages: true,
      supportsImmediateInterrupt: true,
      supportsResumeAfterInterrupt: harnessType === 'codex' || harnessType === 'claude',
      supportsLiveSessionControl: false,
      supportsSoftStop: true,
    };
  }

  return DEFAULT_CAPABILITIES;
};
