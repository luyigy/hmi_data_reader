import assert from 'node:assert/strict';
import { buildContextWatermarkWarning } from '../src/lib/acpx/prompt';

const warning = (providerUsagePercentage: number | null, hardReasons: string[] = []) =>
  buildContextWatermarkWarning({
    providerUsagePercentage,
    hardReasons,
  });

assert.equal(warning(29, ['任务室已有 164 条消息']), null);
assert.equal(warning(60), null);
assert.match(warning(75) || '', /最近观测上下文占用已达 75%/);
assert.match(warning(85) || '', /系统警告.*最近观测上下文占用已达 85%/);
assert.match(buildContextWatermarkWarning({ providerUsagePercentage: 75,
  hardReasons: [], estimatedWindow: true }) || '', /估算上下文占用已达 75%/);
assert.equal(warning(null), null);
assert.match(warning(null, ['已累计 629 条运行事件']) || '', /缺少 provider 上下文遥测.*无法确认/);
assert.doesNotMatch(warning(null, ['已累计 629 条运行事件']) || '', /严重超载|立即/);
assert.doesNotMatch(warning(null, ['已累计 629 条运行事件']) || '', /new-session/);
assert.equal(buildContextWatermarkWarning({
  providerUsagePercentage: null,
  hardReasons: ['任务室已有 164 条消息'],
  contextStatus: 'not_applicable',
}), null);

console.log('context watermark warning tests passed');

assert.match(buildContextWatermarkWarning({
  providerUsagePercentage: 85, hardReasons: [], metricKind: 'turn_input',
}) || '', /最近一次模型输入占上下文窗口已达 85%/);
