import assert from 'node:assert/strict';
import { FeishuProgressTracker } from '../src/lib/feishu-progress';
import { attachLiveRoomProgress } from '../src/lib/live-room-progress';

async function main() {
  const prismaModule = await import('../src/lib/prisma') as unknown as {prisma:unknown};
  prismaModule.prisma = { $queryRaw: async () => [{chatId:'chat',threadId:'thread',rootMessageId:'root'}] };
  const messages = await import('../src/lib/live-room-messages');
  Object.assign(messages, {postLiveRoomMessage:async()=>({id:'progress'})});
  const tools: string[] = [], updates: string[] = [];
  FeishuProgressTracker.prototype.onToolEvent = name => { tools.push(name); };
  FeishuProgressTracker.prototype.onSystemEvent = message => { updates.push(message); };
  FeishuProgressTracker.prototype.finalize = async () => null;
  const progress = await attachLiveRoomProgress({room:{id:'room'},participant:{id:'agy',displayName:'Antigravity',harnessType:'codex'},sourceMessage:{}});
  try {
    progress.streamCallbacks.onToolEvent!({toolName:'Read',preview:'file',emoji:'📖'});
    progress.streamCallbacks.onToolEvent!({toolName:'Bash',preview:'sleep 30',emoji:'💻'});
    assert.deepEqual(tools,['Read','Bash'],'burst tools all reach the card');
    progress.streamCallbacks.onStdoutChunk!('正在检查');
    progress.streamCallbacks.onStdoutChunk!('实际执行命令');
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.ok(updates.some(text=>text.includes('正在检查实际执行命令')),'partial text flushes while still running');
    progress.streamCallbacks.onStdoutChunk!('准备验证结果。');
  } finally { await progress.dispose('done',true); }
  assert.ok(updates.some(text=>text.includes('准备验证结果。')),'last throttled text flushes on completion');
  console.log('Live Room progress: burst tools, partial text and final flush passed');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
