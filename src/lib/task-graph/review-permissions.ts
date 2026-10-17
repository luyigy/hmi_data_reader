import type { AcpxPermissionConfig } from '../acpx/types';

export const taskGraphAgentReviewPermissionConfig: AcpxPermissionConfig = {
  profile: 'custom',
  sandboxMode: 'read-only',
  networkAccess: 'enabled',
  approvalPolicy: 'never',
  writableRoots: [],
};
