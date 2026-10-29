"""Synthetic brand-neutral geometry tests. These are not photo acceptance."""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from extract_families.visual_cells import bordered_cells, cell_glyph_evidence, tokens_in_cells


def table_image():
    gray = np.full((800,1000),240,np.uint8)
    boxes = [[x,200,x+120,234] for x in (200,340,480)]
    for box in boxes:
        x0,y0,x1,y1 = box
        cv2.rectangle(gray,(x0,y0),(x1,y1),30,2)
        cv2.putText(gray,'5.0',(x0+40,y0+24),cv2.FONT_HERSHEY_SIMPLEX,.65,30,2)
    return gray, boxes


def test_closed_cells_are_found_without_any_ocr():
    gray, boxes = table_image()
    found = bordered_cells(gray)
    assert len(found) == 3
    assert all(any(abs(a-b)<5 for a,b in [(box[0],candidate[0])]) for box,candidate in zip(sorted(boxes),sorted(found)))
    evidence = [cell_glyph_evidence(gray,b) for b in found]
    assert all(e and e['contrast'] > 100 for e in evidence)
    assert all('state' not in e for e in evidence)


def test_missing_and_duplicate_tokens_do_not_shift_other_cells():
    _, boxes = table_image()
    tokens = [dict(text=str(i),bbox=[b[0]+45,b[1]+8,b[0]+75,b[1]+26]) for i,b in enumerate(boxes)]
    assert tokens_in_cells([tokens[0],tokens[2]],boxes) == [tokens[0],None,tokens[2]]
    assert tokens_in_cells(tokens+[tokens[1]],boxes) == [tokens[0],None,tokens[2]]


def test_blank_and_border_only_cells_supply_no_glyph_evidence():
    gray = np.full((800,1000),240,np.uint8)
    box = [200,200,320,234]
    cv2.rectangle(gray,(200,200),(320,234),30,2)
    assert cell_glyph_evidence(gray,box) is None
    assert bordered_cells(None) == []
