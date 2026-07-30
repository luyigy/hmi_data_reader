import assert from 'node:assert/strict';
import { resolveFeishuCardActionIdentity } from '../src/lib/feishu-card-action';

assert.deepEqual(resolveFeishuCardActionIdentity({
  operator: { open_id: 'v2-admin' },
  context: { open_chat_id: 'v2-chat', open_message_id: 'v2-message' },
}), { openId: 'v2-admin', chatId: 'v2-chat', messageId: 'v2-message' });

assert.deepEqual(resolveFeishuCardActionIdentity({
  open_id: 'legacy-admin',
  open_message_id: 'legacy-message',
}), { openId: 'legacy-admin', chatId: undefined, messageId: 'legacy-message' });
