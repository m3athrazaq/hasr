# End-to-end browser test: count a recorded video through the real UI and read the report.
import asyncio, sys, time
from playwright.async_api import async_playwright
VIDEO = sys.argv[1]
LINE = [float(v) for v in sys.argv[2].split(',')]  # normalised x1,y1,x2,y2
DIR = int(sys.argv[3]) if len(sys.argv) > 3 else 0  # 0 = keep automatic arrow, else flip if needed
VIEW = sys.argv[4] if len(sys.argv) > 4 else 'auto'
OUT = '/tmp/claude-0/e2e'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = await b.new_context(viewport={'width': 1280, 'height': 800}, locale='ar')
        pg = await ctx.new_page()
        logs = []
        pg.on('console', lambda m: logs.append(m.text))
        pg.on('pageerror', lambda e: print('PAGEERROR', e))
        await pg.goto('http://localhost:8765/')
        await pg.wait_for_selector('#btnFile', state='visible')
        await pg.screenshot(path=f'{OUT}_home.png')
        if VIEW != 'auto':
            await pg.evaluate(f"localStorage.setItem('hasr.settings.v1', JSON.stringify({{view: '{VIEW}'}}))")
            await pg.reload(); await pg.wait_for_selector('#btnFile', state='visible')
        await pg.click('#btnFile')
        await pg.fill('#fVessel', 'الكويت')
        await pg.fill('#fVoyage', 'T-01')
        async with pg.expect_file_chooser() as fc:
            await pg.click('#newForm button[type=submit]')
        chooser = await fc.value
        await chooser.set_files(VIDEO)
        t0 = time.time()
        await pg.wait_for_function("document.getElementById('modelState').textContent.length > 0 && !document.getElementById('modelState').textContent.includes('جارٍ')", timeout=300000)
        print('runtime ready in', round(time.time() - t0, 1), 's:', await pg.inner_text('#modelState'))
        # draw the counting line
        box = await pg.locator('#stage').bounding_box()
        vw, vh = await pg.evaluate("[document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]")
        s = min(box['width'] / vw, box['height'] / vh); w, h = vw * s, vh * s
        ox, oy = box['x'] + (box['width'] - w) / 2, box['y'] + (box['height'] - h) / 2
        x1, y1, x2, y2 = ox + LINE[0] * w, oy + LINE[1] * h, ox + LINE[2] * w, oy + LINE[3] * h
        await pg.mouse.move(x1 + 40, y1 + 40)  # start away from old endpoints
        await pg.mouse.move(x1, y1); await pg.mouse.down(); await pg.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, steps=5); await pg.mouse.move(x2, y2, steps=5); await pg.mouse.up()
        if DIR == -1:
            await pg.click('#btnFlip')
        await pg.wait_for_function("!document.getElementById('btnStart').disabled && document.getElementById('modelState').classList.contains('ok')", timeout=300000)
        print('model picked:', await pg.inner_text('#modelState'))
        await pg.screenshot(path=f'{OUT}_setup.png')
        await pg.click('#btnStart')
        await pg.wait_for_timeout(15000)
        await pg.screenshot(path=f'{OUT}_count.png')
        print('count after 15s:', await pg.inner_text('#cntFinal'), '|', await pg.inner_text('#fileText'))
        await pg.wait_for_selector('#scr-report:not([hidden])', timeout=900000)
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=f'{OUT}_report.png', full_page=True)
        print('FINAL:', await pg.inner_text('.rep-final'), 'elapsed', round(time.time() - t0), 's')
        print('figs:', (await pg.inner_text('.figs')).replace('\n', ' | '))
        errs = [l for l in logs if 'rror' in l]
        if errs: print('console errors:', errs[:5])
        await b.close()
asyncio.run(main())
