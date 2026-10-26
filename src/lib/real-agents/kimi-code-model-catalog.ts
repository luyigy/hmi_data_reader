import { execFile } from 'child_process';
import { promisify } from 'util';

export async function loadKimiCodeModelCatalog(cwd?: string | null) {
  let catalog: { models?: Record<string, { displayName?: string; capabilities?: string[]; supportEfforts?: string[]; defaultEffort?: string }> };
  try {
    const { stdout } = await promisify(execFile)(process.env.KIMI_CODE_CLI_PATH?.trim() || 'kimi', ['provider', 'list', '--json'], {
      cwd: cwd || undefined, timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    catalog = JSON.parse(stdout);
    if (!catalog.models || typeof catalog.models !== 'object' || !Object.keys(catalog.models).length) throw new Error('Empty catalog');
  } catch {
    throw new Error('无法读取本机 Kimi 模型目录（CLI 不支持、查询超时或返回异常）。');
  }

  return catalog.models;
}

export async function listKimiCodeModels(cwd?: string | null): Promise<string> {
  const models = await loadKimiCodeModelCatalog(cwd);
  const rows = Object.entries(models).map(([alias, model]) => {
    const efforts = Array.isArray(model.supportEfforts) && model.supportEfforts.length
      ? model.supportEfforts.join(' / ')
      : model.capabilities?.includes('always_thinking') ? '始终思考（未列出档位）'
        : model.capabilities?.includes('thinking') ? '支持思考（未列出档位）' : '未报告思考能力';
    return `${alias}${model.displayName ? ` (${model.displayName})` : ''}：${efforts}${model.defaultEffort ? `；默认 ${model.defaultEffort}` : ''}`;
  });
  return `本机 Kimi 已配置模型及 CLI 报告的思考档位（实际授权可能不同）\n${rows.join('\n')}\n当前 /ap model-config 对 Kimi 仅支持 --model，不支持 --thinking。`;
}
