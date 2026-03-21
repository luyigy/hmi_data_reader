import { NextRequest, NextResponse } from 'next/server';
import {
  createOpenClawResponse,
  extractOpenClawText,
  getOpenClawGatewayConfig,
} from '@/lib/openclaw-client';
import { prisma } from '@/lib/prisma';

interface TranscriptMessage {
  speaker: string;
  gatewayId: string | null;
  agentId: string | null;
  text: string;
}

interface PersistedChatMessage extends TranscriptMessage {
  sequence: number;
}

interface PersistedChatSession {
  id: string;
  fromGatewayId: string;
  toGatewayId: string;
  fromAgentId: string;
  toAgentId: string;
  prompt: string;
  turns: number;
  status: string;
  error?: string | null;
  messages: PersistedChatMessage[];
}

type ChatSessionRecord = {
  id: string;
};

type ChatPersistenceClient = {
  crossGatewayChatSession?: {
    findMany(args: {
      take: number;
      orderBy: { createdAt: 'desc' };
      include: { messages: { orderBy: { sequence: 'asc' } } };
    }): Promise<unknown[]>;
    create(args: {
      data: {
        fromGatewayId: string;
        toGatewayId: string;
        fromAgentId: string;
        toAgentId: string;
        prompt: string;
        turns: number;
        status: string;
      };
    }): Promise<ChatSessionRecord>;
    findUnique(args: {
      where: { id: string };
      include: { messages: { orderBy: { sequence: 'asc' } } };
    }): Promise<PersistedChatSession | null>;
    update(args: {
      where: { id: string };
      data: {
        status?: string;
        error?: string;
      };
    }): Promise<unknown>;
  };
  crossGatewayChatMessage?: {
    createMany(args: {
      data: Array<{
        sessionId: string;
        sequence: number;
        speaker: string;
        gatewayId: string | null;
        agentId: string | null;
        text: string;
      }>;
    }): Promise<unknown>;
  };
  $transaction: typeof prisma.$transaction;
};

function getChatPersistenceClient(): ChatPersistenceClient {
  return prisma as unknown as ChatPersistenceClient;
}

function hasChatPersistence(client: ChatPersistenceClient): client is Required<Pick<
  ChatPersistenceClient,
  'crossGatewayChatSession' | 'crossGatewayChatMessage'
>> &
  Pick<ChatPersistenceClient, '$transaction'> {
  return !!client.crossGatewayChatSession && !!client.crossGatewayChatMessage;
}

function buildRelayPrompt(args: {
  originalPrompt: string;
  sourceGatewayName: string;
  sourceText: string;
  targetGatewayName: string;
}): string {
  return [
    '以下是一次跨 Gateway 协作对话，请基于上下文继续回复。',
    '',
    '用户最初的问题：',
    args.originalPrompt,
    '',
    `${args.sourceGatewayName} 的最新回复：`,
    args.sourceText,
    '',
    `请以 ${args.targetGatewayName} 的身份直接回应，并延续讨论。`,
  ].join('\n');
}

function normalizeTurns(value: unknown): number {
  return value === 1 ? 1 : 2;
}

