# 新机台页面接驳入口

识读路径：原图 → 矫正 → OCR → 页面模板匹配 → 受控提取器 → 原屏观测。`scripts/extract_fields.py::extract_page_fields` 只负责选路；品牌和页面逻辑放在 `scripts/extract_families/`，由 `scripts/extractor_registry.py` 中的受控 ID 调用。旧模板通过 `_LEGACY_ROUTES` 兼容接入；新页面直接在模板中声明 `extractor: registered_extractor` 和 `extractor_id`，无需增加分发函数的品牌分支。

## 新页面需要交付

1. 在 `scripts/extract_families/` 增加独立提取模块。签名按注册表的 `input` 选择：`tokens, template` 或 `ocr_lines, template, meta`；确需像素证据时接受 `image_path`。返回 `fields`、`heater_columns`、`warnings`、`detail`，原屏事实放入 `detail.page_observations`。无法确认启用状态时保留 `unknown` 和证据。
2. 在 `scripts/extractor_registry.py::_EXTRACTORS` 登记固定 ID、模块、函数、输入类型、是否接收图像、支持的页面。模板不能传 Python import 路径；注册表限制可调用代码。
3. 在 `templates/<controller>/` 增加页面模板，填写 `profile_id`、`ui_family`、`page`、版式锚点、`extractor` 和 `extractor_id`。在 `contracts/profiles.json` 登记模板和页面身份。同一控制器有多版式时分别登记，锚点必须能区分；冲突应拒识。
4. 配样本与真值，完成固定 OCR、真实照片、未知/灰显状态、跨品牌路由回归；用 `scripts/export_page_package.py` 发布固定版本页面包。Model 仓接纳页面包并完成业务解释、保存重开和必要的正式写入验收，才能宣称业务可用。

示例：伯乐 B&R 射出/保压页由 `b_and_r.injection_metering` 接驳。它声明 `image_support=True`，所以像素证据由统一分发传入；其他提取器不接收无关参数。旧模板继续走兼容映射，新模板可显式声明相同 ID，两条路径输出一致。页面候选与自动预选仍由事实证据决定，注册成功不等于所有字段都可自动预选。

`page_module` 是现有页面的兼容入口；新适配优先使用受控注册 ID。旧模板缺少提取器 ID 时，兼容映射仍在 `extractor_registry.py`，不要再向 `extract_page_fields` 增加品牌判断。
