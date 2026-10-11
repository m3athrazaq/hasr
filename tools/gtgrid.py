# Verification sheets: race crops at a fixed rate with tracks, the counting line and numbered crossings,
# so every crossing (and every miss) can be checked by eye against the real footage.
# usage: gtgrid.py VIDEO RUN.json OUTPREFIX t0 t1 [fps=5] [x0,x1 crop] [cols=8] [rows=3] [tile width=200] [y0,y1 crop]
import sys, json, cv2
import numpy as np

video, runf, outp = sys.argv[1], sys.argv[2], sys.argv[3]
t0, t1 = float(sys.argv[4]), float(sys.argv[5])
fps = float(sys.argv[6]) if len(sys.argv) > 6 else 5
cx0, cx1 = (int(v) for v in sys.argv[7].split(',')) if len(sys.argv) > 7 else (230, 630)
cols = int(sys.argv[8]) if len(sys.argv) > 8 else 8
rows = int(sys.argv[9]) if len(sys.argv) > 9 else 3
tw = int(sys.argv[10]) if len(sys.argv) > 10 else 200

R = json.load(open(runf))
W, H = R['W'], R['H']
cy0, cy1 = (int(v) for v in sys.argv[11].split(',')) if len(sys.argv) > 11 else (0, H)
L = R['line']
byi = {f['i']: f for f in R['frames']}
cross = sorted([e for e in R['events'] if e['kind'] == 'cross'], key=lambda e: e['t'])
num = {}  # track id -> list of (t, label)
n = 0
for e in cross:
    n += e['dir']
    num.setdefault(e['track'], []).append((e['t'], f"{'+' if e['dir'] > 0 else '-'}{n}"))

def label(im, txt, x, y, col):
    (w, h), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
    cv2.rectangle(im, (x - 2, y - h - 4), (x + w + 2, y + 4), (0, 0, 0), -1)
    cv2.putText(im, txt, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, col, 2)

cap = cv2.VideoCapture(video)
vfps = cap.get(cv2.CAP_PROP_FPS) or 30
tiles, last, k, nextT = [], None, 0, t0
s = tw / (cx1 - cx0)
th = int(round((cy1 - cy0) * s))
while True:
    ok, fr = cap.read()
    if not ok: break
    t = k / vfps
    if k in byi: last = byi[k]
    if t + 1e-6 >= nextT and t <= t1:
        nextT += 1 / fps
        im = fr.copy()
        cv2.line(im, (int(L['x1'] * W), int(L['y1'] * H)), (int(L['x2'] * W), int(L['y2'] * H)), (0, 0, 255), 2)
        labs_to_draw = []
        if last:
            for tr in last['tracks']:
                x1, y1, x2, y2 = tr['b']
                labs = [lab for tt, lab in num.get(tr['id'], []) if tt <= t + 1e-6]
                col = (0, 230, 0) if labs else (255, 255, 255) if tr['s'] == 'c' else (150, 150, 150)
                th_ = 2 if tr.get('u', True) else 1
                cv2.rectangle(im, (x1, y1), (x2, y2), col, th_)
                txt = (labs[-1] + f'/t{tr["id"]}') if labs else f't{tr["id"]}'
                labs_to_draw.append((txt, (x1 + x2) // 2 - 30, (y1 + y2) // 2, col))
        for txt, x, y, col in labs_to_draw: label(im, txt, max(cx0 + 2, x), min(max(cy0 + 20, y), cy1 - 4), col)
        tile = cv2.resize(im[cy0:cy1, cx0:cx1], (tw, th))
        cv2.rectangle(tile, (0, 0), (tw, 18), (0, 0, 0), -1)
        cnt = sum(e['dir'] for e in cross if e['t'] <= t + 1e-6)
        cv2.putText(tile, f'{t:.2f}s  n={cnt}', (3, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        cv2.rectangle(tile, (0, 0), (tw - 1, th - 1), (60, 60, 60), 1)
        tiles.append(tile)
    k += 1
    if t > t1: break

per = cols * rows
blank = np.zeros_like(tiles[0]) if tiles else None
for st in range(0, len(tiles), per):
    chunk = tiles[st:st + per]
    chunk += [blank] * (per - len(chunk))
    sheet = np.vstack([np.hstack(chunk[r * cols:(r + 1) * cols]) for r in range(rows)])
    cv2.imwrite(f'{outp}_{st // per:02d}.jpg', sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
print('tiles', len(tiles), 'sheets', (len(tiles) + per - 1) // per, 'crossings', len(cross), 'net', n)
