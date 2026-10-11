# Render tracks, the counting line and the running count onto the video (for visual verification).
import sys, json, cv2, numpy as np
video, runf, out = sys.argv[1], sys.argv[2], sys.argv[3]
scale = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
R = json.load(open(runf))
byi = {f['i']: f for f in R['frames']}
crossAt = {}
for e in R['events']:
    if e['kind'] == 'cross': crossAt.setdefault(e['track'], []).append((e['t'], e['dir']))
cap = cv2.VideoCapture(video); fps = cap.get(cv2.CAP_PROP_FPS) or 30
W, H = R['W'], R['H']
vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*'mp4v'), fps, (int(W * scale), int(H * scale)))
L = R['line']; p1 = (int(L['x1'] * W), int(L['y1'] * H)); p2 = (int(L['x2'] * W), int(L['y2'] * H))
k = 0; last = None
while True:
    ok, fr = cap.read()
    if not ok: break
    if k in byi: last = byi[k]
    cv2.line(fr, p1, p2, (0, 200, 255), 4)
    if last:
        for tr in last['tracks']:
            x1, y1, x2, y2 = tr['b']
            counted = any(t <= last['t'] for t, d in crossAt.get(tr['id'], []))
            col = (0, 220, 0) if counted else (255, 255, 255) if tr['s'] == 'c' else (128, 128, 128)
            cv2.rectangle(fr, (x1, y1), (x2, y2), col, 3)
            cv2.putText(fr, str(tr['id']), (x1 + 4, y1 + 30), cv2.FONT_HERSHEY_SIMPLEX, 1.0, col, 2)
        cv2.rectangle(fr, (0, 0), (330, 70), (0, 0, 0), -1)
        cv2.putText(fr, f"count {last['auto']}  f{k}", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 255, 255), 3)
    vw.write(cv2.resize(fr, (int(W * scale), int(H * scale))))
    k += 1
vw.release(); print('rendered', k, 'frames')
