# HMI 视觉微调准备

## 第二轮流程修正（2026-09-27，尚未启动）

上一轮65张确实用于梯度更新；漏接的是6张验证集与9张测试集。
训练loss下降、权重能重载只证明训练流程执行，不能代表识别效果通过。
旧67.5%为训练集严格字段召回，未惩罚485个多报字段；字段名差异与漏识别混在一起，
不能解释成文字识别准确率，也不能靠降低loss自动解决。

新入口必须显式传 `--round2`，从冻结的BF16底座重新训练双侧LoRA，默认6轮，
每轮固定种子打乱65张训练顺序。学习率1e-4、rank 8、图像边长1024保持原值，
先避免同时改动过多变量。6轮是本次实验上限，不是已证明的最佳轮数。

- 启动前核验65/6/9清单、图像与评测标注哈希、集合无完全相同图片、测试锁；
  快照写入独立输出目录。现有机台隔离检查另由 `tests.check_evaluation_sets` 完成；
  哈希隔离不替代跨来源机台别名与近重复人工审查。
- 每轮生成固定6张验证图，记录严格字段precision/recall/F1、漏项、多报、值/单位错误、
  JSON有效性与整页严格匹配；F1相同时保留较早权重。bbox及解释文本未纳入此分数。
  不做同义字段名宽松合并，不修改既有标签来迎合模型。
- `adapter/`始终保存验证F1最好的轮次，`after.json`是该权重的训练loss重载参照，
  不再生成全部65张训练预测。正式验证最多36次生成，另有训练loss前向与重载开销；
  不能用此前8003的39秒推算BF16总耗时。
- 独立重载通过后，单独执行9张锁定测试；已有test.json则拒绝重复执行。
  测试失败后保留原产物，不删除后反复调参刷分。测试结果不用于选择轮数。
- 基座小样本对照继续保留已完成的8003三张结果，不新增GPU0基座对照；
  它是INT4训练集参考，不是本轮同精度验证基线，因此不宣称严格训练收益。
- 验证标签是agent_visual_verified，测试有历史CV使用和机台别名限制；
  测试跑完也不能写成严格零历史盲测。部署前仍需用户认可效果与关键字段检查。

离线验收（不加载模型）：

```bash
python3 -m tests.check_round2_training
python3 -m tests.check_evaluation_sets
python3 -m scripts.train_small_sample --round2 --check --output output/training/round2-check
```

下面是**待执行**的阶段顺序，不会自动停服务或启动GPU。
用户此前限制GPU0使用，需先明确第二轮资源安排；本次只完成CPU检查，
每轮训练/推理切换、择优保存与独立重载尚未做GPU运行验收。
先在独立目录运行旧 `--smoke` 和对应reload验证基本更新，再运行第二轮。
旧smoke不覆盖新逐轮验证分支；首次正式验证结束必须检查该分支日志。
以下三条需分别使用 `CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`，
前一阶段成功后才进入下一阶段，输出目录ROUND2_DIR必须是新目录：

```bash
/data/venvs/hmi-unsloth/bin/python -u -m scripts.train_small_sample --round2 --epochs 6 --output ROUND2_DIR
/data/venvs/hmi-unsloth/bin/python -u -m scripts.train_small_sample --round2 --phase reload --output ROUND2_DIR
/data/venvs/hmi-unsloth/bin/python -u -m scripts.train_small_sample --round2 --phase test --output ROUND2_DIR
```

监控以本次输出目录、阶段和manifest ID集合检查完整性，不能递归混计smoke。
区分训练结束、重载通过、测试完成、效果验收通过四个状态；任何阶段不能代替下一阶段。
GitNexus impact仍被数据库43/运行时41不兼容阻断，风险UNKNOWN；已核查源码调用方。

## BF16 首轮训练（2026-09-26）

