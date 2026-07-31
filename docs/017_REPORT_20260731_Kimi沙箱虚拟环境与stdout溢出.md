---
doc_type: REPORT
doc_status: completed
next_action: none
date: 2026-07-31
---

# Kimi 沙箱虚拟环境与 stdout 溢出修复报告

## 结论

HMI-Reader 的 Kimi 参与者在启动阶段报 `stdout maxBuffer length exceeded`，并非模型回复过长。根因是临时虚拟环境 `.venv-s1/` 未被 Git 忽略，令 `git status --porcelain=v1 -uall` 输出约 1.24 MB、15,697 行，超过 Kimi CLI 内部子进程的默认 stdout 缓冲上限。

`.venv-s1` 的出现也不是业务需要：原 `.venv` 使用 uv Python 3.11，其解释器和标准库位于工作区外的 `/home/hello/.local/share/uv/`；Kimi 的 Bubblewrap 沙箱只挂载授权工作区和系统目录，因此沙箱内无法解析该环境。S1 执行期间遂以沙箱可见的系统 Python 3.10 创建 `.venv-s1` 作为临时绕行。

## 修复

- 将已经包含完整 OCR 依赖的 `.venv-s1` 迁移为唯一标准环境 `.venv`。
- 更新迁移后 35 个第三方命令的 shebang，使其指向新的 `.venv` 路径。
- 删除依赖沙箱外 uv Python 的旧 `.venv`。
- 将 `.gitignore` 的虚拟环境规则改为 `.venv*/`，避免临时或迁移环境再次污染 Git 状态。
- 未修改 HMI 提取、验证、模板或数据产物，开工前的所有用户改动均保留。

## 验证

| 检查 | 结果 |
|---|---|
| 修复前 Bubblewrap 执行 `.venv/bin/python` | 失败，`No such file or directory` |
| 修复后宿主机导入 `cv2/numpy/paddle/paddleocr` | 通过 |
| 修复后 Bubblewrap 导入上述依赖 | 通过 |
| 版本 | Python 3.10.12、OpenCV 4.6.0、NumPy 1.26.4、Paddle 2.6.2、PaddleOCR 2.7.3 |
| Bubblewrap 启动 `scripts/verify_accuracy.py --help` | 通过 |
| `.venv/bin/pip --version` 与 `.venv/bin/paddleocr --help` | 通过 |
| 工作区顶层虚拟环境数量 | 1，仅 `.venv` |

## 边界与后续

本次仅修复本地执行环境及 Git 忽略规则，不改变 Agent Platform 的 Kimi adapter、stdout 缓冲策略、HMI 业务代码或当前 PLAN/Slice 状态。下一次 Kimi 参与者启动仍应进行一次真实 smoke run，以验证 Kimi CLI 自身的工作区扫描已不再溢出。
