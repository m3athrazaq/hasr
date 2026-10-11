# Run the reference detector over a video at a fixed processing rate and save detections per frame.
import sys, json, cv2, time
from refdet import Det
video, model, kind, fps, out = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5]
roi = tuple(int(v) for v in sys.argv[6].split(',')) if len(sys.argv) > 6 else None
det = Det(model, kind)
cap = cv2.VideoCapture(video)
vfps = cap.get(cv2.CAP_PROP_FPS) or 30
W, H = int(cap.get(3)), int(cap.get(4))
frames = []
k = 0; nextT = 0.0; t0 = time.time()
while True:
    ok, fr = cap.read()
    if not ok: break
    t = k / vfps
    if t + 1e-6 >= nextT:
        d = det(fr, roi=roi, conf=0.1)
        frames.append({'i': k, 't': round(t, 4), 'boxes': [{kk: round(v, 2) if kk != 'score' else round(v, 4) for kk, v in b.items()} for b in d]})
        nextT += 1.0 / fps
    k += 1
json.dump({'W': W, 'H': H, 'vfps': vfps, 'fps': fps, 'frames': frames}, open(out, 'w'))
print('frames', len(frames), 'time', round(time.time() - t0, 1), 's')
