import { listLiveRoomCatalogAgents } from '../src/lib/live-room';

async function test() {
  console.log('Listing available agents...');
  try {
    const agents = await listLiveRoomCatalogAgents();
    console.log('Available Agent IDs:');
    agents.forEach((agent) => console.log(` - ${agent.id} (${agent.label})`));
  } catch (error) {
    console.error('Error:', error);
  }
}

test();
