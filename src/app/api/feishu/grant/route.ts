import { grantRightsForRoom, verifyGrantActionToken } from '@/lib/feishu-grant';

export const dynamic = 'force-dynamic';

function renderHtml(args: {
  title: string;
  body: string;
  tone: 'success' | 'error';
}) {
  const accent = args.tone === 'success' ? '#166534' : '#991b1b';
  const bg = args.tone === 'success' ? '#f0fdf4' : '#fef2f2';

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${args.title}</title>
    <style>
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: ${bg}; color: #0f172a; }
      .wrap { max-width: 720px; margin: 0 auto; padding: 32px 20px; }
      .card { background: white; border-radius: 20px; padding: 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
      h1 { margin: 0 0 12px; font-size: 24px; color: ${accent}; }
      p { margin: 0; white-space: pre-wrap; line-height: 1.7; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>${args.title}</h1>
        <p>${args.body}</p>
      </div>
    </div>
  </body>
</html>`;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token') || '';
    const payload = verifyGrantActionToken(token);
    if (!payload) {
      return new Response(
        renderHtml({
          title: '授权链接无效',
          body: '这个授权链接已经失效，或者签名不正确。请回到 Feishu 重新发送授权卡片。',
          tone: 'error',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }
      );
    }

    const result = await grantRightsForRoom({
      roomId: payload.roomId,
      memberId: payload.memberId,
      profile: payload.profile,
    });

    return new Response(
      renderHtml({
        title: '授权成功',
        body: [
          `已授予 ${result.member.userNickname || result.member.displayName} ${payload.profile === 'full_access' ? '完全权限' : '开发权限'}。`,
          `Task: ${result.room.sourceTask?.name || '(unknown)'}`,
          `运行方式：${result.usedContinuation ? '继续原会话' : '启动新 run'}`,
          `新 run：${result.taskRunId}`,
          '',
          '这个结果已经在平台侧生效，你可以回到 Feishu 继续观察 agent 输出。',
        ].join('\n'),
        tone: 'success',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }
    );
  } catch (error) {
    return new Response(
      renderHtml({
        title: '授权失败',
        body: error instanceof Error ? error.message : 'Unknown error',
        tone: 'error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }
    );
  }
}
