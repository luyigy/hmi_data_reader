"""Physical rows of the supported B&R injection/holding page only."""

# 中文教学注释由 AI 添加；几何判断和阈值保持重构前行为。
#
# 先看全图：page_identity 确认“这是哪一页”，本文件回答“这一页的格子在哪里、段号是谁”。
# extractor 随后才把格中的文字转为数值、校验单位/置信度；page_result 负责输出合同。
#
# 本文件按阅读顺序分为四段：
#   A. physical_rows：把真实边框排成三行，检查宽度、间距和错列。
#   B. stage_identity：核对从右往左的段号，防止裁掉第一段后把第二段冒充第一段。
#   C. build_holding_layout：先建保压逻辑网格，再把边框/OCR 绑定进去；缺框不等于缺格。
#   D. build_raw_layout：原 v2 的兼容定位规则迁入这里，保留旧页面定义的区域限制。
#      D 尚未与 C 合成同一种算法；目录整理不意味着已经完成这项算法统一。
#
# 坐标词典：box=[左x,上y,右x,下y]，均为矫正图像素；size=(图宽,图高)。
# tokens 是 OCR 片段列表。token.bbox 为像素，token.x/y 通常是 0~1 的中心坐标。
# physical_rows 的 y_lo/y_hi、build_holding_layout 的 title_y/end_y 使用像素；
# stage_identity 的 title_y 使用 0~1，函数内乘图高换成像素。不要混用。
#
# 两种“框”必须分清：predicted_bbox 是逻辑位置；observed_border_ids 才证明检测到了边框。
# mapping_status=verified 只表示空间归属通过，不保证 OCR 数字读对，更不授予 mold 写入权。
# 本文件不写文件、不调用 OCR、不访问数据库；只返回布局和可追溯证据。

from dataclasses import asdict, dataclass, field
import re
from statistics import median

from extract_families.common import _anchor_match
from extract_families.visual_cells import tokens_in_cells, cell_glyph_evidence
from raw_page import _line_box



# A0. 本页速度行比压力/第三行多一个格。这里只检查已核验物理格的形状，不看工艺数值。
def infer_active_stages(rows):
    """Count active stages in this B&R profile's physical three-row table.

    Callers must verify complete cell geometry and printed stage identity first.
    OCR token lists are not physical rows.
    """
    # 必须正好三行；少一行/多一行就无法采用本页的行关系。
    if len(rows) != 3:
        return None
    # 解包为速度、压力和第三行。射胶第三行为位置；保压第三行为时间。
    speed, pressure, third = rows
    # 先把压力格数作为候选段数，而不是用“非零数值个数”猜段数。
    n = len(pressure)
    # 任一条件成立就拒绝：无压力格、下两行格数不同，或速度行不是恰好多一个。
    if n < 1 or len(third) != n or len(speed) != n + 1:
        return None
    return n


