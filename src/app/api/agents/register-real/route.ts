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
        antigravity: status.antigravity.available,
        codex: status.codex.available,
        claude: status.claude.available,
        'claude-haha': status['claude-haha'].available,
        deepseek: status.deepseek.available,
        'gemini-cli': status['gemini-cli'].available,
        'pi-agent': status['pi-agent'].available,
      },
      versions: {
        antigravity: status.antigravity.version,
        codex: status.codex.version,
        claude: status.claude.version,
        'claude-haha': status['claude-haha'].version,
        deepseek: status.deepseek.version,
        'gemini-cli': status['gemini-cli'].version,
        'pi-agent': status['pi-agent'].version,
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
    const { type, name } = body as { type: 'antigravity' | 'codex' | 'claude' | 'claude-haha' | 'deepseek' | 'gemini-cli' | 'pi-agent'; name?: string };

    if (!type || (type !== 'antigravity' && type !== 'codex' && type !== 'claude' && type !== 'claude-haha' && type !== 'deepseek' && type !== 'gemini-cli' && type !== 'pi-agent')) {
      return NextResponse.json(
        { error: 'Invalid real agent type' },
        { status: 400 }
      );
    }

    const status = await getRealAgentsStatus();
    if (!status[type].available) {
      return NextResponse.json(
        { error: `${type} is not available. Please ensure it is installed and configured.` },
        { status: 400 }
      );
    }

    // 注册 Agent
    const agentName = name || (
      type === 'antigravity'
        ? 'Antigravity Agent'
        : type === 'codex'
        ? 'Codex Agent'
        : type === 'deepseek'
        ? 'DeepSeek Agent'
        : type === 'gemini-cli'
        ? 'Gemini Agent'
        : type === 'pi-agent'
        ? 'Pi Agent'
        : type === 'claude-haha'
        ? 'Claude Haha Agent'
        : 'Claude Code Agent'
    );
    
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
