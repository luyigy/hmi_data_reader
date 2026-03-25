import { NextRequest, NextResponse } from 'next/server';
import { unstable_noStore as noStore } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { encryptToken } from '@/lib/encryption';

export const dynamic = 'force-dynamic';

const normalizeSupportedHarnesses = (value: unknown) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    )
  );

export async function GET() {
  try {
    noStore();

    const hosts = await prisma.remoteHarnessHost.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });

    return NextResponse.json(
      hosts.map((host) => ({
        id: host.id,
        label: host.label,
        host: host.host,
        port: host.port,
        sshUser: host.sshUser,
        authType: host.authType,
        workingDirectory: host.workingDirectory,
        status: host.status,
        viaNetwork: host.viaNetwork,
        supportedHarnesses: (() => {
          try {
            return host.supportedHarnesses ? JSON.parse(host.supportedHarnesses) : [];
          } catch {
            return [];
          }
        })(),
        hasPrivateKey: Boolean(host.encryptedPrivateKey),
        createdAt: host.createdAt,
        updatedAt: host.updatedAt,
      }))
    );
  } catch (error) {
    console.error('Failed to fetch remote harness hosts:', error);
    return NextResponse.json(
      { error: 'Failed to fetch remote harness hosts' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    const sshUser = typeof body.sshUser === 'string' ? body.sshUser.trim() : '';
    const privateKey = typeof body.privateKey === 'string' ? body.privateKey.trim() : '';
    const supportedHarnesses = normalizeSupportedHarnesses(body.supportedHarnesses);

    if (!label || !host || !sshUser || !privateKey || supportedHarnesses.length === 0) {
      return NextResponse.json(
        {
          error: 'label, host, sshUser, privateKey, and supportedHarnesses are required',
        },
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

    const created = await prisma.remoteHarnessHost.create({
      data: {
        label,
        host,
        port:
          typeof body.port === 'number' && Number.isFinite(body.port) && body.port > 0
            ? Math.floor(body.port)
            : 22,
        sshUser,
        authType: 'ssh_key',
        encryptedPrivateKey: encryptToken(privateKey),
        workingDirectory:
          typeof body.workingDirectory === 'string' && body.workingDirectory.trim()
            ? body.workingDirectory.trim()
            : null,
        status:
          body.status === 'online' || body.status === 'maintenance' ? body.status : 'offline',
        viaNetwork:
          body.viaNetwork === 'lan' || body.viaNetwork === 'public' ? body.viaNetwork : 'wireguard',
        supportedHarnesses: JSON.stringify(supportedHarnesses),
      },
    });

    return NextResponse.json(
      {
        id: created.id,
        label: created.label,
        host: created.host,
        port: created.port,
        sshUser: created.sshUser,
        authType: created.authType,
        workingDirectory: created.workingDirectory,
        status: created.status,
        viaNetwork: created.viaNetwork,
        supportedHarnesses,
        hasPrivateKey: Boolean(created.encryptedPrivateKey),
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Failed to create remote harness host:', error);
    return NextResponse.json(
      { error: 'Failed to create remote harness host' },
      { status: 500 }
    );
  }
}