# A1. 输入粗分的 OCR 行和真实边框；输出“按格排列的 OCR”及对应真实边框，二者同序。
def physical_rows(rows, boxes, y_lo, y_hi):
    """Read three physical input rows, preserving missing/duplicate OCR cells.

    The first numeric input row anchors the table below its stage header. All
    subsequent physical rows are found from borders, even with no OCR in a row.
    B&R position cells are staggered, so each row has its own lattice.
    """
    # 先把 OCR 行摊成一个列表；这里不把 OCR 的行号当成最终物理行。
    tokens = [t for row in rows for t in row]
    # 从指定区段的边框中，找至少包含一个 OCR 中心的框；any 表示存在一个就够。
    matched = [b for b in boxes if y_lo < (b[1]+b[3])/2 < y_hi and any(
        # 先确认文字有框，再检查文字中心是否严格位于边框左右边之间。
        t.get('bbox') and b[0] < (t['bbox'][0]+t['bbox'][2])/2 < b[2]
        # 接着检查中心也在上下边之间；横纵同时满足才算落在格内。
        and b[1] < (t['bbox'][1]+t['bbox'][3])/2 < b[3] for t in tokens)]
    # 没有任何“文字落进真实框”的起点，返回空行，不凭坐标造出已验证表格。
    if not matched:
        return [[], [], []], [[], [], []]
    # 取最靠上的匹配框中心作为数值区起点，避免把上方段号框当作数值行。
    start = min((b[1]+b[3])/2 for b in matched)
    # 从起点往下保留真实框；即使某行 OCR 漏读，框仍能参与重建。
    candidates = sorted([b for b in boxes if start <= (b[1]+b[3])/2 < y_hi],
                        key=lambda b: (b[1]+b[3])/2)
    # 新建分组容器；后面用中心坐标把观测归到同一行或同一列。
    groups = []
    # 按由上到下的顺序，逐个处理候选框。
    for box in candidates:
        # 用框中心的 y 坐标表示它所在的高度。
        cy = (box[1]+box[3])/2
        # 已有上一行，且当前框离上一行中心足够近，就归到同一行。
        if groups and abs(cy-median((b[1]+b[3])/2 for b in groups[-1])) < (box[3]-box[1])*.5:
            # 把框放进最近的一行，不额外创建新行。
            groups[-1].append(box)
        else:
            # 离上一行太远或还没有行时，从当前框新建一行。
            groups.append([box])
    # 这里要得到三行物理格；行数不确定就保守拒绝，而不是强凑。
    if len(groups) != 3:
        return [[], [], []], [[], [], []]
    # aligned 存每格对应的 OCR；evidence 存原始边框，便于逐格复查。
    aligned, evidence = [], []
    for group in groups:
        # 按矩形坐标倒序，主要按左边 x 从大到小排；本页的段序是从右向左。
        cells = sorted(group, reverse=True)
        # 计算每格宽度，以页面自身尺度衡量误差，不用固定像素阈值。
        widths = [b[2]-b[0] for b in cells]
        # 计算这一行各格的水平中心。
        centers = [(b[0]+b[2])/2 for b in cells]
        # 相邻中心相减得到列距；排序正确时列距应为正。
        steps = [a-b for a,b in zip(centers, centers[1:])]
        # 宽度不能相差过大；接下行继续检查每个列距是否接近典型格宽。
        regular = (len(cells) >= 1 and max(widths) < 1.3*min(widths)
                   # all 表示每个间距都要满足区间。单格时没有间距，此项本身为真。
                   and all(.85*median(widths) < step < 1.3*median(widths) for step in steps))
        # 宽度/间距不规则就不接受这一组格子，防止把旁边按钮拼进表格。
        if not regular:
            return [[], [], []], [[], [], []]
        # 把文字按所在物理格绑定；漏读保留空位，重复读数不会被偷偷压紧成下一段。
        aligned.append(tokens_in_cells(tokens, cells))
        # 同时保留这行真实边框，不能只返回整理后的数字。
        evidence.append(cells)
    # Pressure aligns with speed; the position row may be half a cell staggered.
    # Reject a shifted/truncated row even when its cell count happens to fit.
    speed, pressure, third = evidence
    # 以速度行的典型格宽作为对齐检查的尺度。
    width = median(b[2]-b[0] for b in speed)
    # 压力行要求较紧对齐；第三行允许本页已知的错列，两个容差并不相同。
    for row, tolerance in ((pressure, .25), (third, .65)):
        # 逐列计算当前行相对速度行的中心偏移，保留方向和大小。
        offsets = [(b[0]+b[2]-s[0]-s[2])/2 for b, s in zip(row, speed)]
        # 没有可比列，或任意一列偏得过远，都拒绝；不是格数吻合就算正确。
        if (not offsets or any(abs(delta) > tolerance*width for delta in offsets)
                # 即使每列各自偏移不大，列与列偏移不一致也说明可能错位。
                or max(offsets)-min(offsets) > .2*width):
            return [[], [], []], [[], [], []]
    # 交回三行的 OCR 绑定和三行真实边框；还需要下面的段号核验。
    return aligned, evidence


# B. 检查“最右边是不是第一段”。reference 只能来自已独立核验过的兄弟区段。
def stage_identity(tokens, rows, title_y, size, reference=None):
    """Verify right-to-left numbering against printed headers or sibling table.

    The sibling table must already have verified stage identity. This guards a
    cropped/missing rightmost cell from silently becoming stage 1.
    """
    # 没有第一行的几何位置，就不能判断第一段在哪里。
    if not rows or not rows[0]:
        return False
    # 读出矫正图宽高，用于把归一化 OCR 中心换成像素。
    w, h = size
    # 使用第一行从右往左排列的格子作为列轴。
    cells = rows[0]
    # 段号应位于标题下方、数值行上方；先取数值框最上边。
    header_bottom = min(b[1] for b in cells)
    # 只收本页印刷段号 1~5；接下行还要求置信度和所在高度符合。
    headers = [t for t in tokens if t['text'].strip() in {'1','2','3','4','5'}
               # 段号置信度至少 0.8，且位于标题与数值行之间；不使用文件名或数值大小。
               and t.get('conf', 0) >= .8 and title_y*h < t['y']*h < header_bottom]
    # 记录成功对应的物理段号；不是要求 OCR 必须读到全部段号。
    verified = []
    # 逐个核对印刷段号的文字身份和几何列身份是否一致。
    for token in headers:
        # 把段号中心的归一化 x 转成像素，才能和边框比较。
        x = token['x']*w
        # 枚举从右向左的列：第一列候选为段1、第二列为段2，先找段号最靠近哪列。
        matches = [index+1 for index,b in enumerate(cells)
                   # 只有中心偏差小于该格宽度的 40% 才算可能属于这一列。
                   if abs(x-(b[0]+b[2])/2) < .4*(b[2]-b[0])]
        # 段号必须只能对应一列；匹配不到或对应多列的 token 不作确认依据。
        if len(matches) == 1:
            # 列身份说“第一段”，印刷文字却说“第二段”时，立即判冲突。
            if matches[0] != int(token['text']):
                return False
            # 只有文字与列位置一致，才登记这一条段号证据。
            verified.append(matches[0])
    # 有至少一条可用段号时采用印刷证据；当前实现并不要求每列都有段号。
    if verified:
        # 确认记录不得重复指认同一段；列表长度与去重后长度相等才通过。
        return len(verified) == len(set(verified))
    # 没有可用印刷段号时，才尝试已验证的兄弟表第一段参考。
    if reference:
        # 取当前表最右侧候选格，不能把剩下的最右格直接当作第一段。
        right = cells[0]
        # 比较两表第一段中心，偏差必须小于当前格宽的 35%；右边被裁掉时通常不能通过。
        return abs(right[0]+right[2]-reference[0]-reference[2])/2 < .35*(right[2]-right[0])
    return False


