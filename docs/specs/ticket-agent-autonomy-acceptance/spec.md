# Ticket Agent A/B 真实验收

部署代码 cca4049，标记 AP_AUTONOMY_E2E_20261020_cca4049。只使用两个专用仓，不恢复业务 Ticket。

父 Issue：https://gitee.com/luyi1678/agent-platform-v2/issues/IKP79K

T01：https://gitee.com/luyi1678/agent-platform-v2/issues/IKP79L

T02：https://gitee.com/luyi1678/agent-platform-v2/issues/IKP79M

T01 先等真实话题提供尺寸和颜色，正常答复、补材料和纠正沿用原实施会话；实现 makeLabel 与材料文件，检查通过后独立 Codex 验收。T02 只有 T01 通过后才消费固定交付。正式交付前不放行后继；正式交付后问答保持只读。

记录 native Session、每轮 writer/claim/revision、资源摘要和预检回执、输入 receipt、预算前后值、实际检查与验收。自动注入不能冒充真实用户。
