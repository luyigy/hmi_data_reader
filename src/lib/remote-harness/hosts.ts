import { prisma } from '@/lib/prisma';
import { decryptToken } from '@/lib/encryption';

export interface RemoteHarnessHostRecord {
  id: string;
  label: string;
  host: string;
  port: number;
  sshUser: string;
  authType: string;
  privateKey: string | null;
  workingDirectory: string | null;
  status: string;
  viaNetwork: string;
  supportedHarnesses: string[];
}

const normalizeHarness = (value: string) => value.trim().toLowerCase();

const parseSupportedHarnesses = (value?: string | null) => {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? Array.from(
          new Set(
            parsed
              .filter((item): item is string => typeof item === 'string')
              .map(normalizeHarness)
              .filter(Boolean)
          )
        )
      : [];
  } catch {
    return [];
  }
};

export const getRemoteHarnessHostById = async (id: string): Promise<RemoteHarnessHostRecord | null> => {
  const host = await prisma.remoteHarnessHost.findUnique({
    where: { id },
  });

  if (!host) {
    return null;
  }

  return {
    id: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    sshUser: host.sshUser,
    authType: host.authType,
    privateKey: host.encryptedPrivateKey ? decryptToken(host.encryptedPrivateKey) : null,
    workingDirectory: host.workingDirectory,
    status: host.status,
    viaNetwork: host.viaNetwork,
    supportedHarnesses: parseSupportedHarnesses(host.supportedHarnesses),
  };
};
