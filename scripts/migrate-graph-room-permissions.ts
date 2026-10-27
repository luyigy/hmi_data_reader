import { prisma } from '../src/lib/prisma';
import { migrateGraphRoomPermissions } from '../src/lib/task-graph/room-permission-migration';

async function main() {
  const args = process.argv.slice(2);
  const room = args.find(arg => arg.startsWith('--room='))?.slice(7);
  if (!room || args.some(arg => !arg.startsWith('--room=') && arg !== '--apply')) throw new Error('Usage: migrate-graph-room-permissions --room=<id> [--apply]; default is dry-run');
  const apply = args.includes('--apply');
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', roomId: room, rows: await migrateGraphRoomPermissions(room, apply) }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
