# Reference detector (mirrors the browser pipeline): letterbox -> ONNX -> decode (+NMS for v8 heads).
import numpy as np, onnxruntime as ort, cv2

ANIMALS = {14, 15, 16, 17, 18, 19, 21}  # bird, cat, dog, horse, sheep, cow, bear (COCO ids)

def nms(cand, thr):
    cand = sorted(cand, key=lambda b: -b[4])
    keep = []
    for b in cand:
        ok = True
        for k in keep:
            ix = min(b[2], k[2]) - max(b[0], k[0]); iy = min(b[3], k[3]) - max(b[1], k[1])
            if ix > 0 and iy > 0:
                inter = ix * iy
                u = (b[2] - b[0]) * (b[3] - b[1]) + (k[2] - k[0]) * (k[3] - k[1]) - inter
                if inter / u > thr: ok = False; break
        if ok: keep.append(b)
        if len(keep) >= 300: break
    return keep

class Det:
    def __init__(self, path, kind):
        self.s = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        self.inp = self.s.get_inputs()[0].name
        self.size = self.s.get_inputs()[0].shape[2]
        self.kind = kind  # 'e2e' (YOLO26 COCO), 'e2e1' (single-class YOLO26) or 'v8' (single-class sheep head)

    def __call__(self, img_bgr, roi=None, conf=0.1):
        H, W = img_bgr.shape[:2]
        x0, y0, x1, y1 = roi or (0, 0, W, H)
        crop = img_bgr[y0:y1, x0:x1]
        ch, cw = crop.shape[:2]
        S = self.size
        r = min(S / cw, S / ch)
        nw, nh = round(cw * r), round(ch * r)
        px, py = (S - nw) // 2, (S - nh) // 2
        canvas = np.full((S, S, 3), 114, np.uint8)
        canvas[py:py + nh, px:px + nw] = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_LINEAR)
        x = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        out = self.s.run(None, {self.inp: x})[0][0]
        boxes = []
        if self.kind == 'e2e':
            for bx1, by1, bx2, by2, sc, cl in out:
                if sc < conf or int(cl) not in ANIMALS: continue
                if int(cl) != 18: sc *= 0.85
                boxes.append([bx1, by1, bx2, by2, sc])
        elif self.kind == 'e2e1':  # single-class site model (YOLO26 end-to-end, class 0 = sheep)
            for bx1, by1, bx2, by2, sc, cl in out:
                if sc >= conf: boxes.append([bx1, by1, bx2, by2, sc])
        if self.kind in ('e2e', 'e2e1'):
            boxes = nms(boxes, 0.65)  # same loose NMS as the browser: drops rare duplicate boxes
        else:
            o = out.T  # 8400 x 5
            m = o[:, 4] >= conf
            o = o[m]
            cand = [[cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, sc] for cx, cy, w, h, sc in o]
            boxes = nms(cand, 0.5)
        res = []
        for bx1, by1, bx2, by2, sc in boxes:
            res.append(dict(x1=float((bx1 - px) / r + x0), y1=float((by1 - py) / r + y0), x2=float((bx2 - px) / r + x0), y2=float((by2 - py) / r + y0), score=float(sc)))
        return res
