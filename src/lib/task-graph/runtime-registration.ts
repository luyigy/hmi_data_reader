import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseRuntimeDeclaration } from './runtime-contract';

/** Host registration declares existing tools; permissions remain in runtime-environments or workflow approval. */
export function hostRuntimeRegistration(repository: string, file = path.join(process.cwd(), 'config/runtime-resources.json')) {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  if (realpathSync(file) !== file) throw new Error('Host runtime registration must use a canonical file');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime-resources must map exact primary repository paths to declarations');
  const raw: unknown = Reflect.get(value, repository);
  if (raw === undefined) return null;
  const runtime = parseRuntimeDeclaration(raw);
  const resources = [...(runtime.browser ? [runtime.browser.module, runtime.browser.executable] : []), ...(runtime.ocr ? [runtime.ocr.weights] : [])];
  if (resources.some(resource => resource.kind !== 'path' || !path.isAbsolute(resource.path))) throw new Error('Registered runtime resources require absolute independently approved paths');
  return { runtime, registrationHash: createHash('sha256').update(text).digest('hex'), configFile: file };
}
