import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export async function resolveWorkspaceRoot(input: string) {
  const value = input.trim();
  if (!path.isAbsolute(value)) throw new Error('授权根目录必须是绝对路径。');
  const resolved = await realpath(value).catch(() => { throw new Error(`路径不存在：${value}`); });
  if (!(await stat(resolved)).isDirectory()) throw new Error(`路径不是目录：${value}`);
  return resolved;
}

export async function resolveWorkspaceDirectory(root: string, input?: string) {
  const resolvedRoot = await resolveWorkspaceRoot(root);
  const requested = input?.trim();
  const resolved = requested
    ? await realpath(path.isAbsolute(requested) ? requested : path.resolve(resolvedRoot, requested))
        .catch(() => { throw new Error(`工作目录不存在：${requested}`); })
    : resolvedRoot;
  if (!(await stat(resolved)).isDirectory()) throw new Error(`工作路径不是目录：${requested}`);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`工作目录必须位于授权根目录内：${resolvedRoot}`);
  }
  return resolved;
}
