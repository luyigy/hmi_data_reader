'use client';

import { useState } from 'react';
import { PI_THINKING_LEVELS, normalizeMemberModelSettings, splitPiModel, joinPiModel } from '@/lib/live-room-codex-settings';

export function PiMemberModelSettings({ model, thinking, onSave }: {
  model?: string | null;
  thinking?: string | null;
  onSave: (settings: { codexModel: string; codexReasoningEffort: string }) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const selection = splitPiModel(model);
  return (
    <form className="flex w-full flex-wrap gap-2" onSubmit={async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const provider = String(data.get('provider') || '').trim();
      const modelId = String(data.get('model') || '').trim();
      setError('');
      try {
        const settings = normalizeMemberModelSettings({
          model: joinPiModel(provider, modelId),
          reasoningEffort: data.get('thinking'),
        }, 'pi-agent', 'platform_local');
        setSaving(true);
        await onSave({ codexModel: settings.model || '', codexReasoningEffort: settings.reasoningEffort || '' });
      } catch (error) {
        setError(error instanceof Error ? error.message : '保存失败');
      } finally { setSaving(false); }
    }}>
      <span className="w-full text-[11px] text-slate-500">Pi 房间默认设置，下一轮/续聊生效；留空继承运行环境或会话默认值。</span>
      <input aria-label="Pi Provider" name="provider" defaultValue={selection.provider} placeholder="Provider (inherit)" maxLength={200} className="w-36 rounded-lg border border-slate-300 px-2 py-1 text-[11px]" />
      <input aria-label="Pi 默认模型" name="model" defaultValue={selection.model} placeholder="模型 ID (inherit)" maxLength={200} className="w-48 rounded-lg border border-slate-300 px-2 py-1 text-[11px]" />
      <select aria-label="Pi 思考强度" name="thinking" defaultValue={thinking || ''} className="rounded-lg border border-slate-300 px-2 py-1 text-[11px]">
        <option value="">Thinking (inherit)</option>
        {PI_THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
      </select>
      <button type="submit" disabled={saving} className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] disabled:opacity-50">{saving ? '保存中…' : '保存 Pi 设置'}</button>
      {error ? <span role="alert" className="w-full text-xs text-red-600">{error}</span> : null}
    </form>
  );
}
