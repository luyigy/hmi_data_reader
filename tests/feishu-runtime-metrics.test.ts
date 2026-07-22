import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFeishuRuntimeMetrics } from '../src/lib/feishu-runtime-status';

test('classifies runaway thread and SQLite descriptor counts', () => {
  assert.equal(classifyFeishuRuntimeMetrics(20, 3), 'healthy');
  assert.equal(classifyFeishuRuntimeMetrics(100, 3), 'warning');
  assert.equal(classifyFeishuRuntimeMetrics(20, 25), 'warning');
  assert.equal(classifyFeishuRuntimeMetrics(396, 350), 'critical');
});
