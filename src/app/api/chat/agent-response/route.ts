import { NextRequest, NextResponse } from 'next/server';
import { generateAgentResponse } from '@/lib/agent-responder';
import { getSocketServer } from '@/lib/websocket';
import type { AgentRef } from '@/lib/mentions';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message, agents } = body as {
      message: string;
      agents: AgentRef[];
    };

    if (!message || !agents) {
      return NextResponse.json(
        { error: 'Missing message or agents' },
        { status: 400 }
      );
    }

    // 生成 Agent 响应
    const responses = await generateAgentResponse(message, agents);

    if (responses.length === 0) {
      return NextResponse.json({ responses: [] });
    }

    // 通过 WebSocket 广播 Agent 响应
    const io = getSocketServer();
    if (io) {
      for (const response of responses) {
        io.emit('chat:agent-response', response);
      }
    }

    return NextResponse.json({ responses });
  } catch (error) {
    console.error('[API] Agent response error:', error);
    return NextResponse.json(
      { error: 'Failed to generate agent response' },
      { status: 500 }
    );
  }
}