function toTranscriptMessages(messages: PersistedChatMessage[]): TranscriptMessage[] {
  return messages.map((message) => ({
    speaker: message.speaker,
    gatewayId: message.gatewayId,
    agentId: message.agentId,
    text: message.text,
  }));
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = Number(searchParams.get('limit') || '10');
    const take = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 20) : 10;
    const chatPersistence = getChatPersistenceClient();

    if (!hasChatPersistence(chatPersistence)) {
      return NextResponse.json({
        sessions: [],
        persistenceAvailable: false,
      });
    }

    const sessions = await chatPersistence.crossGatewayChatSession.findMany({
      take,
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        messages: {
          orderBy: {
            sequence: 'asc',
          },
        },
      },
    });

    return NextResponse.json({
      sessions,
      persistenceAvailable: true,
    });
  } catch (error) {
    console.error('Failed to fetch cross-gateway chat sessions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch cross-gateway chat sessions' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let sessionId: string | null = null;
  const chatPersistence = getChatPersistenceClient();
  const persistenceAvailable = hasChatPersistence(chatPersistence);

  try {
    const body = await request.json();
    const {
      sessionId: requestedSessionId,
      fromGatewayId,
      toGatewayId,
      prompt,
      fromAgentId,
      toAgentId,
      turns,
    } = body;

    if (!fromGatewayId || typeof fromGatewayId !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: fromGatewayId' },
        { status: 400 }
      );
    }

    if (!toGatewayId || typeof toGatewayId !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: toGatewayId' },
        { status: 400 }
      );
    }

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: prompt' },
        { status: 400 }
      );
    }

    if (fromGatewayId === toGatewayId) {
      return NextResponse.json(
        { error: 'fromGatewayId and toGatewayId must be different' },
        { status: 400 }
      );
    }

    const normalizedRequestedSessionId =
      typeof requestedSessionId === 'string' && requestedSessionId.trim()
        ? requestedSessionId.trim()
        : null;

    let existingSession: PersistedChatSession | null = null;
    if (normalizedRequestedSessionId) {
      if (!persistenceAvailable) {
        return NextResponse.json(
          { error: '当前环境暂不支持继续历史会话，请先重启 dev server' },
          { status: 400 }
        );
      }

      existingSession = await chatPersistence.crossGatewayChatSession.findUnique({
        where: { id: normalizedRequestedSessionId },
        include: {
          messages: {
            orderBy: {
              sequence: 'asc',
            },
          },
        },
      });

      if (!existingSession) {
        return NextResponse.json(
          { error: '指定的会话不存在' },
          { status: 404 }
        );
      }
    }

    const effectiveFromGatewayId = existingSession?.fromGatewayId || fromGatewayId;
    const effectiveToGatewayId = existingSession?.toGatewayId || toGatewayId;

    const normalizedFromAgentId =
      existingSession?.fromAgentId ||
      (typeof fromAgentId === 'string' && fromAgentId.trim() ? fromAgentId.trim() : 'main');
    const normalizedToAgentId =
      existingSession?.toAgentId ||
      (typeof toAgentId === 'string' && toAgentId.trim() ? toAgentId.trim() : 'main');
    const normalizedTurns = existingSession?.turns || normalizeTurns(turns);

    if (effectiveFromGatewayId === effectiveToGatewayId) {
      return NextResponse.json(
        { error: 'fromGatewayId and toGatewayId must be different' },
        { status: 400 }
      );
    }

    const [fromConfig, toConfig] = await Promise.all([
      getOpenClawGatewayConfig(effectiveFromGatewayId),
      getOpenClawGatewayConfig(effectiveToGatewayId),
    ]);

    if (!fromConfig) {
      return NextResponse.json(
        { error: 'Source gateway OpenClaw configuration is incomplete' },
        { status: 400 }
      );
    }

    if (!toConfig) {
      return NextResponse.json(
        { error: 'Target gateway OpenClaw configuration is incomplete' },
        { status: 400 }
      );
    }

    const persistedSessionId = existingSession
      ? existingSession.id
      : persistenceAvailable
      ? (
          await chatPersistence.crossGatewayChatSession.create({
            data: {
              fromGatewayId: effectiveFromGatewayId,
              toGatewayId: effectiveToGatewayId,
              fromAgentId: normalizedFromAgentId,
              toAgentId: normalizedToAgentId,
              prompt,
              turns: normalizedTurns,
              status: 'completed',
            },
          })
        ).id
      : null;

    sessionId = persistedSessionId;

    const existingMessages = existingSession ? toTranscriptMessages(existingSession.messages) : [];
    const newMessages: TranscriptMessage[] = [
      {
        speaker: 'user',
        gatewayId: null,
        agentId: null,
        text: prompt,
      },
    ];

    const fromResponse = await createOpenClawResponse(fromConfig, {
      input: prompt,
      agentId: normalizedFromAgentId,
      sessionKey: persistedSessionId
        ? `cross-gateway:${persistedSessionId}:from`
        : `cross-gateway:${effectiveFromGatewayId}:${effectiveToGatewayId}:from`,
    });
    const fromText = extractOpenClawText(fromResponse) || '(空回复)';

    newMessages.push({
      speaker: fromConfig.gatewayId,
      gatewayId: fromConfig.gatewayId,
      agentId: normalizedFromAgentId,
      text: fromText,
    });

    const handoffPrompt = buildRelayPrompt({
      originalPrompt: prompt,
      sourceGatewayName: fromConfig.gatewayName,
      sourceText: fromText,
      targetGatewayName: toConfig.gatewayName,
    });

    const toResponse = await createOpenClawResponse(toConfig, {
      input: handoffPrompt,
      agentId: normalizedToAgentId,
      sessionKey: persistedSessionId
        ? `cross-gateway:${persistedSessionId}:to`
        : `cross-gateway:${effectiveFromGatewayId}:${effectiveToGatewayId}:to`,
    });
    const toText = extractOpenClawText(toResponse) || '(空回复)';

    newMessages.push({
      speaker: toConfig.gatewayId,
      gatewayId: toConfig.gatewayId,
      agentId: normalizedToAgentId,
      text: toText,
    });

    if (normalizedTurns === 2) {
      const returnPrompt = buildRelayPrompt({
        originalPrompt: prompt,
        sourceGatewayName: toConfig.gatewayName,
        sourceText: toText,
        targetGatewayName: fromConfig.gatewayName,
      });

      const returnResponse = await createOpenClawResponse(fromConfig, {
        input: returnPrompt,
        agentId: normalizedFromAgentId,
        sessionKey: persistedSessionId
          ? `cross-gateway:${persistedSessionId}:return`
          : `cross-gateway:${effectiveFromGatewayId}:${effectiveToGatewayId}:return`,
      });
      const returnText = extractOpenClawText(returnResponse) || '(空回复)';

      newMessages.push({
        speaker: fromConfig.gatewayId,
        gatewayId: fromConfig.gatewayId,
        agentId: normalizedFromAgentId,
        text: returnText,
      });
    }

    const messages = [...existingMessages, ...newMessages];

    if (persistenceAvailable && persistedSessionId) {
      await chatPersistence.crossGatewayChatMessage.createMany({
        data: newMessages.map((message, index) => ({
          sessionId: persistedSessionId,
          sequence: existingMessages.length + index,
          speaker: message.speaker,
          gatewayId: message.gatewayId,
          agentId: message.agentId,
          text: message.text,
        })),
      });

      await chatPersistence.crossGatewayChatSession.update({
        where: { id: persistedSessionId },
        data: {
          status: 'completed',
        },
      });
    }

    return NextResponse.json({
      success: true,
      sessionId,
      persistenceAvailable,
      fromGateway: {
        id: fromConfig.gatewayId,
        name: fromConfig.gatewayName,
        url: fromConfig.baseUrl,
      },
      toGateway: {
        id: toConfig.gatewayId,
        name: toConfig.gatewayName,
        url: toConfig.baseUrl,
      },
      prompt: existingSession?.prompt || prompt,
      turns: normalizedTurns,
      fromAgentId: normalizedFromAgentId,
      toAgentId: normalizedToAgentId,
      messages,
    });
  } catch (error) {
    console.error('Failed to run cross-gateway chat:', error);

    if (persistenceAvailable && sessionId) {
      await chatPersistence.crossGatewayChatSession.update({
        where: { id: sessionId },
        data: {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Failed to run cross-gateway chat',
        },
      }).catch((updateError) => {
        console.error('Failed to update cross-gateway chat session:', updateError);
      });
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to run cross-gateway chat',
      },
      { status: 500 }
    );
  }
}
