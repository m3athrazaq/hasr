# Crash/resume and offline test: reload in the middle of a count, resume it, then work offline.
import asyncio, sys, time
from playwright.async_api import async_playwright
CAM = sys.argv[1]
async def draw_line(pg, L):
    box = await pg.locator('#stage').bounding_box()
    vw, vh = await pg.evaluate("[document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]")
    s = min(box['width'] / vw, box['height'] / vh); w, h = vw * s, vh * s
    ox, oy = box['x'] + (box['width'] - w) / 2, box['y'] + (box['height'] - h) / 2
    x1, y1, x2, y2 = ox + L[0] * w, oy + L[1] * h, ox + L[2] * w, oy + L[3] * h
    await pg.mouse.move(x1, y1 - 30); await pg.mouse.move(x1, y1); await pg.mouse.down(); await pg.mouse.move(x2, y2, steps=8); await pg.mouse.up()
async def ready(pg):
    await pg.wait_for_function("!document.getElementById('btnStart').disabled && document.getElementById('modelState').classList.contains('ok')", timeout=300000)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={CAM}'])
        ctx = await b.new_context(viewport={'width': 1280, 'height': 800}, permissions=['camera'])
        pg = await ctx.new_page()
        pg.on('pageerror', lambda e: print('PAGEERROR', e))
        await pg.goto('http://localhost:8765/')
        await pg.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller", timeout=60000)
        print('sw controlling, coi =', await pg.evaluate('self.crossOriginIsolated'))
        await pg.click('#btnNew'); await pg.fill('#fVessel', 'اختبار الاستئناف'); await pg.click('#newForm button[type=submit]')
        await pg.wait_for_function("document.getElementById('modelState').textContent.length > 0 && !document.getElementById('modelState').textContent.includes('جارٍ')", timeout=300000)
        await draw_line(pg, [0.05, 0.72, 0.75, 0.45]); await ready(pg)
        await pg.click('#btnStart'); await pg.wait_for_timeout(20000)
        await pg.click('#btnPlus')
        before = await pg.inner_text('#cntFinal'); print('count before crash:', before)
        await pg.wait_for_timeout(2500)  # let the debounced save run
        # simulate a crash: reload the page without finishing
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await pg.reload()
        await pg.wait_for_selector('#resumeCard:not([hidden])', timeout=20000)
        print('resume card count:', await pg.inner_text('#resumeCount'))
        await pg.click('#btnResume')
        await ready(pg)
        await pg.click('#btnStart'); await pg.wait_for_timeout(8000)
        print('count after resume:', await pg.inner_text('#cntFinal'))
        await pg.click('#btnFinish'); await pg.locator('#sheetActions .btn.danger').click()
        await pg.wait_for_selector('#scr-report:not([hidden])', timeout=60000)
        print('final:', await pg.inner_text('.rep-final'))
        # offline: the shell, models and runtime should all come from the cache
        await ctx.set_offline(True)
        await pg.goto('http://localhost:8765/')
        await pg.wait_for_selector('#btnNew', state='visible', timeout=20000)
        print('offline home ok; history items:', await pg.locator('#recentBox .hitem').count())
        await pg.click('#btnNew'); await pg.fill('#fVessel', 'بدون إنترنت'); await pg.click('#newForm button[type=submit]')
        await pg.wait_for_function("document.getElementById('modelState').textContent.length > 0 && !document.getElementById('modelState').textContent.includes('جارٍ')", timeout=300000)
        await draw_line(pg, [0.05, 0.72, 0.75, 0.45]); await ready(pg)
        print('offline model:', await pg.inner_text('#modelState'))
        await b.close()
asyncio.run(main())
