# Ground-truth aid: a slit-scan of the pixels on the counting line (time runs downwards), with the
# app's counted crossings marked. Every animal that walks over the line leaves one blob, whether or
# not the detector saw it: a blob without a mark is a miss, a blob with two marks a double count.
# usage: slitcheck.py VIDEO RUN.json OUTPREFIX t0 t1 [x0,x1] [y] [px_per_frame=2] [chunk_s=6] [chunks_per_sheet=4]
import sys, json, cv2
import numpy as np

video, runf, outp = sys.argv[1], sys.argv[2], sys.argv[3]
t0, t1 = float(sys.argv[4]), float(sys.argv[5])
x0, x1 = (int(v) for v in sys.argv[6].split(',')) if len(sys.argv) > 6 else (250, 650)
yl = int(sys.argv[7]) if len(sys.argv) > 7 else 300
ppf = int(sys.argv[8]) if len(sys.argv) > 8 else 2
chunk = float(sys.argv[9]) if len(sys.argv) > 9 else 6.0
per = int(sys.argv[10]) if len(sys.argv) > 10 else 4

R = json.load(open(runf))
cross = sorted([e for e in R['events'] if e['kind'] == 'cross'], key=lambda e: e['t'])
cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
rows, times = [], []
k = 0
while True:
    ok, fr = cap.read()
    if not ok: break
    t = k / fps; k += 1
    if t < t0: continue
    if t > t1: break
    band = fr[yl - 1:yl + 1, x0:x1].mean(axis=0, keepdims=True).astype(np.uint8)
    rows.append(np.repeat(band, ppf, axis=0)); times.append(t)
img = np.vstack(rows)
W = x1 - x0
gutter = 90
n = 0
marks = []
for e in cross:
    n += e['dir']
    if not (t0 <= e['t'] <= t1): continue
    i = min(range(len(times)), key=lambda j: abs(times[j] - e['t']))
    cx = int((e['box']['x1'] + e['box']['x2']) / 2) - x0
    marks.append((i * ppf, cx, f"{'+' if e['dir'] > 0 else '-'}{n}", (0, 255, 0) if e['dir'] > 0 else (0, 0, 255)))
chunk_px = int(round(chunk * fps)) * ppf
sheets = []
for s in range(0, img.shape[0], chunk_px):
    part = img[s:s + chunk_px]
    canvas = np.zeros((chunk_px + 24, W + gutter, 3), np.uint8)
    canvas[24:24 + part.shape[0], gutter:] = part
    # time ticks every 0.5 s
    for j in range(0, part.shape[0], ppf):
        tt = times[(s + j) // ppf]
        if abs(tt * 2 - round(tt * 2)) < 0.5 / fps:
            y = 24 + j
            cv2.line(canvas, (gutter - 12, y), (gutter - 1, y), (200, 200, 200), 1)
            if abs(tt - round(tt)) < 0.5 / fps: cv2.putText(canvas, f'{tt:.0f}s', (4, y + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
    for (y, cx, lab, col) in marks:
        if s <= y < s + chunk_px:
            yy = 24 + y - s
            cv2.circle(canvas, (gutter + cx, yy), 5, col, -1)
            cv2.putText(canvas, lab, (gutter - 52, yy + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1)
            cv2.line(canvas, (gutter - 10, yy), (gutter + cx - 6, yy), col, 1)
    cv2.putText(canvas, f'{times[s // ppf]:.1f}-{times[min(len(times) - 1, (s + chunk_px) // ppf - 1)]:.1f}s', (gutter, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    sheets.append(canvas)
for i in range(0, len(sheets), per):
    grp = sheets[i:i + per]
    h = max(g.shape[0] for g in grp)
    grp = [np.vstack([g, np.zeros((h - g.shape[0], g.shape[1], 3), np.uint8)]) for g in grp]
    sep = np.full((h, 12, 3), 40, np.uint8)
    out = grp[0]
    for g in grp[1:]: out = np.hstack([out, sep, g])
    cv2.imwrite(f'{outp}_{i // per:02d}.png', out)
print('frames', len(times), 'sheets', (len(sheets) + per - 1) // per, 'marks', len(marks))