# ===== 保压区域：逻辑网格与证据绑定 =====

ROWS = ('velocity', 'pressure', 'time')

LABELS = {'速度': 'velocity', '压力': 'pressure', '时间': 'time'}

NUMBER = re.compile(r'(?:\d+\.\d+|\d{3,})')

@dataclass
# 每个逻辑格的档案。它可以已经存在，但没有边框、没有读数、尚待核验。
class Cell:
    section: str  # 区域：本模型为 holding。
    row_key: str  # 行身份：velocity / pressure / time。
    stage_id: int  # 物理段号，从右向左计数，不按 OCR 返回顺序编号。
    predicted_bbox: list  # 逻辑预测位置，绝不能称为实测边框。
    observed_border_ids: list = field(default_factory=list)  # 检测器确实观察到的边框 ID；可以为空。
    ocr_token_ids: list = field(default_factory=list)  # 绑定到本格的 OCR ID，便于追回来源。
    raw_reading: list = field(default_factory=list)  # 未改写的 OCR 文字，可以缺失或有多个冲突候选。
    ocr_confidences: list = field(default_factory=list)  # 原 OCR 置信度；空间映射通过也不保证它足够高。
    stage_identity_verified: bool = False
    mapping_status: str = 'needs_review'  # 默认待核对；唯一段位、唯一读数等条件成立后才能变为 verified。
    evidence: list = field(default_factory=list)
    reasons: list = field(default_factory=list)

@dataclass
# 整块保压表的档案：行列轴、逐格证据、冲突和可确认的启用段数都保留。
class LayoutResult:
    profile_id: str = 'b_and_r.injection_holding.multi_stage_position_time'
    section: str = 'holding'  # 区域：本模型为 holding。
    cells: list = field(default_factory=list)
    column_centers: list = field(default_factory=list)
    column_axis_evidence: dict = field(default_factory=dict)
    row_axes: list = field(default_factory=list)
    observed_borders: dict = field(default_factory=dict)
    ocr_observations: dict = field(default_factory=dict)
    stage_header_ids: list = field(default_factory=list)
    state_evidence: list = field(default_factory=list)
    conflicts: list = field(default_factory=list)
    stage_identity_verified: bool = False
    active_stages: int | None = None  # 确认的启用段数；证据不足保持 None，不用 0 假装未启用。

# 通用小算式：矩形左右/上下各取平均，得到中心点。
def _center(box):
    return (box[0]+box[2])/2, (box[1]+box[3])/2

# 把观测按指定坐标聚类；coordinate 决定按高度分行，还是按横坐标分列。
def _groups(items, coordinate, tolerance):
    # 新建分组容器；后面用中心坐标把观测归到同一行或同一列。
    groups = []
    # 先沿指定坐标排序，避免输入 OCR 顺序影响分组。
    for item in sorted(items, key=coordinate):
        # 当前坐标离最近一组的中位坐标够近时并入，否则新开一组。
        if groups and abs(coordinate(item)-median(coordinate(i) for i in groups[-1])) < tolerance:
            groups[-1].append(item)
        else:
            groups.append([item])
    return groups

# 估计同一行的倾斜量：x 每增加一个像素，y 平均变化多少。
def _slope(points):
    # 把中心点列表拆成 x 列表和 y 列表。
    xs, ys = zip(*points)
    # 计算平均中心，用于最小二乘直线拟合。
    mx, my = sum(xs)/len(xs), sum(ys)/len(ys)
    # 横坐标分散程度；所有点 x 相同就无法估计斜率。
    denominator = sum((x-mx)**2 for x in xs)
    # 按中心点拟合斜率，分母为零时用 0；不读取工艺数值来推断倾斜。
    return sum((x-mx)*(y-my) for x, y in points)/denominator if denominator else 0.

# 最低限度的图像佐证：该区域是否存在灰度差异；不等于证明 OCR 字符正确。
def _ink_present(gray, box):
    if gray is None:
        return False
    x0, y0, x1, y1 = map(round, box)
    # 裁出框内灰度图并限制在图像边界以内，避免越界索引。
    patch = gray[max(0, y0):min(gray.shape[0], y1), max(0, x0):min(gray.shape[1], x1)]
    # 区域非空且不全是同一灰度才通过；无法据此区分 5.0 和 6.0。
    return bool(patch.size and patch.max() > patch.min())

