import { builtinModules, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'src/lib/scheduled-jobs/generated');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'workflow-validator-build-'));
const sources = [
  'src/lib/scheduled-jobs/workflow-validator.ts',
  'scripts/validate-workflow-documents.ts',
];

try {
  for (const source of sources) {
    const target = path.join(temporary, source.replace(/\.ts$/, '.js'));
    await mkdir(path.dirname(target), { recursive: true });
    const result = ts.transpileModule(await readFile(path.join(root, source), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: source,
    });
    await writeFile(target, result.outputText);
  }
  await mkdir(outputPath, { recursive: true });
  const modules = [];
  const moduleIds = new Map();
  const addModule = (filePath) => {
    if (moduleIds.has(filePath)) return moduleIds.get(filePath);
    const id = modules.length;
    moduleIds.set(filePath, id);
    modules.push('');
    const fileRequire = createRequire(filePath);
    // ponytail: static CommonJS requires cover this validator/YAML graph; use a real bundler if dynamic imports appear.
    const source = readFileSync(filePath, 'utf8')
      .replace(/[ \t]+$/gm, '')
      .replace(/require\((['"])([^'"]+)\1\)/g, (match, _quote, request) => {
        if (request.startsWith('node:') || builtinModules.includes(request)) return match;
        const dependency = request === 'yaml' ? require.resolve('yaml') : fileRequire.resolve(request);
        return `__bundleRequire(${addModule(dependency)})`;
      });
    modules[id] = `(module, exports, __bundleRequire) => {\n${source}\n}`;
    return id;
  };
  const entry = addModule(path.join(temporary, 'scripts/validate-workflow-documents.js'));
  const bundle = `'use strict';\nconst __modules = [\n${modules.join(',\n')}\n];\n`
    + 'const __cache = [];\n'
    + 'const __bundleRequire = (id) => {\n'
    + '  if (__cache[id]) return __cache[id].exports;\n'
    + '  const module = __cache[id] = { exports: {} };\n'
    + '  __modules[id](module, module.exports, __bundleRequire);\n'
    + '  return module.exports;\n'
    + '};\n'
    + `__bundleRequire(${entry});\n`;
  await writeFile(path.join(outputPath, 'workflow-validator.cjs'), bundle);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
