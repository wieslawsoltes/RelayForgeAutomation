"""Optional browser integration test: pip install playwright; install Chromium separately."""
import json,os
from pathlib import Path
from playwright.sync_api import sync_playwright

out=Path(os.environ.get('OUTPUT_DIR',Path(__file__).resolve().parents[1]/'test-results'));out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    options={'headless':True}
    if os.environ.get('CHROMIUM_PATH'):options['executable_path']=os.environ['CHROMIUM_PATH']
    browser=p.chromium.launch(**options)
    page = browser.new_page(viewport={'width':1536,'height':1000}, device_scale_factor=1)
    errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: print('console:',m.type,m.text) if m.type=='error' else None)
    page.goto(os.environ.get('APP_URL','http://127.0.0.1:4173/'),wait_until='networkidle')
    page.wait_for_function('window.relayforge && window.relayforge.compilation?.ok')
    page.wait_for_timeout(600)
    print('initial:',page.evaluate('({mode:relayforge.mode, renderer:relayforge.renderer, stats:relayforge.renderStats, compilation:relayforge.compilation.ok})'))
    page.screenshot(path=str(out/'relayforge-initial.png'),full_page=True)
    page.locator('#editorToolbar [data-command="start-demo"]').click()
    page.wait_for_function('relayforge.snapshot.values.Motor === true', timeout=10000)
    page.wait_for_timeout(400)
    print('running:',page.evaluate('({mode:relayforge.mode, scan:relayforge.snapshot.scan, outputs:relayforge.snapshot.outputs, level:relayforge.snapshot.values.TankLevel})'))
    page.screenshot(path=str(out/'relayforge-running.png'),full_page=True)
    page.evaluate("relayforge.navigate('block','fill')")
    page.wait_for_timeout(400)
    page.screenshot(path=str(out/'relayforge-fbd.png'),full_page=True)
    page.evaluate("relayforge.navigate('block','analog')")
    page.wait_for_timeout(200)
    page.screenshot(path=str(out/'relayforge-st.png'),full_page=True)
    page.evaluate("relayforge.command('hmi-runtime')")
    page.wait_for_timeout(300)
    page.screenshot(path=str(out/'relayforge-hmi.png'),full_page=True)
    page.locator('.hmi-button button',has_text='STOP CYCLE').click()
    page.wait_for_function('relayforge.snapshot.values.Motor === false')
    print('HMI stop:',page.evaluate('relayforge.snapshot.outputs'))
    page.locator('.hmi-button button',has_text='START CYCLE').click()
    page.wait_for_function('relayforge.snapshot.values.Motor === true', timeout=10000)
    page.evaluate("relayforge.command('pause')")
    page.wait_for_function("relayforge.mode==='PAUSED'")
    before=page.evaluate('relayforge.snapshot.scan')
    page.evaluate("relayforge.command('step')")
    page.wait_for_function(f'relayforge.snapshot.scan === {before+1}')
    page.evaluate("relayforge.navigate('traces')")
    page.wait_for_timeout(400)
    page.screenshot(path=str(out/'relayforge-traces.png'),full_page=True)
    page.evaluate("relayforge.navigate('tags')")
    page.wait_for_timeout(100)
    assert page.locator('[data-tag-field="name"]').count()==19
    print('errors:',errors)
    assert not errors, errors
    (out/'relayforge-browser-results.json').write_text(json.dumps({'renderer':page.evaluate('relayforge.renderer'),'finalScan':page.evaluate('relayforge.snapshot.scan'),'pageErrors':errors,'tests':['startup','compiled three languages','demo run motor startup','HMI STOP','HMI START','pause and single scan','trace view','tag table']},indent=2))
    browser.close()
