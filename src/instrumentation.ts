import { ensureFeishuLongConnectionStarted } from '@/lib/feishu-long-connection';

export async function register() {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  try {
    await ensureFeishuLongConnectionStarted();
  } catch (error) {
    console.error('Failed to start Feishu long connection:', error);
  }
}
