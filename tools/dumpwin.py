# Like dumpdets.py, for a time window only: dumpwin.py VIDEO MODEL kind fps out.json t0 t1
import sys, json, cv2, time
from refdet import Det
video, model, kind, fps, out, t0w, t1w = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5], float(sys.argv[6]), float(sys.argv[7])
det = Det(model, kind)
cap = cv2.VideoCapture(video)
vfps = cap.get(cv2.CAP_PROP_FPS) or 30
W, H = int(cap.get(3)), int(cap.get(4))
k0 = int(t0w * vfps); cap.set(cv2.CAP_PROP_POS_FRAMES, k0)
frames = []; k = k0; nextT = k0 / vfps; tic = time.time()
while True:
    ok, fr = cap.read()
    if not ok: break
    t = k / vfps
    if t > t1w: break
    if t + 1e-6 >= nextT:
        d = det(fr, conf=0.1)
        frames.append({'i': k, 't': round(t, 4), 'boxes': [{kk: round(v, 2) if kk != 'score' else round(v, 4) for kk, v in b.items()} for b in d]})
        nextT += 1.0 / fps
    k += 1
json.dump({'W': W, 'H': H, 'vfps': vfps, 'fps': fps, 'frames': frames}, open(out, 'w'))
print('frames', len(frames), 'time', round(time.time() - tic, 1), 's')
