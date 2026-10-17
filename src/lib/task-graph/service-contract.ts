import path from 'node:path';

/** An approved entry in a consumed delivery, never an arbitrary host command. */
export type GraphService = {
  key: string; input: string; runtime: 'python' | 'node'; entry: string;
  args: string[]; healthPath: string; startupTimeoutMs?: number;
};
export function validateServices(services: GraphService[] | undefined) {
  if (services === undefined) return;
  if (!Array.isArray(services) || services.length > 8) throw new Error('Invalid service contracts');
  const keys = new Set<string>();
  for (const service of services) {
    if (!service || !/^[a-z][a-z0-9_-]{0,39}$/.test(service.key) || keys.has(service.key) ||
        typeof service.input !== 'string' || !service.input.includes('/') || !['python', 'node'].includes(service.runtime) ||
        typeof service.entry !== 'string' || path.isAbsolute(service.entry) || service.entry.split(/[\\/]/).some(part => !part || part === '..') ||
        !Array.isArray(service.args) || service.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || /\{(?!port\}|data\})/.test(arg)) ||
        !service.args.some(arg => arg.includes('{port}')) || !service.args.some(arg => arg.includes('{data}')) ||
        !service.args.includes('127.0.0.1') || typeof service.healthPath !== 'string' || !/^\/[a-zA-Z0-9/_-]*$/.test(service.healthPath) ||
        (service.startupTimeoutMs !== undefined && (!Number.isInteger(service.startupTimeoutMs) || service.startupTimeoutMs < 100 || service.startupTimeoutMs > 120_000))) {
      throw new Error('Service requires a unique key, consumed input, relative entry, loopback host, port and isolated data arguments');
    }
    keys.add(service.key);
  }
}

export function validateServiceLaunch(value: unknown) {
  if (!value || typeof value !== 'object' || !('participant' in value)) throw new Error('Service execution requires a local native launch config');
  const participant = value.participant;
  if (!participant || typeof participant !== 'object' || !('executionBackend' in participant) || participant.executionBackend !== 'platform_local') throw new Error('Attempt services currently require platform_local; remote service transport is not configured');
}
