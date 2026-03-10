import { NextRequest, NextResponse } from 'next/server';
import { registerRealAgent, getRealAgentsStatus } from '@/lib/real-agents';

/**
 * GET /api/agents/register-real
 * 
 * 检查可用的真实 Agent
 */
export async function GET() {
  try {
    const status = await getRealAgentsStatus();
    
    return NextResponse.json({
      available: {
        codex: status.codex.available,
        claude: status.claude.available,
      },
      versions: {
        codex: status.codex.version,
        claude: status.claude.version,
      },
    });
  } catch (error) {
    console.error('Failed to check real agents:', error);
    return NextResponse.json(
      { error: 'Failed to check real agents' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/agents/register-real
 * 
 * 注册真实 Agent 到数据库
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, name } = body as { type: 'codex' | 'claude'; name?: string };

    if (!type || (type !== 'codex' && type !== 'claude')) {
      return NextResponse.json(
        { error: 'Invalid type. Must be "codex" or "claude"' },
        { status: 400 }
      );
    }

    // 检查对应的 Agent 是否可用
    if (type === 'codex') {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      try {
        await execAsync('codex --version', { timeout: 5000 });
      } catch {
        return NextResponse.json(
          { error: 'Codex is not available. Please ensure it\'s installed and configured.' },
          { status: 400 }
        );
      }
    } else {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      try {
        await execAsync('claude --version', { timeout: 5000 });
      } catch {
        return NextResponse.json(
          { error: 'Claude Code is not available. Please ensure it\'s installed and configured.' },
          { status: 400 }
        );
      }
    }

    // 注册 Agent
    const agentName = name || (type === 'codex' ? 'Codex Agent' : 'Claude Code Agent');
    
    const agent = await registerRealAgent(agentName, type, 'local');

    return NextResponse.json({
      message: `Real agent "${agentName}" registered successfully`,
      agent,
    });
  } catch (error) {
    console.error('Failed to register real agent:', error);
    return NextResponse.json(
      { error: 'Failed to register real agent' },
      { status: 500 }
    );
  }
}
