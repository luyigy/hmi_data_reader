export type FeishuCardActionIdentity = {
  open_id?: string;
  open_message_id?: string;
  operator?: { open_id?: string };
  context?: { open_message_id?: string };
};

export const resolveFeishuCardActionIdentity = (data: FeishuCardActionIdentity) => ({
  openId: data.operator?.open_id || data.open_id,
  messageId: data.context?.open_message_id || data.open_message_id,
});
