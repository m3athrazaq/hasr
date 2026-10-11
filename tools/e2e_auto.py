# End-to-end browser test of the fully automatic setup on a recorded video: no line is drawn and the
# view is left on "automatic", so the app must pick the model and draw the counting line by itself.
# usage: e2e_auto.py VIDEO [URL]
import asyncio, sys, time, json
from playwright.async_api import async_playwright
VIDEO = sys.argv[1]
URL = sys.argv[2] if len(sys.argv) > 2 else 'http://localhost:8765/'
OUT = '/tmp/claude-0/e2eauto'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = await b.new_context(viewport={'width': 1280, 'height': 800}, locale='ar')
        pg = await ctx.new_page()
        logs = []
        pg.on('console', lambda m: logs.append(m.text))
        pg.on('pageerror', lambda e: print('PAGEERROR', e))
        await pg.goto(URL)
        print('loaded', flush=True)
        await pg.wait_for_selector('#btnFile', state='visible')
        print('home ready', flush=True)
        await pg.click('#btnFile')
        await pg.fill('#fVessel', 'تجربة')
        await pg.fill('#fVoyage', 'WA0031')
        async with pg.expect_file_chooser() as fc:
            await pg.click('#newForm button[type=submit]')
        chooser = await fc.value
        await chooser.set_files(VIDEO)
        print('file set', flush=True)
        t0 = time.time()
        # wait until the automatic model choice and the automatic line are done
        cond = "window.__hasr && window.__hasr.autoLined && !window.__hasr.picking && !document.getElementById('btnStart').disabled"
        last = None
        while True:
            if await pg.evaluate(cond): break
            stt = await pg.evaluate("(() => { const S = window.__hasr || {}; return [document.getElementById('modelState').textContent, !!S.autoLined, !!S.picking, S.modelKey, document.getElementById('btnStart').disabled]; })()")
            if stt != last: print(round(time.time() - t0, 1), 's', stt, flush=True); last = stt
            if time.time() - t0 > 900: print('TIMEOUT'); await pg.screenshot(path=f'{OUT}_stuck.png'); break
            if int(time.time() - t0) in (30, 31):
                await pg.screenshot(path=f'{OUT}_30s.png'); print('console so far:', logs[-15:], flush=True)
            await pg.wait_for_timeout(1000)
        st = await pg.evaluate("(() => { const S = window.__hasr; return { model: S.modelKey, line: S.line, dir: S.dir, scores: S.pickScores || null }; })()")
        print('setup done in', round(time.time() - t0, 1), 's:', json.dumps(st))
        print('model state:', await pg.inner_text('#modelState'))
        await pg.screenshot(path=f'{OUT}_setup.png')
        await pg.evaluate("self.__hasrDebug = []")
        await pg.click('#btnStart')
        await pg.wait_for_timeout(20000)
        await pg.screenshot(path=f'{OUT}_count.png')
        print('count after 20s:', await pg.inner_text('#cntFinal'))
        await pg.wait_for_selector('#scr-report:not([hidden])', timeout=1800000)
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=f'{OUT}_report.png', full_page=True)
        print('FINAL:', await pg.inner_text('.rep-final'), 'elapsed', round(time.time() - t0), 's')
        print('figs:', (await pg.inner_text('.figs')).replace('\n', ' | '))
        async with pg.expect_download() as dl:
            await pg.click("#scr-report button:has-text('JSON')")
        d = await dl.value
        await d.save_as(f'{OUT}_session.json')
        print('saved session json')
        dbg = await pg.evaluate("JSON.stringify(self.__hasrDebug || [])")
        open(f'{OUT}_dets.json', 'w').write(dbg)
        print('saved detections', len(dbg))
        flags = await pg.evaluate("(() => { const s = window.__hasr.session || window.__hasr.lastSession; return s ? JSON.stringify((s.doc.flags || []).map((f) => [f.type, f.status || '', Math.round((f.t || 0) * 10) / 10])) : null; })()")
        print('flags:', flags)
        errs = [l for l in logs if 'rror' in l]
        if errs: print('console errors:', errs[:5])
        await b.close()

asyncio.run(main())
