import assert from 'node:assert/strict';
import { resolveFeishuCardActionIdentity } from '../src/lib/feishu-card-action';

assert.deepEqual(resolveFeishuCardActionIdentity({
  operator: { open_id: 'v2-admin' },
  context: { open_message_id: 'v2-message' },
}), { openId: 'v2-admin', messageId: 'v2-message' });

assert.deepEqual(resolveFeishuCardActionIdentity({
  open_id: 'legacy-admin',
  open_message_id: 'legacy-message',
}), { openId: 'legacy-admin', messageId: 'legacy-message' });