# C. 保压重建总入口。推荐按下面 C1~C7 顺着读；返回布局证据和有空位的三行 OCR。
def build_holding_layout(tokens, boxes, title_y, end_y, size, gray, reference=None):
    """Return per-cell raw evidence and verified mappings, including missing cells.

    title_y/end_y are section-local limits in image pixels. The caller supplies
    only an independently verified sibling's stage-one rectangle as reference.
    Row keys follow this profile's three ordered rows, checked against any labels.
    Column identities need consistent printed numbering or the sibling reference.
    """
    # 先建一个待核验的空结果，不预先宣布任何格子或段数可信。
    result = LayoutResult()
    # 给每条 OCR 观测分配证据 ID，后面能追回原文字和原框。
    indexed = [(f'ocr-{i}', t) for i, t in enumerate(tokens)]
    # C1. 只取保压标题和下一区段之间、有真实 OCR 框的观测。
    local = [(tid, t) for tid, t in indexed if t.get('bbox')
             and title_y < _center(t['bbox'])[1] < end_y]
    # 保留原文字、置信度、框和来源行号，后续失败也不抹掉原始证据。
    result.ocr_observations = {tid: dict(text=t['text'], confidence=t.get('conf', 0), bbox=t['bbox'],
                                       line_index=t.get('line_index'))
                               for tid, t in local}
    # 识别速度/压力/时间行标签，供后续核对行语义。
    labels = [(tid, t) for tid, t in local if t['text'].strip() in LABELS]
    # 用本区文字高度中位数衡量分组容差，随图片缩放变化。
    text_height = median(t['bbox'][3]-t['bbox'][1] for _, t in local) if local else 0
    # 本区没有有效文字尺度时，不继续猜行列。
    if not text_height:
        result.conflicts.append('NO_SECTION_OBSERVATIONS')
        return result, [[], [], []]
    # 给本区真实边框编号，同时避开紧贴标题的段号框。
    borders = [(f'border-{i}', b) for i, b in enumerate(boxes)
               if title_y+1.5*text_height < _center(b)[1] < end_y]
    # 值区左界优先用行标签右边缘；没有标签时才用观测框左边缘。
    left = (max(t['bbox'][2] for _, t in labels)+text_height if labels
            else min((b[0] for _, b in borders), default=size[0]))
    # 用数字字形筛选候选文字，仅用于找位置，不把字符转换为工艺值。
    numbers = [(tid, t) for tid, t in local if NUMBER.fullmatch(t['text'].strip())
               and _center(t['bbox'])[0] > left
               and _center(t['bbox'])[1] > title_y+1.5*text_height]
    # 既没有数字位置也没有边框位置，就没有建行列轴的依据。
    if not numbers and not borders:
        result.conflicts.append('NO_ROW_COLUMN_OBSERVATIONS')
        return result, [[], [], []]
    # Fit shared local skew without using any numeric value or enabled state.
    # C2. 先按高度把数字大致分行，再用同一行的中心点估计倾斜。
    numeric_rows = _groups(numbers, lambda item: _center(item[1]['bbox'])[1], text_height*1.2)
    # 至少有两个文字中心才拟合该行斜率。
    slopes = [_slope([_center(t['bbox']) for _, t in row]) for row in numeric_rows if len(row) >= 2]
    # 整行数字证据没有时，只能依靠真实边框；先排除过矮的框。
    if not numbers:
        typical_height = median(b[3]-b[1] for _, b in borders)
        borders = [(bid, b) for bid, b in borders if b[3]-b[1] >= typical_height*.8]
    # 文字无法给出斜率时，改用同一行边框中心的几何证据。
    if not slopes and borders:
        border_rows = _groups(borders, lambda item: _center(item[1])[1],
                              median(b[3]-b[1] for _, b in borders)*.5)
        slopes = [_slope([_center(b) for _, b in row]) for row in border_rows if len(row) >= 2]
    # 多行估计取中位数；没有足够证据时按水平线计算，不声称测出了倾斜。
    slope = median(slopes) if slopes else 0.
    # 用 y-slope*x 计算“拉平后的高度”，找到数值区第一行。
    first_row = (min(_center(t['bbox'])[1]-slope*_center(t['bbox'])[0] for _, t in numbers+labels)
                 if numbers else min(_center(b)[1]-slope*_center(b)[0] for _, b in borders))
    # Stage-heading rectangles are observations too, but lie above the value
    # rows. Select by the local text axes, not by a screen-relative y window.
    borders = [(bid, b) for bid, b in borders
               if _center(b)[1]-slope*_center(b)[0] >= first_row-text_height*.5]
    # 把数字 OCR、边框、行标签放到同一种观测清单中，类型仍分别保留。
    observations = [dict(kind='ocr', id=tid, box=t['bbox'], token=t) for tid, t in numbers]
    observations += [dict(kind='border', id=bid, box=b) for bid, b in borders if b[0] >= left]
    observations += [dict(kind='label', id=tid, box=t['bbox'], row=LABELS[t['text'].strip()])
                     for tid, t in labels]
    # 可口读为：取这个观测中心的 y，再减去倾斜造成的高度变化 slope*x。
    projected = lambda item: _center(item['box'])[1]-slope*_center(item['box'])[0]
    height = median(b[3]-b[1] for _, b in borders) if borders else text_height*2
    # C3. 按去倾斜后的高度建行轴；标签、文字和框可以共同支持同一行。
    groups = _groups(observations, projected, max(text_height*1.2, height*.45))
    # 这里要得到三行物理格；行数不确定就保守拒绝，而不是强凑。
    if len(groups) != 3:
        result.conflicts.append('ROW_AXIS_AMBIGUOUS')
        return result, [[], [], []]
    # 按本页已知顺序对应速度、压力、时间，不借数值大小猜行名。
    for key, group in zip(ROWS, groups):
        # 如果几何分到“压力行”却看见“时间”标签，记录冲突，后面禁止相关格确认。
        conflicts = [o['id'] for o in group if o['kind'] == 'label' and o['row'] != key]
        # 每行保存名字、斜率、截距、标签证据和冲突，便于画图解释。
        result.row_axes.append(dict(row_key=key, slope=slope,
            intercept=median(projected(o) for o in group),
            label_ids=[o['id'] for o in group if o['kind'] == 'label'], conflicts=conflicts))
    # C4. 使用速度行建立列轴，先去掉左侧行标签。
    speed = [o for o in groups[0] if o['kind'] != 'label']
    widths = [o['box'][2]-o['box'][0] for o in speed if o['kind'] == 'border']
    # 从右往左取候选中心；本页物理段号也是从右往左。
    xs = sorted({_center(o['box'])[0] for o in speed}, reverse=True)
    # 只有一个中心无法确定列距，不猜剩余列。
    if len(xs) < 2:
        result.conflicts.append('COLUMN_AXIS_AMBIGUOUS')
        return result, [[], [], []]
    # 同一格的边框和文字中心可能稍有偏差，先把接近的观测聚成一列。
    merge = median(widths)*.25 if widths else text_height
    # 横坐标取负数排序，让聚类输出保持从右向左。
    columns = _groups(speed, lambda o: -_center(o['box'])[0], merge)
    centers = [median(_center(o['box'])[0] for o in group) for group in columns]
    if len(centers) < 2:
        result.conflicts.append('COLUMN_AXIS_AMBIGUOUS')
        return result, [[], [], []]
    # 用相邻已观察中心的最小间隔估计列距；它只是几何估计，不是工艺段数。
    pitch = min(a-b for a, b in zip(centers, centers[1:]))
    # 有边框则用实测典型宽度，无框时用列距的 90% 构造候选格宽。
    width = median(widths) if widths else pitch*.9
    if not .85*width < pitch < 1.3*width:
        result.conflicts.append('IRREGULAR_COLUMN_AXIS')
        return result, [[], [], []]
    # 以最右中心为临时原点，把各中心换成第几个列距；它还不是已确认段号。
    positions = [round((centers[0]-x)/pitch) for x in centers]
    # 每个中心都应接近规则列轴；偏差过大或超出本页最多五列的范围就拒绝。
    if (any(abs(centers[0]-i*pitch-x) > .2*pitch for i, x in zip(positions, centers))
            or positions[-1] >= 5):
        result.conflicts.append('IRREGULAR_COLUMN_AXIS')
        return result, [[], [], []]
    # 在已有轴覆盖范围内补齐逻辑列中心，中间漏框不会把后面的列向前压。
    result.column_centers = [centers[0]-i*pitch for i in range(positions[-1]+1)]
    # 按列中心和行轴生成候选速度格；这些只是预测位置，不是检测器找到的矩形。
    predicted_speed = [[round(x-width/2), round(result.row_axes[0]['intercept']+slope*x-height/2),
                        round(x+width/2), round(result.row_axes[0]['intercept']+slope*x+height/2)]
                       for x in result.column_centers]
    # C5. 再用印刷段号或已确认的射胶第一段参考，把临时列轴绑定到真实段号。
    result.stage_identity_verified = stage_identity(tokens, [predicted_speed], title_y/size[1], size, reference)
    # 即使印刷段号通过，兄弟表第一段位置冲突也不能放行。
    if reference is not None and abs(result.column_centers[0]-_center(reference)[0]) >= .35*width:
        result.stage_identity_verified = False
        result.conflicts.append('SIBLING_COLUMN_CONFLICT')
    # 记录能追溯的印刷段号 ID，不把几何预测伪装成 OCR 证据。
    result.stage_header_ids = [tid for tid, t in local if t['text'].strip() in {'1', '2', '3', '4', '5'}
                              and t.get('conf', 0) >= .8
                              and _center(t['bbox'])[1] < min(b[1] for b in predicted_speed)]
    # 把列轴来源和兄弟表参考一起放进结果，支持解释“为什么认为这是第一段”。
    result.column_axis_evidence = dict(stage_header_ids=result.stage_header_ids,
                                       reference_bbox=reference,
                                       reference_source='verified_injection_stage_one' if reference else None,
                                       source_ids=[o['id'] for o in speed])
    if not result.stage_identity_verified:
        result.conflicts.append('STAGE_IDENTITY_CONFLICT_OR_MISSING')
    # 速度行在本页比下两行多一个格，所以候选有效段数是速度列数减一。不是所有 B&R 页面都适用。
    n = len(result.column_centers)-1
    mapped_rows = []
    # C6. 逐行创建逻辑格，再给这些格绑定已观察到的内容。
    for key, group, axis in zip(ROWS, groups, result.row_axes):
        # 速度行保留多出来的格；压力和时间行各建 n 格。
        count = n+1 if key == 'velocity' else n
        # 先为每一段留空位，某段漏读不会导致下一段自动前移。
        mapped = [None]*count
        cells = []
        # 为本行每个逻辑列建立格子，索引 i 从 0 起，段号用 i+1。
        for i, x in enumerate(result.column_centers[:count]):
            cy = axis['intercept']+slope*x
            # 一格的身份由保压区、行名和物理段号共同决定；接下来的框仅是预测范围。
            cell = Cell('holding', key, i+1,
                        [round(x-width/2), round(cy-height/2), round(x+width/2), round(cy+height/2)],
                        stage_identity_verified=result.stage_identity_verified)
            cell.evidence = ['ordered_row_axis', 'regular_column_axis']+axis['label_ids']
            cell.evidence += result.stage_header_ids
            if reference is not None:
                cell.evidence.append('verified_sibling_stage_one')
            # 本行标签冲突会写到该行每一格的拒绝原因中。
            if axis['conflicts']:
                cell.reasons.append('ROW_LABEL_CONFLICT')
            cells.append(cell)
        # 先记录已按数字字形收进本行的 OCR，接着补收落入候选格的异常文字。
        assigned = {o['id'] for o in group if o['kind'] == 'ocr'}
        # 像 45.OO 这样的误读也应保留为原读数，不能因不是合法数字就无声消失。
        extra_text = [dict(kind='ocr', id=tid, box=t['bbox'], token=t) for tid, t in local
                      if tid not in assigned and any(
                          c.predicted_bbox[0] < _center(t['bbox'])[0] < c.predicted_bbox[2]
                          and c.predicted_bbox[1] < _center(t['bbox'])[1] < c.predicted_bbox[3]
                          for c in cells)]
        for observation in [o for o in group if o['kind'] != 'label']+extra_text:
            x, _ = _center(observation['box'])
            # 按中心与列轴距离找归属；必须唯一落入一个允许区间，不能选最近的一格强塞。
            indexes = [i for i, cx in enumerate(result.column_centers[:count]) if abs(cx-x) < .25*pitch]
            # 找不到唯一列时记为离轴证据；整行都会保留这一冲突。
            if len(indexes) != 1:
                # A visible off-axis box is contrary evidence; never silently skip it.
                for cell in cells:
                    cell.reasons.append('OFF_AXIS_'+observation['kind'].upper())
                continue
            cell = cells[indexes[0]]
            if observation['kind'] == 'border':
                # 只有真的观测到边框，才把边框 ID 放进这里；预测框不会进入这个列表。
                cell.observed_border_ids.append(observation['id'])
                result.observed_borders[observation['id']] = observation['box']
            else:
                t = observation['token']
                cell.ocr_token_ids.append(observation['id'])
                # 保留 OCR 原文，不在布局层把 6.0 改成“应该是”的 5.0。
                cell.raw_reading.append(t['text'])
                cell.ocr_confidences.append(t.get('conf', 0))
        for i, cell in enumerate(cells):
            # 一格没有读数是 missing；有多条候选是 ambiguous；都不能直接作为已验证绑定。
            if len(cell.ocr_token_ids) != 1:
                cell.reasons.append('OCR_MISSING' if not cell.ocr_token_ids else 'OCR_AMBIGUOUS')
            # 一格绑定多个边框也需核对，不能忽略重复框。
            if len(cell.observed_border_ids) > 1:
                cell.reasons.append('BORDER_AMBIGUOUS')
            if not result.stage_identity_verified:
                cell.reasons.append('STAGE_IDENTITY_UNVERIFIED')
            hits = [o for o in group+extra_text if o['kind'] == 'ocr' and o['id'] in cell.ocr_token_ids]
            # 读数虽然唯一，但相应图像区域没有灰度差异，也要待核对。
            if len(hits) == 1 and not _ink_present(gray, hits[0]['box']):
                cell.reasons.append('OCR_IMAGE_EVIDENCE_MISSING')
            # 只有没有上述拒绝原因时，才确认空间归属；数值和置信度仍由提取层进一步判断。
            if not cell.reasons:
                # 把本格空间映射从默认 needs_review 改为 verified。
                cell.mapping_status = 'verified'
                # 把唯一 OCR 放回原段位的槽位；没有通过的格仍保留 None。
                mapped[i] = hits[0]['token']
            # 不论通过还是待核对，都保存这个逻辑格及证据。
            result.cells.append(cell)
        mapped_rows.append(mapped)
    # Count belongs to page state, not routing. Measured row extents can be
    # borders or jointly labeled OCR coordinates; predicted rectangles alone
    # cannot establish enabled stages. Numeric values are never inspected.
    # C7. 启用段数需要实际行末证据：下两行之一在末段确有边框，且无离轴/行标签冲突。
    endpoint = any(c.row_key != 'velocity' and c.stage_id == n and c.observed_border_ids
                   and not any(reason.startswith(('OFF_AXIS', 'ROW_LABEL')) for reason in c.reasons)
                   for c in result.cells)
    # 另一种证据是压力和时间两行都带标签，且各自末段都有已验证 OCR 绑定。
    joint_extents = all(axis['label_ids'] and any(
        c.row_key == axis['row_key'] and c.stage_id == n and c.mapping_status == 'verified'
        for c in result.cells) for axis in result.row_axes[1:])
    if endpoint:
        result.state_evidence.append('observed_lower_row_extent')
    if joint_extents:
        result.state_evidence.append('two_labeled_ocr_row_extents')
    # 段号已确认、两种范围证据至少有一种成立、各行无标签冲突，才确认启用段数。
    if result.stage_identity_verified and (endpoint or joint_extents) and not any(a['conflicts'] for a in result.row_axes):
        # 确认的是当前页面状态中的段数，不修改页面 profile，也不表示所有数值都读对。
        result.active_stages = n
    else:
        result.conflicts.append('ACTIVE_STAGE_EXTENT_UNVERIFIED')
    return result, mapped_rows

