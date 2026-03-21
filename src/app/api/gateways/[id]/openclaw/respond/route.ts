import { NextRequest, NextResponse } from 'next/server';
import {
  createOpenClawResponse,
  extractOpenClawText,
  getOpenClawGatewayConfig,
} from '@/lib/openclaw-client';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const {
      input,
      agentId,
      sessionKey,
      model,
    } = body;

    if (!input || typeof input !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: input' },
        { status: 400 }
      );
    }

    const config = await getOpenClawGatewayConfig(params.id);

    if (!config) {
      return NextResponse.json(
        { error: 'Gateway OpenClaw configuration is incomplete' },
        { status: 400 }
      );
    }

    const response = await createOpenClawResponse(config, {
      input,
      agentId,
      sessionKey,
      model,
    });

    return NextResponse.json({
      success: true,
      gateway: {
        id: config.gatewayId,
        name: config.gatewayName,
        url: config.baseUrl,
      },
      response,
      text: extractOpenClawText(response),
    });
  } catch (error) {
    console.error('Failed to call OpenClaw response API:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to call OpenClaw' },
      { status: 500 }
    );
  }
}
