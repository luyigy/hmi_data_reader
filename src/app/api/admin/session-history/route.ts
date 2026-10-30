import { cleanupReadiness } from '@/lib/session-history/readiness';
import { requireAdmin, authenticationErrorResponse } from '@/lib/auth-users';
import { listHistoryInventory } from '@/lib/session-history/inventory';
import { cleanupReceipt, executeCleanup, previewCleanup, readCleanup } from '@/lib/session-history/cleanup';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: Request) {
  try {
    const user = await requireAdmin(request);
    const search = new URL(request.url).searchParams;
    const operation = search.get('operation');
    if (operation) return json(cleanupReceipt(await readCleanup(operation, user.id)));
    const { inventory } = await listHistoryInventory();
    const harness = search.get('harness'), state = search.get('state');
    const filtered = inventory.rows.filter(row => (!harness || row.harness === harness) && (!state || row.state === state));
    const page = Math.max(0, Number.parseInt(search.get('page') || '0', 10) || 0);
    return json({ ...inventory, cleanup: await cleanupReadiness(), rows: filtered.slice(page * 50, (page + 1) * 50), page, total: filtered.length,
      summary: { count: inventory.rows.length, bytes: inventory.rows.reduce((sum, row) => sum + (row.bytes || 0), 0),
        eligible: inventory.rows.filter(row => row.state === 'eligible').length,
        eligibleBytes: inventory.rows.filter(row => row.state === 'eligible').reduce((sum, row) => sum + (row.bytes || 0), 0),
        unknown: inventory.rows.filter(row => row.bytes === null).length } });
  } catch (error) { return authenticationErrorResponse(error) || json({ error: error instanceof Error ? error.message : '查询失败' }, 500); }
}
export async function POST(request: Request) {
  try {
    const user = await requireAdmin(request);
    const origin = request.headers.get('origin');
    if (origin) {
      let sameHost = false;
      try {
        const parsed = new URL(origin);
        const host = request.headers.get('host') || new URL(request.url).host;
        sameHost = ['http:', 'https:'].includes(parsed.protocol) && parsed.host === new URL(`${parsed.protocol}//${host}`).host;
      } catch {}
      if (!sameHost) return json({ error: '拒绝跨站清理请求' }, 403);
    }
    if (Number(request.headers.get('content-length')) > 16000) return json({ error: '请求过大' }, 413);
    const text = await request.text(); if (text.length > 16000) return json({ error: '请求过大' }, 413);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (body.action === 'preview' && Array.isArray(body.keys) && body.keys.every(key => typeof key === 'string')) return json(cleanupReceipt(await previewCleanup(body.keys, user.id)));
    if (body.action === 'confirm' && body.confirmPermanent === true && typeof body.operationId === 'string') return json(cleanupReceipt(await executeCleanup(body.operationId, user.id)));
    return json({ error: '需要有效的预览或永久清理确认' }, 400);
  } catch (error) { return authenticationErrorResponse(error) || json({ error: error instanceof Error ? error.message : '清理失败' }, 409); }
}
