/** Read only the selected native Pi directory on the execution host. */
export function piSizeProbeCommand(sessionId: string, windows = false): string {
  const encoded = Buffer.from(sessionId).toString('base64');
  const source = `
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
let dir=Buffer.from('${encoded}','base64').toString('utf8');
if(dir.startsWith('$HOME/')||dir.startsWith('~/')) dir=path.join(os.homedir(),dir.slice(dir.indexOf('/')+1));
let result=null;
try {
  if(!path.isAbsolute(dir)||fs.lstatSync(dir).isSymbolicLink()) throw Error('unsafe directory');
  const root=fs.realpathSync(dir),st=fs.statSync(root),files={};
  const names=fs.readdirSync(root).filter(n=>n.endsWith('.jsonl'));
  if(names.length>10000) throw Error('too many records');
  for(const name of names){
    const file=path.join(root,name);
    if(!fs.lstatSync(file).isFile()||path.dirname(fs.realpathSync(file))!==root) throw Error('unsafe record');
    const fd=fs.openSync(file,'r');
    try {
      const info=fs.fstatSync(fd),buf=Buffer.alloc(65536);
      if(!info.isFile()) throw Error('not a file');
      const header=JSON.parse(buf.subarray(0,fs.readSync(fd,buf,0,buf.length,0)).toString('utf8').split('\\n')[0]);
      if(header.type!=='session'||typeof header.id!=='string'||!header.id) throw Error('invalid header');
      files[name]={bytes:info.size,identity:info.dev+':'+info.ino,nativeId:header.id};
    } finally { fs.closeSync(fd); }
  }
  result={bytes:Object.values(files).reduce((n,f)=>n+f.bytes,0),identity:st.dev+':'+st.ino,files};
} catch(error) {
  try {fs.lstatSync(dir);} catch(missing) {if(missing.code==='ENOENT') result={missing:true};}
}
console.log(JSON.stringify(result));`;
  const js = `eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString('utf8'))`;
  if (windows) {
    const ps = `& node -e '${js.replace(/'/g, "''")}'`;
    return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(ps, 'utf16le').toString('base64');
  }
  const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  return 'bash -lc ' + quote('export PATH="$HOME/.local/node/bin:$PATH"; node -e ' + quote(js));
}

interface Snapshot {
  bytes: number;
  identity: string;
  files: Record<string, { bytes: number; identity: string; nativeId: string }>;
}
type Probe = Snapshot | { missing: true } | null;
const bytes = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function parseProbe(raw: string): Probe {
  const value = JSON.parse(raw);
  if (value?.missing === true) return { missing: true };
  if (!value || !bytes(value.bytes) || typeof value.identity !== 'string' || !value.files || typeof value.files !== 'object') return null;
  if (!Object.values(value.files).every(f => f && typeof f === 'object' && 'bytes' in f && bytes(f.bytes) &&
    'identity' in f && typeof f.identity === 'string' && 'nativeId' in f && typeof f.nativeId === 'string' && !!f.nativeId)) return null;
  return value;
}

export async function withRemotePiSessionSize<T>(options: {
  read: () => Promise<string>;
  nativeSessionId: () => string | undefined;
  publish: (size: { totalBytes: number; deltaBytes?: number }) => void | Promise<void>;
  execute: () => Promise<T>;
}): Promise<T> {
  const read = async () => { try { return parseProbe(await options.read()); } catch { return null; } };
  const before = await read();
  try { return await options.execute(); }
  finally {
    try {
      const after = await read();
      const nativeId = options.nativeSessionId();
      if (after && 'bytes' in after && nativeId) {
        const matches = Object.entries(after.files).filter(([, file]) => file.nativeId === nativeId);
        if (matches.length === 1) {
          const [name, current] = matches[0];
          const prior = before && 'bytes' in before ? before.files[name] : undefined;
          const same = before && 'bytes' in before && before.identity === after.identity &&
            prior?.nativeId === nativeId && prior.identity === current.identity && current.bytes >= prior.bytes;
          const isNew = before && ('missing' in before || ('bytes' in before && before.identity === after.identity &&
            !Object.values(before.files).some(file => file.nativeId === nativeId)));
          const deltaBytes = same && prior ? current.bytes - prior.bytes : isNew ? current.bytes : undefined;
          await options.publish({ totalBytes: current.bytes, ...(deltaBytes === undefined ? {} : { deltaBytes }) });
        }
      }
    } catch { /* Telemetry must not replace the native result or failure. */ }
  }
}
