import { provisionNode } from '@/lib/remote-node-registry';

const readOption = (name: string) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const nodeName = readOption('node');
const token = readOption('token');
if (!nodeName || !token) throw new Error('Usage: npm run remote-runner:register -- --node <name> --token <secret>');

void provisionNode(nodeName, token).then(() => console.log(`Provisioned remote node: ${nodeName}`));
