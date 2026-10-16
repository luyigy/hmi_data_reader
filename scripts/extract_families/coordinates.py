"""Shared geometric projection; coordinates retain the original-percent contract."""

def project_boxes(observations, meta):
    """用矫正时的屏幕四角将字段框投回原图百分比坐标；元数据缺失则保持未定位。"""
    if not meta.get('original_size') or not meta.get('screen_quad'):
        return
    import cv2
    import numpy as np
    from quality import order_points
    w, h = meta['screen_size']
    ow, oh = meta['original_size']
    src = np.array([[0, 0], [w-1, 0], [w-1, h-1], [0, h-1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(src, order_points(np.array(meta['screen_quad'], dtype=np.float32)))
    for observation in observations:
        if observation['bbox'] is None:
            continue
        x1, y1, x2, y2 = observation['bbox']
        corners = np.array([[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]], dtype=np.float32)
        points = cv2.perspectiveTransform(corners, matrix)[0]
        box = [float(points[:, 0].min()/ow*100), float(points[:, 1].min()/oh*100),
               float(points[:, 0].max()/ow*100), float(points[:, 1].max()/oh*100)]
        if all(0 <= value <= 100 for value in box) and box[0] < box[2] and box[1] < box[3]:
            observation['original_bbox'] = box
