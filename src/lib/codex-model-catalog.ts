import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type CodexCatalogModel = { id: string; efforts: string[]; defaultEffort: string | null };

export async function loadCodexModelCatalog(cwd?: string | null): Promise<CodexCatalogModel[]> {
  try {
    const { stdout } = await promisify(execFile)('codex', ['debug', 'models'], {
      cwd: cwd || undefined, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    });
    const data = JSON.parse(stdout);
    if (!Array.isArray(data.models)) throw new Error('Invalid catalog');
    const models = data.models.filter((model: any) => model.visibility === 'list').map((model: any) => {
      if (typeof model.slug !== 'string' || !Array.isArray(model.supported_reasoning_levels)
        || !model.supported_reasoning_levels.every((level: any) => typeof level?.effort === 'string')) {
        throw new Error('Invalid catalog model');
      }
      return { id: model.slug, efforts: model.supported_reasoning_levels.map((level: any) => level.effort),
        defaultEffort: typeof model.default_reasoning_level === 'string' ? model.default_reasoning_level : null };
    });
    if (!models.length) throw new Error('Empty catalog');
    return models;
  } catch {
    // Do not expose CLI stderr: it may contain local configuration or credentials.
    throw new Error('无法读取本机 Codex 模型目录（CLI 不支持、查询超时或返回异常）。配置未修改，请稍后重试。');
  }
}

export function validateCodexCatalogSelection(models: CodexCatalogModel[], model: string | null, effort: string | null) {
  if (!model) {
    if (effort) throw new Error('模型正在继承默认值，无法确定对应档位。请同时指定 --model=<模型ID>，或用 --thinking=inherit 一起恢复继承。');
    return;
  }
  const selected = models.find(item => item.id === model);
  if (!selected) throw new Error(`模型不在当前 Codex 可选目录中：${model}。请先用 --list 查询；自定义供应商模型需先由运行器目录提供。`);
  if (effort && !selected.efforts.includes(effort)) {
    throw new Error(`${model} 不支持思考档位 ${effort}。支持：${selected.efforts.join(' / ') || '无'}；或使用 inherit。`);
  }
}

export function formatCodexModelCatalog(models: CodexCatalogModel[]) {
  return [
    '本机 Codex 模型目录（运行器报告；不保证供应商授权或实时可用性）',
    ...models.map(model => `${model.id}：${model.efforts.join(' / ') || '无思考档位'}（默认：${model.defaultEffort || '未报告'}）`),
    '配置：/ap codex-config --agent=<成员名> --model=<模型ID> --thinking=<档位>',
    '恢复继承：/ap codex-config --agent=<成员名> --model=inherit --thinking=inherit',
  ].join('\n');
}