# 把布局档案转成普通字典，交给诊断输出/JSON 保存；不是另一次识别。
def layout_evidence(layout):
    return asdict(layout)


# 辅助像素证据：寻找唯一的深色到灰色边界；置信度或 OCR 数量不等于启用证据。
def _visual_active_count(cells: list, gray) -> int | None:
    """B&R semantics: one verified dark-to-gray boundary on physical cells.

    OCR confidence and token count cannot establish cell visibility. The same
    physical image yields the same state evidence even when OCR misses text.
    """
    if gray is None or not cells:
        return None
    evidence = [cell_glyph_evidence(gray, box) for box in cells]
    if any(item is None or item["contrast"] is None for item in evidence):
        return None
    contrasts = [item["contrast"] for item in evidence]
    candidates = [split for split in range(1, len(cells))
                  if min(contrasts[:split]) - max(contrasts[split:]) >= 25
                  and min(contrasts[:split]) >= 1.2 * max(contrasts[split:])]
    return candidates[0] if len(candidates) == 1 else None


# ===== v2 兼容布局定位：保留旧坐标规则，不宣称已等同逻辑网格 =====

# D. v2 兼容入口，只返回字段的候选位置和冲突，不把匹配文字转为 float。
def build_raw_layout(lines, meta, definition, number_pattern):
    # v2 输入是 OCR 原始行；使用矫正图宽高把框中心转成归一化坐标。
    width, height = meta["screen_size"]
    cells = []
    for line in lines:
        box = _line_box(line)
        # 保留原行、文字、位置和数字字形匹配；match 中的文本由 extractor 读取数值。
        cells.append(dict(line=line, text=re.sub(r"\s+", "", line["text"]),
                          x=(box[0] + box[2]) / (2 * width),
                          y=(box[1] + box[3]) / (2 * height), match=number_pattern.fullmatch(line["text"])))

    sections, issues = {}, list(definition["issues"])
    # 先确定射胶和保压标题，再在各自区域找行标签、段号和数值位置。
    for section, label in (("injection", "射胶"), ("holding", "保压")):
        titles = [c for c in cells if c["text"] == label and .3 < c["x"] < .8 and .3 < c["y"] < .68]
        # 标题必须唯一，缺失或重复都不能继续套用这份 v2 定义。
        if len(titles) != 1:
            raise ValueError("BOLE_INJECTION_LAYOUT_UNVERIFIED")
        title = titles[0]
        heads = sorted([c for c in cells if c["text"] in {"1", "2", "3", "4", "5"}
                        and .2 < c["x"] < .95 and 0 < c["y"] - title["y"] < .04], key=lambda c: c["x"])
        ids = [int(c["text"]) for c in heads]
        conflict = len(ids) != len(set(ids))
        if conflict:
            issues.append(dict(code="STAGE_IDENTITY_CONFLICT", section=section))
        if set(ids) != {1, 2, 3, 4, 5}:
            issues.append(dict(code="STAGE_HEADERS_PARTIAL", section=section))
        sections[section] = dict(title=title, heads=heads, conflict=conflict)
    if not sections["injection"]["title"]["y"] < sections["holding"]["title"]["y"]:
        raise ValueError("BOLE_INJECTION_LAYOUT_CONFLICT")

    entries = []
    # 每个字段定义给出物理区域、行标签和段号；这里为它找候选观测。
    for spec in definition["fields"]:
        section = spec["section"]
        source_label, header, options, order = None, None, [], spec.get("order")
        conflict = False
        # 分段字段按本区域行标签和段号的交点定位。
        if spec.get("stage"):
            table = sections[section]
            y0 = table["title"]["y"]
            y1 = sections["holding"]["title"]["y"] if section == "injection" else .7
            labels = [c for c in cells if c["text"] in spec["labels"] and c["x"] < .2 and y0 < c["y"] < y1]
            source_label = labels[0] if len(labels) == 1 else None
            matching = [c for c in table["heads"] if int(c["text"]) == spec["stage"]]
            header = matching[0] if len(matching) == 1 else None
            conflict = table["conflict"] or len(labels) > 1
            if source_label and not conflict:
                physical_slot = (min(range(1, 6), key=lambda stage: abs(
                    definition["stage_column_centers"][str(stage)] - header["x"])) if header else spec["stage"])
                order = (table["heads"].index(header) + 1 if header and len(table["heads"]) == 5 else 6 - physical_slot)
                hx = header["x"] if header else definition["stage_column_centers"][str(spec["stage"])]
                options = [c for c in cells if c["match"] and abs(c["y"] - source_label["y"]) < .013
                           and abs(c["x"] - hx) < .075]
        # 非分段数值按定义中的标签区域和相对方向定位；布尔控件沿用原来的 unsupported 行为。
        elif spec.get("value_type") != "boolean":
            labels = [c for c in cells if c["text"] in spec["labels"]
                      and spec["label_region"][0] < c["x"] < spec["label_region"][2]
                      and spec["label_region"][1] < c["y"] < spec["label_region"][3]]
            source_label = labels[0] if len(labels) == 1 else None
            conflict = len(labels) > 1
            if source_label:
                if spec.get("direction") == "right":
                    options = [c for c in cells if c["match"] and .04 < c["x"] - source_label["x"] < .25
                               and abs(c["y"] - source_label["y"]) < .018]
                else:
                    options = [c for c in cells if c["match"] and 0 < c["y"] - source_label["y"] < .05
                               and abs(c["x"] - source_label["x"]) < .065]
        # 返回原字段定义、标签、段号、候选数值位置和冲突；不在这里决定读数可信度或单位。
        entries.append(dict(spec=spec, source_label=source_label, header=header,
                            options=options, order=order, conflict=conflict, cells=cells))
    return entries, issues