`scripts.train_small_sample` 现默认加载原始 BF16 权重，关闭 4/8-bit 量化，
只允许 GPU0；batch size 为 1，LoRA rank 8，梯度检查点，图片最长边 1024。
新增 `reserved-manifest.json` 汇总跨仓 holdout、本仓 holdout/regression 和保留图哈希。
13 张 confirmed 中 `bde2ce6c4a7e75f3` 与跨仓 holdout case-004 完全相同，
读取时明确排除，实际训练 12 张。金标原文件不改。
保留图与训练图仍有同机台来源，不能宣称按机台隔离的泛化评测；
`before.json` / `after.json` 是训练集拟合诊断，不是 holdout 准确率。

```bash
python3 -m tests.check_training_sample_isolation
/data/venvs/hmi-unsloth/bin/python -m scripts.train_small_sample --check --output output/training-prep/check-only
# 以下每次 train 都必须用新的独立目录；环境变量同时用于 train 和 reload。
CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  /data/venvs/hmi-unsloth/bin/python -u -m scripts.train_small_sample --output NEW_SMOKE_DIR --smoke
CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  /data/venvs/hmi-unsloth/bin/python -u -m scripts.train_small_sample --output NEW_SMOKE_DIR --smoke --phase reload
```

`--smoke` 保留完整答案，选择 token 最长的两张各更新一次，生成限制为 8 token；
检查数值、梯度、真实参数更新、adapter 保存与独立重载。
通过后去掉 `--smoke`，用新目录 `--epochs 3` 训练 36 步，再单独 `--phase reload`。
每步 `steps.json` 记录 loss、耗时、PyTorch 峰值 allocated/reserved 和设备空闲显存。
启动前至少 72 GiB 空闲只是准入检查，不是不会 OOM 的保证。
当前运行目录和 systemd 单元见 `output/training-prep/active-bf16-run.json`，
每个独立输出目录的日志为同路径加 `.log`；不要重复启动。

本次短步 `bf16-smoke-20260926-163735`：两次真实更新、保存、独立重载均退出 0，
最长完整序列 3750/3636 token，峰值 allocated 53.65 GiB，更新结束设备空闲约 22.43 GiB。
首轮单元 `bf16-first-20260926-164047.service` 已启动（先 before 基线，再 36 步训练，
after 对照，成功后自动独立重载）；启动不代表整轮完成，以产物和单元退出状态为准。
GPU0 的 `comfyui-h3.service` 在队列为空时临时停止；GPU1 AWQ 未操作。
GitNexus impact/detect_changes 均因数据库 43 / 运行时 41 不兼容失败，图风险 UNKNOWN；
已源码核查调用方，样本隔离离线回归、样本校验与 Python 编译检查通过。

## 原生 BF16 下载（2026-09-25）

已停止 GPU0 的 `hmi-unsloth.service`，保持 disabled；停止后 GPU0 仅占 17 MiB。
GPU1 AWQ 服务继续运行。当前仅下载原生权重，未启动 BF16 推理或训练。

ModelScope 原仓库为 `Qwen/Qwen3.8-27B`，与 Unsloth 模型卡的 base_model 一致。
原仓库配置为 `Qwen3_5ForConditionalGeneration`，text dtype 为 bfloat16，无量化配置；
Qwen3.5 是架构标识，不是此模型的版本名。固定清单提交
`e823e888ae179eb3be02c1a48899c4f828371376`，32 个文件（18 个权重分片），
共 55,586,112,539 bytes。来源：<https://modelscope.cn/models/Qwen/Qwen3.8-27B>。

```bash
python3 scripts/download_training_model.py --bf16 --check
# 已启动的后台服务；不要并发重复下载
systemctl --user show hmi-bf16-model-download.service -p ActiveState -p MainPID -p ExecMainStatus
tail -n 8 output/training-prep/bf16-download.log
cat /data/cache/modelscope/Qwen/Qwen3.8-27B/download-status.json
```

后台命令沿用下文 systemd-run 模板，但 unit 改为 `hmi-bf16-model-download`、
日志改为 `bf16-download.log`，Python 参数加 `--bf16`。下载退出后可用同样参数续传。
只有逐文件大小和 SHA256 全部验证通过才写 complete；active 时 ExecMainStatus=0
不能证明完成。保留 BNB 默认下载方式和旧权重。

