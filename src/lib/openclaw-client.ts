import { decryptToken } from '@/lib/encryption';
import { prisma } from '@/lib/prisma';

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export interface OpenClawGatewayConfig {
  gatewayId: string;
  gatewayName: string;
  baseUrl: string;
  token: string;
}

export interface OpenClawResponseRequest {
  input: string;
  agentId?: string;
  sessionKey?: string;
  model?: string;
}

export async function getOpenClawGatewayConfig(
  gatewayId: string
): Promise<OpenClawGatewayConfig | null> {
  const gateway = await prisma.gateway.findUnique({
    where: { id: gatewayId },
    select: {
      id: true,
      name: true,
      url: true,
      openclawToken: true,
    },
  });

  if (!gateway?.url || !gateway.openclawToken) {
    return null;
  }

  return {
    gatewayId: gateway.id,
    gatewayName: gateway.name,
    baseUrl: gateway.url,
    token: decryptToken(gateway.openclawToken),
  };
}

export async function checkOpenClawHealth(config: OpenClawGatewayConfig) {
  const response = await fetch(joinUrl(config.baseUrl, '/health'), {
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`OpenClaw health check failed with HTTP ${response.status}`);
  }

  return response.json();
}

export async function createOpenClawResponse(
  config: OpenClawGatewayConfig,
  request: OpenClawResponseRequest
) {
  const agentId = request.agentId || 'main';
  const model = request.model || `openclaw:${agentId}`;

  const body: Record<string, string> = {
    model,
    input: request.input,
  };

  if (request.sessionKey) {
    body.user = request.sessionKey;
  }

  const response = await fetch(joinUrl(config.baseUrl, '/v1/responses'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? JSON.stringify(data.error)
        : `HTTP ${response.status}`;
    throw new Error(`OpenClaw response request failed: ${message}`);
  }

  return data;
}

export function extractOpenClawText(response: any): string {
  const output = Array.isArray(response?.output) ? response.output : [];
  const texts: string[] = [];

  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        texts.push(part.text);
      }
    }
  }

  return texts.join('\n').trim();
}
