import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { within } from './policy';

export function imageType(content: Buffer) {
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: 'png' };
  if (content[0] === 255 && content[1] === 216 && content[2] === 255) return { mime: 'image/jpeg', extension: 'jpg' };
  if (/^GIF8[79]a$/.test(content.subarray(0, 6).toString('ascii'))) return { mime: 'image/gif', extension: 'gif' };
  if (content.subarray(0, 4).toString() === 'RIFF' && content.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  throw new Error('只允许 PNG、JPEG、GIF 或 WebP 图片');
}

export async function readAuthorizedImage(filename: string, roots: string[]) {
  const canonical = await fs.realpath(filename);
  if (canonical !== path.resolve(filename) || !roots.some(root => within(root, canonical))) throw new Error('图片路径不属于本任务获准目录');
  const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (await fs.realpath(`/proc/self/fd/${handle.fd}`) !== canonical) throw new Error('图片目录在打开时发生变化');
    if (!info.isFile() || !info.size || info.size > 20 * 1024 * 1024) throw new Error('图片必须是非空普通文件且不超过20MB');
    const content = await handle.readFile();
    if (content.length !== info.size || content.length > 20 * 1024 * 1024) throw new Error('图片读取期间发生变化');
    return { canonical, content, ...imageType(content) };
  } finally { await handle.close(); }
}
