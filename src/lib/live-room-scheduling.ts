const ROLE_ORDER: Record<string, number> = {
  planner: 0,
  researcher: 1,
  implementer: 2,
  reviewer: 3,
  tester: 4,
  custom: 5,
};

export const shouldRunRoleQueue = (mode: string, content: string) =>
  mode === 'execution' || (mode === 'hybrid' && /^\/run(?:\s|$)/i.test(content.trim()));

export const orderMembersByRole = <T extends { role?: string | null; sortOrder?: number }>(
  members: T[]
) => [...members].sort((left, right) => {
  const roleDifference =
    (ROLE_ORDER[left.role || 'custom'] ?? ROLE_ORDER.custom)
    - (ROLE_ORDER[right.role || 'custom'] ?? ROLE_ORDER.custom);
  return roleDifference || (left.sortOrder || 0) - (right.sortOrder || 0);
});
