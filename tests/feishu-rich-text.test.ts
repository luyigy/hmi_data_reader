import assert from 'node:assert/strict';
import { extractFeishuPostText } from '../src/lib/feishu-post-text';

assert.equal(
  extractFeishuPostText({
    title: '试模结果',
    content: [[
      { tag: 'text', text: '请分析这组参数' },
      { tag: 'at', user_name: '科学试模助手', user_id: 'ou_bot' },
      { tag: 'a', text: '查看详情', href: 'https://example.com' },
    ]],
  }),
  '试模结果\n请分析这组参数\n@科学试模助手\n查看详情',
);

assert.equal(
  extractFeishuPostText({
    post: { zh_cn: { title: '', content: [[{ tag: 'text', text: '兼容多语言外层' }]] } },
  }),
  '兼容多语言外层',
);
