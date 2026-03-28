const path = require('path');
const Module = require('module');

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true,
    allowJs: true,
  },
});

const projectRoot = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    const mapped = path.join(projectRoot, 'src', request.slice(2));
    return originalResolveFilename.call(this, mapped, parent, isMain, options);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const {
  startFeishuLongConnectionRuntime,
} = require(path.join(projectRoot, 'src/lib/feishu-long-connection.ts'));

async function main() {
  process.on('unhandledRejection', (error) => {
    console.error('[FeishuRuntime] unhandledRejection', error);
  });
  process.on('uncaughtException', (error) => {
    console.error('[FeishuRuntime] uncaughtException', error);
  });

  const status = await startFeishuLongConnectionRuntime();
  console.log('[FeishuRuntime] started', status);
}

main().catch((error) => {
  console.error('[FeishuRuntime] failed to start', error);
  process.exit(1);
});
