import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { forwardMoldTrialCardAction } from '../src/lib/mold-trial-card-action';


async function main() {
  const originalFetch = global.fetch;
  process.env.FEISHU_APP_SECRET = 'test-app-secret';
  global.fetch = async (input, init) => {
    assert.equal(
      input,
      'http://127.0.0.1:8010/api/integrations/feishu/trial-approval/internal-action',
    );
    const body = String(init?.body);
    const headers = init?.headers as Record<string, string>;
    const expected = createHmac('sha256', process.env.FEISHU_APP_SECRET!)
      .update(`${headers['X-Mold-Request-Timestamp']}.`)
      .update(body)
      .digest('hex');
    assert.equal(headers['X-Mold-Signature'], expected);
    assert.deepEqual(JSON.parse(body).event.action, {
      value: { trial_action: 'approve', trial_id: 'trial' },
      form_value: {},
    });
    return new Response(JSON.stringify({ toast: { type: 'success', content: '审批已处理' } }));
  };
  try {
    assert.deepEqual(
      await forwardMoldTrialCardAction({
        openId: 'ou_supervisor',
        value: { trial_action: 'approve', trial_id: 'trial' },
      }),
      { toast: { type: 'success', content: '审批已处理' } },
    );
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
