"""Offline, conservative mapping to a frozen Web target projection. Never writes Web."""
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = json.loads((ROOT / 'contracts/field_catalog.json').read_text())
REGISTRY = json.loads((ROOT / 'contracts/profiles.json').read_text())
FIXTURE = json.loads(Path(__file__).with_name('target.fixture.json').read_text())
MAPPING_VERSION = 'lab-1'
GROUPS = {'temperature': '料筒 / 模温', 'plasticizing': '熔胶', 'injection': '射出',
          'holding': '保压', 'cooling_ejection': '热流道 / 冷却', 'preparation': '材料准备'}
LABELS = {'set_temperature': '设定温度', 'actual_temperature': '实际温度',
          'screw_speed': '螺杆转速', 'back_pressure': '背压', 'end_position': '终点位置',
          'speed': '速度', 'pressure_limit': '压力上限', 'pressure': '压力', 'time': '时间',
          'position': '位置', 'metering_end_position': '计量终点', 'suck_back_position': '松退',
          'plasticizing_time': '熔胶时间', 'filling_time': '充填时间', 'global_speed_limit': '全局速度上限',
          'total_injection_time': '总射出时间', 'cooling_time': '冷却时间', 'cycle_time': '成型周期',
          'clamp_force': '锁模力', 'drying_temperature': '干燥温度', 'drying_dew_point': '干燥露点'}
# The registry names semantic rules; these paths are only this lab's frozen Web adapter.
ARRAY_RULES = {'injection_segment_speed': ('injection', 'speed'),
               'injection_segment_pressure_limit': ('injection', 'pressure_limit'),
               'holding_segment_pressure': ('holding', 'pressure'),
               'holding_segment_time': ('holding', 'time')}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     allow_nan=False).encode()).hexdigest()


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def targets(data):
    """Enumerate existing raw-value cells; no arbitrary path creation."""
    found = {}

    def walk(value, path, label):
        if isinstance(value, dict):
            label = value.get('name') or (f"第 {value['order']} 段/区" if 'order' in value else label)
            if 'raw_value' in value and 'raw_unit' in value:
                found[path + '/raw_value'] = {'path': path + '/raw_value', 'value': value['raw_value'],
                    'unit': value['raw_unit'], 'basis': value.get('display_basis'),
                    'label': f"{GROUPS.get(path.split('/')[1], '')} · {label}",
                    'group': path.split('/')[1]}
            else:
                for key, child in value.items():
                    walk(child, f'{path}/{key}', f'{label} {LABELS.get(key, key)}')
        elif isinstance(value, list):
            for i, child in enumerate(value):
                walk(child, f'{path}/{i}', label)
    walk(data, '', '')
    return found


def set_cell(data, path, value):
    node = data
    parts = path.strip('/').split('/')
    for part in parts[:-1]:
        node = node[int(part)] if isinstance(node, list) else node[part]
    node[parts[-1]] = value


def validate_target(data):
    if not isinstance(data, dict) or len(json.dumps(data, allow_nan=False)) > 262144:
        raise ValueError('目标必须是小于 256 KiB 的参数对象')
    for group in GROUPS:
        if group in data and not isinstance(data[group], dict):
            raise ValueError('工艺模块必须是对象')
    arrays = [data.get(g, {}).get('segments', []) for g in ('injection', 'holding', 'plasticizing')]
    arrays.append(data.get('temperature', {}).get('zones', []))
    cooling = data.get('cooling_ejection', {})
    for key in ('hot_runner', 'cooling'):
        if key in cooling and not isinstance(cooling[key], dict):
            raise ValueError('温控/冷却结构必须是对象')
    arrays.append(cooling.get('hot_runner', {}).get('nozzles', []))
    if not isinstance(data.get('injection', {}).get('vp_switch', {}), dict):
        raise ValueError('V/P 结构必须是对象')
    for items in arrays:
        if not isinstance(items, list) or len(items) > 100 or any(not isinstance(i, dict) for i in items):
            raise ValueError('段/温区必须是对象数组，最多 100 项')
        for key in ('segment_id', 'zone_id', 'nozzle_id'):
            ids = [i[key] for i in items if key in i]
            if any(not isinstance(i, str) for i in ids) or len(ids) != len(set(ids)):
                raise ValueError('段/温区 ID 必须为不重复的字符串')
    cells = targets(data)
    if not cells or len(cells) > 2000:
        raise ValueError('目标需要包含 raw_value/raw_unit 字段，最多 2000 个')
    for cell in cells.values():
        if cell['value'] is not None and not number(cell['value']):
            raise ValueError('目标原值只能是有限数字或 null')
        if not isinstance(cell['unit'], str):
            raise ValueError('目标单位必须是文字')
    return data


