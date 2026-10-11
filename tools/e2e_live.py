# End-to-end browser test of live counting with a fake camera fed from a video file.
import asyncio, sys, time
from playwright.async_api import async_playwright
CAM = sys.argv[1]
LINE = [float(v) for v in sys.argv[2].split(',')]
VIEWPORT = sys.argv[3] if len(sys.argv) > 3 else '1280x800'
LANG = sys.argv[4] if len(sys.argv) > 4 else 'ar'
OUT = '/tmp/claude-0/live_' + VIEWPORT
W, H = map(int, VIEWPORT.split('x'))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={CAM}', '--autoplay-policy=no-user-gesture-required'])
        ctx = await b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=1, permissions=['camera'], is_mobile=W < 600, has_touch=W < 600)
        pg = await ctx.new_page()
        logs = []
        pg.on('console', lambda m: logs.append(m.type + ': ' + m.text))
        pg.on('pageerror', lambda e: print('PAGEERROR', e))
        await pg.goto('http://localhost:8765/')
        if LANG != 'ar':
            await pg.evaluate(f"localStorage.setItem('hasr.settings.v1', JSON.stringify({{lang: '{LANG}'}}))"); await pg.reload()
        await pg.wait_for_selector('#btnNew', state='visible')
        await pg.screenshot(path=f'{OUT}_home.png')
        await pg.click('#btnNew')
        await pg.fill('#fVessel', 'الكويت'); await pg.fill('#fVoyage', 'V-214'); await pg.fill('#fLocation', 'ميناء الشويخ'); await pg.fill('#fExpected', '40')
        await pg.screenshot(path=f'{OUT}_new.png')
        await pg.click('#newForm button[type=submit]')
        await pg.wait_for_function("document.getElementById('modelState').textContent.length > 0 && !document.getElementById('modelState').textContent.includes('جارٍ') && !document.getElementById('modelState').textContent.includes('Loading')", timeout=300000)
        box = await pg.locator('#stage').bounding_box()
        vw, vh = await pg.evaluate("[document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]")
        print('camera', vw, vh)
        s = min(box['width'] / vw, box['height'] / vh); w, h = vw * s, vh * s
        ox, oy = box['x'] + (box['width'] - w) / 2, box['y'] + (box['height'] - h) / 2
        x1, y1, x2, y2 = ox + LINE[0] * w, oy + LINE[1] * h, ox + LINE[2] * w, oy + LINE[3] * h
        await pg.mouse.move(x1, y1 - 30); await pg.mouse.move(x1, y1); await pg.mouse.down(); await pg.mouse.move(x2, y2, steps=8); await pg.mouse.up()
        await pg.wait_for_function("!document.getElementById('btnStart').disabled && document.getElementById('modelState').classList.contains('ok')", timeout=300000)
        print('model:', await pg.inner_text('#modelState'))
        await pg.wait_for_timeout(4000)
        await pg.screenshot(path=f'{OUT}_setup.png')
        await pg.click('#btnStart')
        await pg.wait_for_timeout(12000)
        await pg.click('#btnBatch'); await pg.click('#btnPlus'); await pg.click('#btnPlus'); await pg.click('#btnMinus')
        await pg.wait_for_timeout(12000)
        await pg.screenshot(path=f'{OUT}_count.png')
        print('count:', await pg.inner_text('#cntFinal'), 'batch', await pg.inner_text('#batchN'), await pg.inner_text('#batchCount'), 'fps', await pg.inner_text('#kFps'), 'q', await pg.inner_text('#kQ'))
        await pg.click('#btnReview')
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f'{OUT}_review.png', full_page=True)
        n_cards = await pg.locator('.rcard').count(); print('review cards:', n_cards)
        if n_cards:
            await pg.locator('.rcard .ractions .btn').nth(1).click()
            await pg.wait_for_timeout(500)
        await pg.click('#scr-review [data-back]')
        await pg.click('#btnPause'); await pg.wait_for_timeout(1500); await pg.click('#btnPause')
        await pg.wait_for_timeout(5000)
        await pg.click('#btnFinish'); await pg.wait_for_selector('#sheet:not([hidden])')
        await pg.screenshot(path=f'{OUT}_finish.png')
        await pg.locator('#sheetActions .btn.danger').click()
        await pg.wait_for_selector('#scr-report:not([hidden])', timeout=60000)
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=f'{OUT}_report.png', full_page=True)
        print('FINAL:', await pg.inner_text('.rep-final'))
        print('figs:', (await pg.inner_text('.figs')).replace('\n', ' | '))
        await pg.click('#scr-report [data-back]')
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=f'{OUT}_home2.png', full_page=True)
        errs = [l for l in logs if l.startswith('error')]
        print('console errors:', errs[:6])
        await b.close()
asyncio.run(main())
