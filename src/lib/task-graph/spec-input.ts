import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { assertSpecPackage } from './spec-package';
import type { GraphDefinition } from './domain';

/** Materialize only approved artifacts, at the frozen commit, for cross-repository agents. */
export async function prepareGraphSpecInput(graph: GraphDefinition) {
  const spec = await assertSpecPackage(graph.specPackage);
  if (!spec) return { paths: [] as string[], instructions: '' };
  const directory = path.join(process.env.TASK_GRAPH_SPEC_INPUT_ROOT || path.join(homedir(), '.agent-platform', 'task-specs'), spec.hash);
  for (const artifact of spec.artifacts) {
    const target = path.join(directory, artifact.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await fs.writeFile(target, artifact.content, { flag: 'wx', mode: 0o400 }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (!(await fs.readFile(target)).equals(artifact.content)) throw new Error('Frozen Spec input changed');
    }
  }
  return { paths: [directory], instructions: `\n已批准 Spec 的只读副本：${path.join(directory, spec.specPath)}。原仓路径无需可读；以本副本为准。` };
}
