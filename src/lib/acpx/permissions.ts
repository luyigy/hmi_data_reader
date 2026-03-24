import type { AcpxPermissionConfig } from './types';

export const DEFAULT_ACPX_PERMISSION_CONFIG: AcpxPermissionConfig = {
  profile: 'safe_local',
  sandboxMode: 'workspace-write',
  networkAccess: 'restricted',
  approvalPolicy: 'never',
  writableRoots: [],
};

export const normalizeAcpxPermissionConfig = (
  value: Partial<AcpxPermissionConfig> | null | undefined
): AcpxPermissionConfig => {
  const sandboxMode =
    value?.sandboxMode === 'read-only'
    || value?.sandboxMode === 'workspace-write'
    || value?.sandboxMode === 'danger-full-access'
      ? value.sandboxMode
      : DEFAULT_ACPX_PERMISSION_CONFIG.sandboxMode;

  const networkAccess =
    value?.networkAccess === 'enabled'
      ? 'enabled'
      : 'restricted';

  const approvalPolicy =
    value?.approvalPolicy === 'on-request'
      ? 'on-request'
      : 'never';

  const writableRoots = Array.isArray(value?.writableRoots)
    ? Array.from(new Set(
        value!.writableRoots
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.startsWith('/'))
      ))
    : [];

  const requestedProfile =
    value?.profile === 'safe_local'
    || value?.profile === 'dev_local'
    || value?.profile === 'full_access'
    || value?.profile === 'custom'
      ? value.profile
      : null;

  const detectedProfile =
    sandboxMode === 'workspace-write'
    && networkAccess === 'restricted'
    && approvalPolicy === 'never'
    && writableRoots.length === 0
      ? 'safe_local'
      : sandboxMode === 'workspace-write'
      && networkAccess === 'enabled'
      && approvalPolicy === 'on-request'
      ? 'dev_local'
      : sandboxMode === 'danger-full-access'
      && networkAccess === 'enabled'
      && approvalPolicy === 'on-request'
      ? 'full_access'
      : 'custom';

  return {
    profile: requestedProfile === 'custom' ? 'custom' : requestedProfile ?? detectedProfile,
    sandboxMode,
    networkAccess,
    approvalPolicy,
    writableRoots,
  };
};

export const getPermissionProfileLabel = (profile: AcpxPermissionConfig['profile']) =>
  profile === 'safe_local'
    ? 'Safe Local'
    : profile === 'dev_local'
    ? 'Dev Local'
    : profile === 'full_access'
    ? 'Full Access'
    : 'Custom';
