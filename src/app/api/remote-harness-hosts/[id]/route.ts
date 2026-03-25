import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { encryptToken } from '@/lib/encryption';

const normalizeSupportedHarnesses = (value: unknown) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    )
  );

const parseSupportedHarnesses = (value?: string | null) => {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const existing = await prisma.remoteHarnessHost.findUnique({
      where: { id: params.id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Remote harness host not found' },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const label = typeof body.label === 'string' ? body.label.trim() : existing.label;
    const host = typeof body.host === 'string' ? body.host.trim() : existing.host;
    const sshUser = typeof body.sshUser === 'string' ? body.sshUser.trim() : existing.sshUser;
    const privateKey = typeof body.privateKey === 'string' ? body.privateKey.trim() : '';
    const supportedHarnesses =
      typeof body.supportedHarnesses !== 'undefined'
        ? normalizeSupportedHarnesses(body.supportedHarnesses)
        : parseSupportedHarnesses(existing.supportedHarnesses);

    if (!label || !host || !sshUser || supportedHarnesses.length === 0) {
      return NextResponse.json(
        { error: 'label, host, sshUser, and supportedHarnesses are required' },
        { status: 400 }
      );
    }

    if (supportedHarnesses.includes('codex') && sshUser.toLowerCase() === 'root') {
      return NextResponse.json(
        {
          error:
            'Remote codex must use a non-root SSH user. Codex refuses dangerously-skip/bypass permission modes under root or sudo for security reasons.',
        },
        { status: 400 }
      );
    }

    const updated = await prisma.remoteHarnessHost.update({
      where: { id: params.id },
      data: {
        label,
        host,
        port:
          typeof body.port === 'number' && Number.isFinite(body.port) && body.port > 0
            ? Math.floor(body.port)
            : existing.port,
        sshUser,
        encryptedPrivateKey: privateKey ? encryptToken(privateKey) : undefined,
        workingDirectory:
          typeof body.workingDirectory === 'string'
            ? (body.workingDirectory.trim() || null)
            : existing.workingDirectory,
        status:
          body.status === 'online' || body.status === 'offline' || body.status === 'maintenance'
            ? body.status
            : existing.status,
        viaNetwork:
          body.viaNetwork === 'lan' || body.viaNetwork === 'public' || body.viaNetwork === 'wireguard'
            ? body.viaNetwork
            : existing.viaNetwork,
        supportedHarnesses: JSON.stringify(supportedHarnesses),
      },
    });

    return NextResponse.json({
      id: updated.id,
      label: updated.label,
      host: updated.host,
      port: updated.port,
      sshUser: updated.sshUser,
      authType: updated.authType,
      workingDirectory: updated.workingDirectory,
      status: updated.status,
      viaNetwork: updated.viaNetwork,
      supportedHarnesses,
      hasPrivateKey: Boolean(updated.encryptedPrivateKey),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    console.error('Failed to update remote harness host:', error);
    return NextResponse.json(
      { error: 'Failed to update remote harness host' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const existing = await prisma.remoteHarnessHost.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        label: true,
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Remote harness host not found' },
        { status: 404 }
      );
    }

    await prisma.remoteHarnessHost.delete({
      where: { id: params.id },
    });

    return NextResponse.json({
      success: true,
      id: existing.id,
      label: existing.label,
    });
  } catch (error) {
    console.error('Failed to delete remote harness host:', error);
    return NextResponse.json(
      { error: 'Failed to delete remote harness host' },
      { status: 500 }
    );
  }
}