已请求 AI-workforce 每 2 分钟只读监控，标记 `HMI-BF16-20260925-1716`；
消息回执及接管回复保存在 `output/training-prep/bf16-monitor-*.json`。
禁止监控端重复下载或自动启动训练/推理。
17:16 已收到匹配标记的接管确认（`om_x100b6457f1f36ca0c38b46b6679f796`），
本地核实监控进程 900774 存在，首轮日志位于
`output/training-prep/bf16-monitor.log`。Hermes 会话为 `proc_b9c909ce319f`。

标注工作包本轮重建并保留已有编辑：78 张、10 类控制器、2 张评测保留图；
3 张已有 answer 草稿，78 张仍为 needs_human_review，可训练金标为 0。
先继续核对现有草稿，再补同一布局样本和真实分组信息；不能直接将草稿用于训练。
入口：`output/training-prep/annotation-packet/index.html`。
下载离线测试、BF16 参数选择测试及标注包保护测试均通过。

## 权重下载

模型：`unsloth/Qwen3.8-27B-unsloth-bnb-4bit`（ModelScope），固定版本
`efd33fc8cf0d2973542650259250be0bf17fd3ed`，约 22.36 GB。
本机 `python3` 已安装 ModelScope，无需改动推理环境；下载不占 GPU。

```bash
python3 scripts/download_training_model.py --check
# 默认目录：/data/cache/modelscope/Qwen/Qwen3.8-27B-unsloth-bnb-4bit（已建好）
mkdir -p output/training-prep
systemd-run --user --unit=hmi-training-model-download \
  --property=WorkingDirectory=/data1/code/hmi_data_reader \
  --property=StandardOutput=append:/data1/code/hmi_data_reader/output/training-prep/download.log \
  --property=StandardError=append:/data1/code/hmi_data_reader/output/training-prep/download.log \
  /usr/bin/env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  NO_PROXY='*' no_proxy='*' MODELSCOPE_DOMAIN=www.modelscope.cn \
  /usr/bin/python3 -u scripts/download_training_model.py
systemctl --user show hmi-training-model-download.service -p MainPID --value > output/training-prep/download.pid
```

使用用户级 systemd 服务保持下载，不依赖聊天命令会话。服务运行时不要重复启动；
退出后如需续传，先执行 `systemctl --user reset-failed hmi-training-model-download.service`，
再执行上述启动命令。也可直接运行 Python 脚本续传；锁防止并发下载。失败看日志和目标目录的
`download-status.json`。进程退出但状态仍为 running 表示异常中断，不能当成功。
本机 SDK 仅接受分支/标签，因此通过 master 下载；脚本逐文件核对固定提交清单的大小和 SHA256，
若 master 内容发生变化则校验失败，不会标记 complete。
complete 不代表已验证模型加载或训练，下一阶段需单独验证 Unsloth 环境。
不自动停止 vLLM 服务，不安装训练依赖。

## 候选图片与标注

```bash
.venv/bin/python scripts/datasets.py check
.venv/bin/python scripts/prepare_training_review.py
python3 tests/check_training_download.py
```

清单输出到 `output/training-prep/review.jsonl`，统计在 `inventory.json`。
2026-09-24：82 份射出/保压/计量标注关联到 78 张 SHA256 去重图片，10 类控制器；
2 张在已有 regression 中，禁止训练使用；没有缺图。此清单仅覆盖已有标注关联的
图片，不代表全部历史图片已完成分类。SHA256 只去除完全相同文件，裁剪/连拍仍需人工分组。

规则来源为 `/data1/code/molding-assist/skills/injection-parameters/`，该目录没有原图。
最新 `references/output-schema.md` 是统一草稿合同；`references/pages/injection-pages.md`
规定射出、保压、计量、冷却、松退、V-P 六类设定的采集范围。
历史 reader 标签是字段数组，不能直接假定等价于该合同。按现行合同补原标签、
单位来源、启用状态说明及原图百分比 bbox；观察不到的信息不编造。

先选择同一页面布局的 20～30 张，逐图核对历史答案。部分历史 JSON 的
`preannotation.verified_by` 明确写“自动整批接受”，部分 YAML 写“待王为确认”；
这些只能辅助标注。清单全部设为 needs_human_review，answer/split/group_id 留空，
不会把模型输出自动变为训练金标。

