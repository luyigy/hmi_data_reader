"""一次性脚本：把 12 台机台的 S1 VLM 预标注写入 Base「S1机台核验」表。

每个机台：上传代表图（media upload）→ 建记录（含附件 file_token + 草稿 + evidence）。
幂等：以 machine候选 判重，已存在则跳过。
"""
import json
import os
import subprocess

B, T = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc", "tblxdrwZD1Auox0z"
D = "docs/samples_v2"

ROWS = [
    ("伯乐_A01", "rec11", "伯乐_A01_TX24014_200-19355-2_20260717_rec11_监控_00.jpeg", "UNKNOWN",
     "监控/炮筒页仅见 BOLE Logo 与 'Process expert' 标题栏，深色 WinCE 风格 UI，无控制器标识"),
    ("伯乐_B01", "rec07, rec09", "伯乐_B01_TX25023_200-30133-1_20260724_rec07_监控_00.jpeg", "UNKNOWN",
     "BOLE Logo + BKS_350 型号标识，蓝色自研风格 UI，监控/炮筒页均无控制器 Logo"),
    ("伯乐_B02", "rec06, rec08, rec10", "伯乐_B02_TX25024_100-30135_20260724_rec06_监控_00.jpeg", "KEBA",
     "机身面板右上角 KEBA 丝印 Logo + 软件标题栏 BOLE"),
    ("德马格_A01", "rec14", "德马格_A01_TX22063_100-17017_20260722_rec14_监控_00.jpeg", "DEMAG",
     "工艺控制统计页为 Demag NC 系列风格，无第三方控制器 Logo（间接证据，S2 关键词法判 unknown）"),
    ("德马格_A02", "rec15", "德马格_A02_TX23030_100-18891_20260722_rec15_监控_00.jpeg", "DEMAG",
     "机身 Sumitomo SHI DEMAG Logo + NC 系列工艺控制统计页"),
    ("发那科_A09", "rec00, rec01", "发那科_A09_TX22058_100-17014_20260714_rec00_监控_00.jpeg", "FANUC",
     "顶部 FANUC ROBOSHOT 机型标识（机型名称 TX22058）"),
    ("佳明_B07", "rec12, rec13, rec16, rec17", "佳明_B07_TX24013_100-19156_20260605_rec12_监控_00.jpeg", "ZIZES",
     "机身 ZizES Logo + 标题栏 广东佳明机器有限公司"),
    ("日精_A06", "rec02", "日精_A06_TX25022_100-15545_20260724_rec02_监控_00.jpeg", "TACT",
     "底部 工程监视/生产情报/经历 菜单为日精 TACT 风格（间接证据，建议重点核）"),
    ("日精_B09", "rec04, rec05", "日精_B09_TX23056_100-30087_20260710_rec04_监控_00.jpeg", "TACT",
     "蓝色按钮 UI 与日精 B10 的 TACT5 软件同族（间接证据，建议重点核）"),
    ("日精_B10", "rec03", "日精_B10_TX22064_100-17018_20260724_rec03_监控_00.jpeg", "TACT",
     "屏幕面板上方 TACT 5 标识"),
    ("沙迪克_A06", "rec18, rec19", "沙迪克_A06_TX22057_100-17013_20260703_rec18_监控_00.jpeg", "TRD6",
     "面板 TRD6 标牌 + SPT(Sodick Plustech) 键盘 Logo"),
    ("阿博格_A07", "rec20, rec21", "阿博格_A07_TX23053_100-30023_20260725_rec20_监控_00.jpeg", "ARBURG",
     "SELOGICA 风格黄绿图标栏 + 参数编号体系 t4012/s4062/p4072"),
]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"cmd failed: {' '.join(cmd[:6])}...\n{r.stdout[:300]}\n{r.stderr[:300]}")
    if r.returncode != 0 or d.get("ok") is False:
        raise RuntimeError(f"api error: {json.dumps(d.get('error', d), ensure_ascii=False)[:300]}")
    return d


def existing_machines():
    d = run(["lark-cli", "api", "GET",
             f"/open-apis/bitable/v1/apps/{B}/tables/{T}/records",
             "--as", "bot", "--params", json.dumps({"page_size": 100})])
    out = set()
    for it in d["data"].get("items", []):
        v = it["fields"].get("machine候选")
        if v:
            out.add(v)
    return out


def upload(path):
    size = os.path.getsize(path)
    d = run(["lark-cli", "api", "POST", "/open-apis/drive/v1/medias/upload_all",
             "--as", "bot", "--file", f"file={path}",
             "--data", json.dumps({"file_name": os.path.basename(path),
                                   "parent_type": "bitable_file",
                                   "parent_node": B, "size": size})])
    return d["data"]["file_token"]


def main():
    have = existing_machines()
    for machine, recs, img, fam, ev in ROWS:
        if machine in have:
            print(f"skip {machine} (exists)")
            continue
        token = upload(os.path.join(D, img))
        run(["lark-cli", "api", "POST",
             f"/open-apis/bitable/v1/apps/{B}/tables/{T}/records",
             "--as", "bot",
             "--data", json.dumps({"fields": {
                 "machine候选": machine,
                 "覆盖records": recs,
                 "代表图": [{"file_token": token}],
                 "草稿_controller_family": fam,
                 "evidence": ev,
                 "核验状态": "待核验",
             }}, ensure_ascii=False)])
        print(f"ok {machine} -> {fam}")


if __name__ == "__main__":
    main()
