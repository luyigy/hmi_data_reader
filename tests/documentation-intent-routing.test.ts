import assert from 'node:assert/strict';
import { resolveDocumentationTarget } from '../src/lib/live-room-messages';

const members = [
  { id: 'mentioned', canReply: true, specialty: 'general' },
  { id: 'documenter', canReply: true, specialty: 'documentation' },
];

assert.deepEqual(
  resolveDocumentationTarget({
    content: '@codex 写个 FIX 文档记录这个问题',
    mentionedAll: false,
    resolvedTargetMemberId: 'mentioned',
    members,
  }),
  { specialist: null, targetMemberId: 'mentioned' },
);

assert.equal(resolveDocumentationTarget({
  content: '现在你提交个文档，我看它会不会交给负责文档的 Agent 处理',
  mentionedAll: false,
  resolvedTargetMemberId: null,
  members,
}).targetMemberId, 'documenter');

assert.equal(resolveDocumentationTarget({
  content: '@codex 修复这个问题',
  mentionedAll: false,
  resolvedTargetMemberId: 'mentioned',
  members,
}).targetMemberId, 'mentioned');

assert.equal(resolveDocumentationTarget({
  content: '@codex 这个文档你亲自写',
  mentionedAll: false,
  resolvedTargetMemberId: 'mentioned',
  members,
}).targetMemberId, 'mentioned');

assert.equal(resolveDocumentationTarget({
  content: '@all 写个 FIX 文档记录这个问题',
  mentionedAll: true,
  resolvedTargetMemberId: null,
  members,
}).targetMemberId, null);
