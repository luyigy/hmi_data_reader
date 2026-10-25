/** Runs inside the final mount namespace, before starting the native protocol. */
export function writableProbeCommand(roots: string[]): string[] {
  if (!roots.length) return [];
  const script = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
for(const root of ${JSON.stringify(roots)}) {
  const file=path.join(root,'.ap-write-check-'+crypto.randomUUID());
  let fd;
  try { fd=fs.openSync(file,'wx',0o600); fs.writeFileSync(fd,'approved');
    if(fs.readFileSync(file,'utf8')!=='approved') throw new Error('write readback mismatch');
  } catch(error) { console.error('Approved resource is not writable: '+root+': '+error.message); process.exitCode=73; break;
  } finally { if(fd!==undefined) { fs.closeSync(fd); fs.unlinkSync(file); } }
}`;
  return ['/bin/sh', '-c', '"$1" -e "$2" || exit $?; shift 2; exec "$@"', 'resource-write-check', process.execPath, script];
}