# 教学例子（非现场准确率声明）：
# 速度格中心从右向左为 [300, 200, 100]，格宽约 90，列距为 100。
# 压力/时间行各有两格，故 n=3-1=2。段号 1 位于最右格上方且能唯一匹配时，
# 段轴可以确认。若末段边框成立、行标签无冲突，active_stages 可为 2。
# 若压力第一格漏框但 OCR“45.00”唯一且有图像证据，仍可绑定第一段；边框 ID 为空。
# 若第二段上方却印着“1”，stage_identity 会因列身份与印刷段号矛盾返回 False。
# 若最右格被裁掉，也不能把剩余第一格冒充段1：兄弟表参考相差一个列距时会拒绝。
# 若只是 OCR 把 5.0 读成 6.0，布局可能仍通过；本算法没有证据把它改回 5.0。


# 区段边界与粗分行也属于布局；这里只按文字形态选候选，不解释工艺数值。
VALUE_TEXT = re.compile(r"\d+\.?\d*")

def _section_y(toks, header, anchor_after=None):
    """深色条区段标题（居中 x 0.35~0.65，无固定 y 窗——照片倾斜/裁剪逐图漂移）。
    anchor_after：有多个同名命中时，取 y 大于该值中最近的一个（射胶<保压<保压切换 链式定位）。"""
    hits = [t for t in toks
            if 0.35 < t["x"] < 0.65 and _anchor_match(header, t["text"])]
    if anchor_after is not None:
        hits = [t for t in hits if t["y"] > anchor_after]
    return min(hits, key=lambda t: t["y"])["y"] if hits else None

def _value_rows(toks, y_lo, y_hi, gap):
    """区段内数值 token 按 y 聚类成值行（上→下），每行内按 x 降序=段1→段N。
    段头裸数字（'1'..'5'）排除——本页值均为 X.X 形态。"""
    sel = [t for t in toks if y_lo < t["y"] < y_hi and t["x"] > 0.1
           and VALUE_TEXT.fullmatch(t['text'].strip()) is not None
           and not re.fullmatch(r"\d{1,2}", t["text"].strip())]
    sel.sort(key=lambda t: t["y"])
    clusters = []
    for t in sel:
        if clusters and t["y"] - clusters[-1][-1]["y"] <= gap:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    return [sorted(cl, key=lambda t: -t["x"]) for cl in clusters]
