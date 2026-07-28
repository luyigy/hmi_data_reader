import type { AcpxPermissionConfig } from '@/lib/acpx/types';
import type { WorkflowPermissionSnapshot } from '@/lib/workflow-execution-policy';

export const workflowPermissionSnapshotFrom = (
  permissionConfig: AcpxPermissionConfig | null,
) => {
  if (!permissionConfig) return null;
  const value = (permissionConfig as AcpxPermissionConfig & {
    workflowPermissionSnapshot?: WorkflowPermissionSnapshot;
  }).workflowPermissionSnapshot;
  return value?.configured?.preset === 'workspace' ? value : null;
};

export function WorkflowPermissionSnapshotCard({
  snapshot,
}: {
  snapshot: WorkflowPermissionSnapshot;
}) {
  const pills = [
    `configured · ${snapshot.configured.preset} · ${snapshot.configured.source}`,
    `effective · ${snapshot.effective.filesystem} · temp ${snapshot.effective.temporaryDirectory} · network ${snapshot.effective.network} · approval ${snapshot.effective.approval} · ${snapshot.effective.workdir}`,
    `enforcement · ${snapshot.enforcement.level}`,
    `exceptions · ${snapshot.exceptions.length}`,
  ];
  return (
    <>
      {pills.map((text) => (
        <span
          key={text}
          className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200"
        >
          {text}
        </span>
      ))}
      {snapshot.exceptions.map((exception) => (
        <span
          key={exception.path}
          title={exception.reason}
          className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200"
        >
          read-only · {exception.path}
        </span>
      ))}
    </>
  );
}