def metadata(key, result, catalog):
    spec = deepcopy(catalog['fields'].get(key, {}))
    profile = result.get('profile_id')
    if profile in spec.get('entity_overrides', {}):
        spec['entity'] = {**spec.get('entity', {}), **spec['entity_overrides'][profile]}
    if profile in spec.get('role_overrides', {}):
        spec['role'] = spec['role_overrides'][profile]
    reported = (result.get('field_meta') or {}).get(key, {})
    # Runtime entity and pressure observations remain visible, never replace catalog identity/unit.
    if isinstance(reported, dict):
        for attr in ('entity', 'physical_semantics'):
            if isinstance(reported.get(attr), dict):
                spec[attr] = {**spec.get(attr, {}), **reported[attr]}
    return spec


def suggested_paths(key, value, meta, result, target, image):
    """Return aligned paths plus a reason. No inferred units, pressure basis or segment order."""
    values = value if isinstance(value, list) else [value]
    rule = meta.get('web_target')
    if rule in ARRAY_RULES:
        group, field = ARRAY_RULES[rule]
        segments = target.get(group, {}).get('segments', [])
        if len(values) != len(segments):
            return [], f'图片 {len(values)} 段，目标 {len(segments)} 段；请调整验证副本'
        if [s.get('order') for s in segments] != list(range(1, len(segments) + 1)):
            return [], '目标段序不连续'
        if meta.get('entity', {}).get('order') != 'physical_stage':
            return [], '来源物理段序尚未确认，可逐项人工指定目标'
        if rule == 'holding_segment_time' and (
                meta.get('physical_semantics', {}).get('time_definition') != 'segment_duration'
                or target.get('holding', {}).get('time_definition') != 'segment_duration'):
            return [], '保压时间定义不一致或不明确'
        return [f'/{group}/segments/{i}/{field}/raw_value' for i in range(len(values))], ''
    if rule in ('barrel_zone_temperature_set', 'barrel_zone_temperature_actual'):
        columns = meta.get('entity', {}).get('columns', [])
        zones = target.get('temperature', {}).get('zones', [])
        indices = [i for i, z in enumerate(zones) if z.get('source') in ('nozzle', 'barrel')]
        if len(columns) != len(values) or len(indices) != len(values):
            return [], '来源列标/温区数量与目标不一致，请调整验证副本或逐项指定'
        field = 'set_temperature' if rule.endswith('_set') else 'actual_temperature'
        paths = []
        for col in columns:
            matches = [i for i in indices if zones[i].get('name') == col]
            if len(matches) != 1:
                return [], f'温区 {col} 无唯一同名目标；请核对射嘴/区号后指定'
            paths.append(f'/temperature/zones/{matches[0]}/{field}/raw_value')
        if len(set(paths)) != len(paths):
            return [], '来源温区列标重复'
        return paths, ''
    if rule == 'mold_zone_temperature_set':
        zones = target.get('temperature', {}).get('zones', [])
        matches = [i for i, z in enumerate(zones) if z.get('zone_id') == image.get('mold_target')
                   and z.get('source') in ('mold_fixed', 'mold_moving', 'mold_slide', 'other')]
        if len(values) == 1 and len(matches) == 1:
            return [f'/temperature/zones/{matches[0]}/set_temperature/raw_value'], ''
        return [], '请在照片卡片指定模温目标'
    if rule == 'hot_runner_zone_temperature_set':
        return [], '热流道需逐项核对通道与热嘴对应，黑屏槽位不可压缩'
    scalar = {'vp_switch_position': '/injection/vp_switch/position/raw_value',
              'cooling_time': '/cooling_ejection/cooling/cooling_time/raw_value'}
    if rule in scalar and len(values) == 1:
        if rule == 'vp_switch_position' and target.get('injection', {}).get('vp_switch', {}).get('mode') not in ('position', 'position_or_time'):
            return [], 'V/P 目标不在位置切换模式'
        return [scalar[rule]], ''
    if rule == 'injection_segment_start_position':
        return [], '识别为段起点，目标为段终点；本版不自动换算，请核对后纠正'
    return [], '本版未实现此语义规则；保留识别，可人工核对目标'


