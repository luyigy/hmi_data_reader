import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getRemoteHarnessHostById } from '@/lib/remote-harness/hosts';
import { probeRemoteSshHost } from '@/lib/remote-harness/ssh-executor';

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const host = await getRemoteHarnessHostById(params.id);

    if (!host) {
      return NextResponse.json(
        { error: 'Remote harness host not found' },
        { status: 404 }
      );
    }

    const probe = await probeRemoteSshHost(host);

    await prisma.remoteHarnessHost.update({
      where: { id: params.id },
      data: {
        status: probe.success ? 'online' : 'offline',
      },
    });

    return NextResponse.json({
      success: probe.success,
      host: {
        id: host.id,
        label: host.label,
        target: `${host.sshUser}@${host.host}:${host.port}`,
        workingDirectory: host.workingDirectory,
        supportedHarnesses: host.supportedHarnesses,
      },
      probe: {
        checkedAt: new Date().toISOString(),
        executionTime: probe.executionTime,
        output: probe.output,
      },
    });
  } catch (error) {
    console.error('Failed to test remote harness host:', error);

    const message = error instanceof Error ? error.message : 'Unknown error';

    await prisma.remoteHarnessHost.update({
      where: { id: params.id },
      data: {
        status: 'offline',
      },
    }).catch(() => undefined);

    return NextResponse.json(
      {
        success: false,
        error: message,
        probe: {
          checkedAt: new Date().toISOString(),
        },
      },
      { status: 500 }
    );
  }
}