每条标注补充：机台/控制器、页面布局、拍摄批次或配方组、人工核对人、日期、
符合合同的完整 answer。相同机台/配方/连拍及裁剪版本归同 group_id 后再分集合；
已有 holdout/regression 保留评测用途。需要评估新机台泛化时，整台留出。

建议补拍同一布局的不同真实参数、段启用组合、小数及反光样本，保留标题、单位、
段号和 checkbox；不以同画面的重复照片凑数量。新照片先放独立收集目录，保留原图。
完成首批人工核对后再导出多模态对话数据，训练时实际加载图片。

## 可编辑标注包（2026-09-24）

```bash
python3 scripts/prepare_training_packet.py
python3 tests/check_training_packet.py
```

打开 `output/training-prep/annotation-packet/index.html`。包内复制了 78 张原图、
历史标注和当前规则快照，可以整体搬走；每图目录都有 `annotation.json`。
页面仅供浏览，修改 JSON 需使用编辑器。重跑保留已编辑的 JSON、历史标注及规则快照；
要采用新版规则应另建 `--output` 目录。原始 review.jsonl 仍是候选清单。

先复核排在最前面的 TACT 6 张，再补同布局新照片到 20～30 张；
这只是首轮流程验证目标，不代表足以训练出泛化模型。其余品牌保留在后续队列，
不把同控制器直接视为同布局。逐张填写：

1. `machine_id`、`layout_id`、`capture_session`：根据来源确认，不凭文件名猜。
2. `group_id`：同机台同配方/连拍/裁剪版本同组；来源不清先留空。
3. `answer`：按包内 `answer.schema.json` 和页面规则完整重标，只取六类设定，
   核对数值、单位、原标签、段号、启用状态和百分比 bbox；不要直接复制历史答案。
4. `reviewed_by`、`reviewed_at`、`review_notes`：真实复核人、日期和仍未解决的问题。
   完成核对才将 `status` 改为 `human_verified`；有未解决关键问题继续待复核。
5. `split` 暂留空。完成分组后整组分 train/validation/test；2 张评测保留图只能进 test，
   与其同组的其他照片也必须排除训练。不得逐图随机切分。

当前生成的是标注工作包，可训练样本仍为 0。生成器验证图像哈希、保留标志和重跑保护，
不验证人工答案质量；后续导出须验证答案合同、bbox 顺序、审核记录和组间隔离。

## Unsloth 环境核查（2026-09-24）

权重 `download-status.json` 已为 complete（22,364,846,622 bytes）。
目录名为 Qwen3.8，但配置实际声明 `Qwen3_5ForConditionalGeneration` / `qwen3_5`，
并包含视觉配置；加载应以配置为准，仍需实测兼容性。
系统 Python 和本项目 `.venv` 均未发现 unsloth、unsloth_zoo、torch、transformers、bitsandbytes。
下载权重不会安装这些训练包。本轮没有安装依赖或启动训练。

官方 Core 安装说明：<https://unsloth.ai/docs/get-started/install/pip-install>。
后续使用独立训练虚拟环境安装 Unsloth Core，按驱动选择兼容 PyTorch/CUDA 版本，
通过 import、CUDA 张量和本地模型加载检查后冻结依赖版本；不混装到现有推理环境。
视觉数据格式参考：<https://unsloth.ai/docs/basics/vision-fine-tuning>，
使用实际图片输入与 JSON 答案，不能只把图片路径作为普通文本喂给模型。

两张 A100 80GB 当次空闲约 1.2 / 5.5 GB，暂不具备加载该权重训练的显存；
标注不依赖 GPU，训练前再安排显存。本轮未停止现有 GPU 服务。

## 临时释放 GPU0（2026-09-24 下午）

已确认两个服务请求队列为空后执行：

```bash
systemctl --user stop comfyui-h3.service vllm-qwen3.8-27b-fp8.service
```

GPU0 占用从 79,777 MiB 降到 17 MiB，可用 81,021 MiB；GPU1 的
`vllm-Qwen3.8-27B-AWQ-INT4.service` 保持运行。停止期间 ComfyUI 8188 和
Qwen FP8 8000 不可用。未删除模型、卸载软件或改变开机启用状态；显式 stop
不会触发 vLLM 的 Restart=always，但重启机器或外部操作仍可能重新启动服务。

