// Image sources: device camera, a captured screen/window (CCTV viewer on Windows), or a video file.
// Each source plays into the shared <video> element.

export const canCaptureScreen = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export async function listCameras() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch {
    return [];
  }
}

function waitMeta(video) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.videoWidth) return resolve();
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('video error')); };
    const cleanup = () => { video.removeEventListener('loadedmetadata', ok); video.removeEventListener('error', bad); };
    video.addEventListener('loadedmetadata', ok);
    video.addEventListener('error', bad);
  });
}

export async function openCamera(video, { deviceId, hd = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('nocam'), { code: 'none' });
  const video0 = {
    width: { ideal: hd ? 1920 : 1280 }, height: { ideal: hd ? 1080 : 720 }, frameRate: { ideal: 30 },
  };
  if (deviceId) video0.deviceId = { exact: deviceId };
  else video0.facingMode = { ideal: 'environment' };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: video0, audio: false });
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw Object.assign(e, { code: 'denied' });
    if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
      if (deviceId) return openCamera(video, { hd });
      throw Object.assign(e, { code: 'none' });
    }
    throw e;
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await waitMeta(video);
  await video.play();
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  return {
    kind: 'camera', live: true, video, stream, track,
    deviceId: settings.deviceId || deviceId || '',
    label: track.label || 'camera',
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    stop() { for (const tr of stream.getTracks()) tr.stop(); video.srcObject = null; },
    onEnded(cb) { track.addEventListener('ended', cb); },
    zoomRange() {
      const c = track.getCapabilities ? track.getCapabilities() : {};
      return c.zoom ? { min: c.zoom.min, max: c.zoom.max, step: c.zoom.step || 0.1, value: track.getSettings().zoom || c.zoom.min } : null;
    },
    async setZoom(z) { try { await track.applyConstraints({ advanced: [{ zoom: z }] }); } catch { /* not supported */ } },
  };
}

export async function openScreen(video) {
  if (!canCaptureScreen()) throw Object.assign(new Error('noscreen'), { code: 'screen' });
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
  video.srcObject = stream;
  video.muted = true;
  await waitMeta(video);
  await video.play();
  const track = stream.getVideoTracks()[0];
  return {
    kind: 'screen', live: true, video, stream, track, label: track.label || 'screen',
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    stop() { for (const tr of stream.getTracks()) tr.stop(); video.srcObject = null; },
    onEnded(cb) { track.addEventListener('ended', cb); },
    zoomRange() { return null; },
    async setZoom() {},
  };
}

export async function openFile(video, file) {
  const url = URL.createObjectURL(file);
  video.srcObject = null;
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  await waitMeta(video);
  video.pause();
  try { video.currentTime = 0; } catch { /* ignore */ }
  return {
    kind: 'file', live: false, video, label: file.name, fileName: file.name, size: file.size,
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    get duration() { return video.duration; },
    stop() { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); },
    onEnded(cb) { video.addEventListener('ended', cb); },
    zoomRange() { return null; },
    async setZoom() {},
  };
}

// Resolve on the next decoded frame (requestVideoFrameCallback when available)
export function nextFrame(video, maxWait = 60) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (meta) => { if (!done) { done = true; resolve(meta || null); } };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback((now, meta) => finish(meta));
    setTimeout(() => finish(null), maxWait);
  });
}
