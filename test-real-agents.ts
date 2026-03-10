/**
 * Test Real Agents Execution
 */

import { executeCodexTask, executeClaudeTask } from './src/lib/real-agents/codex-agent';

async function testAgents() {
  const testTask = {
    id: 'test-1',
    name: 'Test Task',
    description: 'This is a test task to verify agent execution',
  };

  console.log('🧪 Testing Codex...\n');
  try {
    const codexResult = await executeCodexTask(testTask);
    console.log('✅ Codex Result:', codexResult);
  } catch (error) {
    console.error('❌ Codex Error:', error);
  }

  console.log('\n🧪 Testing Claude Code...\n');
  try {
    const claudeResult = await executeClaudeTask(testTask);
    console.log('✅ Claude Result:', claudeResult);
  } catch (error) {
    console.error('❌ Claude Error:', error);
  }
}

testAgents().catch(console.error);
