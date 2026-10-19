import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { imageType, readAuthorizedImage } from './image-file';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function privateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw new Error('资料目录不能包含符号链接');
}
/** Only selected bytes are published. The shared cache itself is never mounted in a sandbox. */
export async function publishCachedImage(args: { cache: string; publication: string; namespace: string; version: string; load: () => Promise<Buffer>; beforePublish: () => Promise<unknown> }) {
  const directory = path.join(args.cache, digest(args.namespace)); await privateDirectory(directory);
  await privateDirectory(args.publication);
  const key = digest(args.version), receipt = path.join(directory, key + '.json');
  let sha256: string | undefined, extension: string | undefined, content: Buffer | undefined;
  const stored = await fs.readFile(receipt, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stored) {
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object' || !('sha256' in value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !('extension' in value) || typeof value.extension !== 'string' || !['png', 'jpg', 'gif', 'webp'].includes(value.extension)) throw new Error('资料缓存回执损坏');
    sha256 = value.sha256; extension = value.extension;
    content = (await readAuthorizedImage(path.join(directory, `${sha256}.${extension}`), [directory])).content;
    if (digest(content) !== sha256) throw new Error('资料缓存内容与摘要不一致');
  } else {
    content = await args.load();
    if (!content.length || content.length > 20 * 1024 * 1024) throw new Error('资料图片大小无效');
    extension = imageType(content).extension; sha256 = digest(content);
    const target = path.join(directory, `${sha256}.${extension}`);
    await fs.writeFile(target, content, { flag: 'wx', mode: 0o400 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (digest((await readAuthorizedImage(target, [directory])).content) !== sha256) throw new Error('缓存同名内容发生变化');
    const temporary = receipt + '.' + randomUUID();
    await fs.writeFile(temporary, JSON.stringify({ sha256, extension }), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, receipt);
  }
  const source = path.join(directory, `${sha256}.${extension}`), filename = path.join(args.publication, `${sha256}.${extension}`);
  await args.beforePublish();
  try { await fs.link(source, filename); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error)) throw error;
    if (error.code === 'EXDEV') await fs.copyFile(source, filename, constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
    else if (error.code !== 'EEXIST') throw error;
  }
  if (digest((await readAuthorizedImage(filename, [args.publication])).content) !== sha256) throw new Error('资料发布文件身份不一致');
  return { path: filename, sha256, bytes: content.length };
}