def base_reasons(result, catalog, registry):
    reasons = []
    profile = next((p for p in registry['profiles'] if p['profile_id'] == result.get('profile_id')), {})
    if result.get('contract_version') != catalog['contract_version']:
        reasons.append('Reader 合同与本地冻结版本不一致')
    if result.get('profile_status') != 'verified' or profile.get('status') != 'verified':
        reasons.append('profile 尚非 verified')
    if any(profile.get(k) != result.get(k) for k in ('controller_family', 'page_type')):
        reasons.append('profile 与来源控制器/页面不一致')
    conf = result.get('profile_confidence')
    if not number(conf) or conf < registry['apply_thresholds']['verified_min_confidence']:
        reasons.append('profile 置信度不足')
    if result.get('status') != 'ok' or result.get('quality', {}).get('triage') != 'green':
        reasons.append('识别或图片质量需要复核')
    if result.get('warnings'):
        reasons.append('来源有识别警告，请核对')
    return reasons


def preview(session, baseline=True):
    target = validate_target(deepcopy(session['target']))
    available = targets(target)
    catalog = session.get('provenance', {}).get('reader_catalog', CATALOG)
    registry = session.get('provenance', {}).get('profiles', REGISTRY)
    rows = []
    families = {im['attempts'][-1].get('result', {}).get('controller_family')
                for im in session['images'] if not im.get('excluded') and im['attempts']
                and im['attempts'][-1].get('result', {}).get('page_type') not in ('mold_temp', 'hot_runner_temp')}
    families.discard(None)
    for image in session['images']:
        if image.get('excluded') or not image['attempts']:
            continue
        attempt = image['attempts'][-1]
        result = attempt.get('result') or {}
        fields = result.get('fields') or {}
        if not isinstance(fields, dict):
            continue
        for key, value in fields.items():
            meta = metadata(key, result, catalog)
            values = value if isinstance(value, list) and value else [value]
            paths, why = suggested_paths(key, value, meta, result, target, image)
            for i, original in enumerate(values):
                row_id = f"{image['id']}:{len(image['attempts'])}:{key}:{i}"
                edit = session.get('edits', {}).get(row_id, {})
                path = edit.get('target', paths[i] if i < len(paths) else '')
                proposed = edit.get('value', original)
                cell = available.get(path)
                reasons = base_reasons(result, catalog, registry)
                if len(families) > 1:
                    reasons.append('多图控制器不一致，请排除错图')
                if why:
                    reasons.append(why)
                unit = meta.get('unit', '')
                reported = (result.get('field_meta') or {}).get(key, {})
                if any(reported.get(k, meta.get(k)) != meta.get(k) for k in ('unit', 'role', 'web_target')):
                    reasons.append('来源单位/角色/目标规则与字段目录冲突')
                if not meta:
                    reasons.append('未登记 canonical 字段')
                elif result.get('page_type') not in meta.get('source_pages', []):
                    reasons.append('字段不属于此来源页面')
                if not number(original):
                    reasons.append('缺值或非有限数字')
                enabled = (result.get('stage_enabled') or {}).get(key)
                if enabled is not None and (not isinstance(enabled, list) or len(enabled) != len(values)
                                             or enabled[i] is not True):
                    reasons.append('段启用状态不明确或已禁用')
                if cell and cell['unit'] != unit:
                    reasons.append('来源与目标单位不一致，不自动换算')
                if cell and 'pressure' in path:
                    basis = meta.get('physical_semantics', {}).get('pressure_basis')
                    if not basis or cell.get('basis') != basis:
                        reasons.append('压力侧别不明确或不一致')
                if not cell:
                    reasons.append('尚无明确目标')
                raw_status = 'ready' if not reasons else 'review'
                status = raw_status
                # Manual confirmation is only a lab hypothesis, never an automatic accuracy credit.
                if edit.get('confirmed') and cell and number(proposed) and cell['unit'] == unit:
                    status = 'manual'
                if edit.get('excluded'):
                    status = 'excluded'
                elif not number(proposed) or not cell or (cell and cell['unit'] != unit):
                    status = 'blocked'
                elif proposed < 0 and unit != '°C':
                    status = 'blocked'
                    reasons.append('此目标不接受负值')
                elif unit == '°C' and not -273.15 <= proposed <= 500:
                    status = 'blocked'
                    reasons.append('温度超出验证范围（-273.15～500°C）')
                if edit and not edit.get('confirmed') and not edit.get('excluded'):
                    if status != 'blocked':
                        status = 'review'
                    reasons.append('修改尚未人工确认')
                label = meta.get('label_zh', key)
                columns = meta.get('entity', {}).get('columns', [])
                index_label = columns[i] if i < len(columns) else f'第 {i+1} 段/通道'
                rows.append({'id': row_id, 'image_id': image['id'], 'field': key, 'index': i,
                    'label': f'{label} · {index_label}' if isinstance(value, list) else label,
                    'group': meta.get('page_label_zh') or result.get('page_type') or '未分类',
                    'original': original, 'value': proposed, 'unit': unit, 'target': path,
                    'before': cell['value'] if cell else None, 'target_label': cell['label'] if cell else '',
                    'raw_status': status, 'status': status, 'reasons': reasons,
                    'manually_corrected': bool(edit), 'profile_id': result.get('profile_id')})
    by_path = {}
    for row in rows:
        if row['target'] and row['status'] != 'excluded' and number(row['value']):
            by_path.setdefault(row['target'], []).append(row)
    for group in by_path.values():
        if len({row['value'] for row in group}) > 1:
            for row in group:
                row['status'] = 'blocked'
                row['raw_status'] = 'review'
                row['reasons'].append('同一目标有不同值，请排除错误来源或纠正；不采用最后一张覆盖')
    auto = deepcopy(target)
    corrected = deepcopy(target)
    for row in rows:
        if row['status'] == 'ready':
            set_cell(auto, row['target'], row['value'])
        if row['status'] in ('ready', 'manual'):
            set_cell(corrected, row['target'], row['value'])
    raw_counts = None
    if baseline and session.get('edits'):
        raw = preview({**session, 'edits': {}}, baseline=False)
        auto = raw['automatic_parameter_data']
        raw_counts = raw['counts']
        raw_rows = {r['id']: r for r in raw['rows']}
        for row in rows:
            row['raw_status'] = raw_rows[row['id']]['status']
    covered = {r['target'] for r in rows if r['status'] in ('ready', 'manual')}
    return {'rows': rows, 'targets': list(available.values()),
            'counts': {s: sum(r['status'] == s for r in rows) for s in ('ready', 'manual', 'review', 'blocked', 'excluded')},
            'missing_targets': [c for p, c in available.items() if p not in covered],
            'automatic_parameter_data': auto, 'corrected_parameter_data': corrected,
            'raw_mapping_counts': raw_counts or {s: sum(r['status'] == s for r in rows) for s in ('ready', 'manual', 'review', 'blocked', 'excluded')},
            'target_hash': digest(target), 'mapping_version': MAPPING_VERSION,
            'notice': '仅验证投影，非 Web 保存请求。人工确认不计为自动识别通过；尚未验证 Web 完整业务规则。'}