训练进程退出、释放显存后恢复：

```bash
systemctl --user start vllm-qwen3.8-27b-fp8.service
# ComfyUI 原来是临时单元，停止后会被回收，用原配置重建：
systemd-run --user --unit=comfyui-h3 \
  --property=StandardOutput=append:/data/tmp/comfyui-h3.log \
  --property=StandardError=append:/data/tmp/comfyui-h3.log \
  /bin/bash /data/ai/h3/start-comfyui.sh
```

原单元快照：`output/training-prep/service-backup/`。恢复前先检查对应单元状态，
已运行时不要重复启动临时单元。

## 独立 Unsloth Core 环境安装结果（2026-09-24 下午）

环境：`/data/venvs/hmi-unsloth`，Python 3.10.12。实装命令：

```bash
uv venv /data/venvs/hmi-unsloth --python /usr/bin/python3
uv pip install --python /data/venvs/hmi-unsloth/bin/python \
  unsloth==2026.9.11 torch==2.6.0 torchvision==0.21.0 torchao==0.13.0 \
  --index https://download.pytorch.org/whl/cu124 --index-strategy unsafe-best-match
uv pip install --python /data/venvs/hmi-unsloth/bin/python setuptools
CUDA_VISIBLE_DEVICES=0 /data/venvs/hmi-unsloth/bin/python tests/check_training_environment.py
```

实测通过：Unsloth 导入、单 GPU 可见、BF16、bitsandbytes NF4 层前向/反向、
本地配置识别；`uv pip check` 通过。完整本地权重也已离线加载成功，使用
`FastVisionModel.from_pretrained(..., load_in_4bit=True, dtype=torch.bfloat16,
max_seq_length=2048, local_files_only=True)`，返回 `Qwen3_5ForConditionalGeneration`
和 `Qwen3VLProcessor`，加载后张量占用约 20.83 GiB。检查进程已退出释放显存。
完整模型尚未做多模态前向/反向或训练，不将加载成功等同于训练验收。

依赖锁定快照：`output/training-prep/unsloth-environment.freeze.txt`；安装和验证日志：
`unsloth-install-cu124.log`、`unsloth-check.log`、`unsloth-model-load.log`，均在
`output/training-prep/`。未更改系统驱动及现有推理环境，未启动正式训练。

已知限制：自动选择 CUDA 后端会选 cu129；直接限定 cu124 后端会因 torchao
依赖解析退回旧 Unsloth，故显式指定版本并允许两个包源参与解析。
首次导入缺 setuptools，补装后检查通过。当前 torch 2.6 / Triton 3.2 无法启用
Qwen3.5 的 FLA 加速内核（需要 torch >=2.7、Triton >=3.3），回退较慢的
PyTorch 实现；正式训练前须验证真实图片的单步训练及速度，不能据此承诺吞吐。

官方 Qwen3.5 指南提示 4-bit 量化误差，并偏向 BF16 LoRA；已下载的 BNB 4-bit
权重可用于兼容性验证，但不等价于原生 BF16 权重：
<https://unsloth.ai/docs/models/qwen3.5/fine-tune>。
现有标注仍待人工复核，不能直接把历史自动答案用于正式训练。

## 加速组件升级进行中（2026-09-24 晚）

原环境完整备份：`/data/venvs/hmi-unsloth-cu124-backup`。当前升级由用户级
`hmi-unsloth-accelerate.service` 托管，日志为
`output/training-prep/unsloth-install-cu126.log`。目标版本为 torch 2.7.1+cu126、
torchvision 0.22.1、Triton 3.3.1；不修改系统 550.90.07 驱动和 GPU1 服务。
截至 22:17 仍在下载 torch，尚不能宣称加速可用。

应先确认服务成功退出（结合日志，不仅看 inactive），再安装已下载并通过官方
SHA256 校验的匹配 wheel，然后运行验收：

```bash
systemctl --user show hmi-unsloth-accelerate.service -p ActiveState -p ExecMainStatus
tail -40 output/training-prep/unsloth-install-cu126.log
uv pip install --python /data/venvs/hmi-unsloth/bin/python \
  'output/training-prep/xformers-0.0.31.post1-cp39-abi3-manylinux_2_28_x86_64.whl' \
  'output/training-prep/causal_conv1d-1.7.0+cu12torch2.7cxx11abiTRUE-cp310-cp310-linux_x86_64.whl'
uv pip check --python /data/venvs/hmi-unsloth/bin/python
CUDA_VISIBLE_DEVICES=0 /data/venvs/hmi-unsloth/bin/python tests/check_training_environment.py
CUDA_VISIBLE_DEVICES=0 /data/venvs/hmi-unsloth/bin/python tests/check_training_acceleration.py \
  --image output/training-prep/annotation-packet/700d0248cadca7dc/image.jpeg
```

新增验收脚本目前仅通过语法检查，待实际 GPU 执行：比较 FLA 与 PyTorch 的输出和
梯度、检查 causal-conv1d/xFormers 前向反向、验证模型快速路径绑定和一次多模态
LoRA 参数更新。测试文本是临时占位，不是人工金标；不保存权重，不启动正式训练。
验证通过后再保存新的 freeze，保留下午 cu124 的快照。

用户要求 AI-workforce 接管下载监控；已在 HMI-Reader 群发送原生 @，
标记 `HMI-ACCEL-20260924-2217`，消息 ID
`om_x100b646740bcc0a4dfa839500a9c6a1`。发送成功不等于对方已接管，需匹配回复确认。
交接范围为每 2 分钟只读检查、成功或失败后 @本地AI助手继续验收，不重复启动安装。
22:17 AI-workforce 已匹配标记回复接受交接（`om_x100b6467411ce0a4c4628eb127c41a2`），
但首次核查命令被其自身审批卡阻塞（`om_x100b64675edaa0a8c15eafafdc9c2c8`，
原因 `script execution via heredoc`）；尚未取得监控循环已启动的证据。
回复原始记录保存在 `output/training-prep/monitor-handoff-replies.json`。

## 加速组件验收完成（2026-09-24 22:28）

上述下载与监控状态已过时：用户转述 Hermes 于 22:18 确认监控已实跑；本轮实查
`hmi-unsloth-accelerate.service` 已 inactive/dead、ExecMainStatus=0，安装日志确认成功。
随后补装已下载的 xFormers 0.0.31.post1 和 causal-conv1d 1.7.0 匹配 wheel。
当前 torch 2.7.1+cu126 / Triton 3.3.1，`uv pip check` 通过。

在 `CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1` 下，
上述两个验收脚本均退出 0：BF16 与 BNB NF4 前向/反向、FLA 输出及梯度对比
PyTorch 参考实现、causal-conv1d 与 xFormers CUDA 前向/反向均通过。
完整本地 Qwen3.5 模型的快速路径绑定检查通过，使用 HMI 图片（缩至 224 像素以内）
完成一次 r=8 LoRA 前向、反向和 AdamW 参数更新；loss=2.6818013，
PyTorch 峰值分配显存 21.94 GiB。此结果验证计算可用，不代表正式训练吞吐或抽取质量。
测试未保存权重，临时测试答案不作为训练标注。退出后 GPU0 回到 17 MiB；
GPU1 推理进程未改动，系统驱动仍为 550.90.07。

非阻断提示：FLA 推荐 Python >=3.11（当前 3.10.12）；Unsloth 跳过不兼容的
torchao 0.13.0，本次使用 bitsandbytes 量化且 LoRA 实测通过，未为未使用的
torchao 路径继续升级依赖。安装跨文件系统硬链接失败后自动复制，安装成功。

验收日志：`output/training-prep/unsloth-check-cu126.log`、
`output/training-prep/unsloth-acceleration-check.log`。
新版本快照：`output/training-prep/unsloth-environment-cu126.freeze.txt`；
保留原 cu124 环境备份及版本快照。尚未启动正式训练；下一步仍需完成人工标注复核、
按组划分数据，再验证实际图片分辨率及序列长度下的训练配置。
