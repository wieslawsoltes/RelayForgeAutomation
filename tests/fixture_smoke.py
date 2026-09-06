"""Local DOM fixture for a runner that disallows navigation. Loads the actual standalone artifact with a classic worker bundle.
The normal browser_smoke.py remains the test for an HTTP(S)-served application.
"""
import json,os
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('OUTPUT_DIR',root/'test-results'));out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    options={'headless':True};
    if os.environ.get('CHROMIUM_PATH'):options['executable_path']=os.environ['CHROMIUM_PATH']
    browser=p.chromium.launch(**options)
    page=browser.new_page(viewport={'width':1536,'height':1000},device_scale_factor=1)
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.on('console',lambda m:print('console:',m.type,m.text) if m.type=='error' else None)
    page.set_content('<!doctype html><title>Local test fixture</title>')
    page.evaluate("""() => {
      const values=new Map();
      Object.defineProperty(window,'localStorage',{value:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)}});
    }""")
    # Load the actual generated standalone artifact. No source or runtime substitution.
    page.set_content(root.joinpath('RelayForge.html').read_text())
    page.wait_for_function('window.relayforge?.compilation?.ok')
    page.wait_for_timeout(500)
    print('initial:',page.evaluate('({mode:relayforge.mode,renderer:relayforge.renderer,compiled:relayforge.compilation.ok})'))
    page.screenshot(path=str(out/'relayforge-initial.png'),full_page=True)
    page.locator('#editorToolbar [data-command="start-demo"]').click()
    page.wait_for_function('relayforge.snapshot.values.Motor===true',timeout=10000)
    page.wait_for_timeout(200)
    print('running:',page.evaluate('({scan:relayforge.snapshot.scan,outputs:relayforge.snapshot.outputs,level:relayforge.snapshot.values.TankLevel})'))
    page.screenshot(path=str(out/'relayforge-running.png'),full_page=True)
    page.evaluate("relayforge.navigate('block','fill')")
    page.wait_for_timeout(200)
    page.screenshot(path=str(out/'relayforge-fbd.png'),full_page=True)
    page.evaluate("relayforge.navigate('block','analog')")
    page.wait_for_timeout(200)
    page.screenshot(path=str(out/'relayforge-st.png'),full_page=True)
    page.evaluate("relayforge.command('hmi-runtime')")
    page.wait_for_timeout(200)
    page.screenshot(path=str(out/'relayforge-hmi.png'),full_page=True)
    page.locator('.hmi-button button',has_text='STOP CYCLE').click()
    page.wait_for_function('relayforge.snapshot.values.Motor===false')
    page.locator('.hmi-button button',has_text='START CYCLE').click()
    page.wait_for_function('relayforge.snapshot.values.Motor===true',timeout=10000)
    page.evaluate("relayforge.command('pause')")
    page.wait_for_function("relayforge.mode==='PAUSED'")
    before=page.evaluate('relayforge.snapshot.scan')
    page.evaluate("relayforge.command('step')")
    page.wait_for_function(f'relayforge.snapshot.scan==={before+1}')
    page.evaluate("relayforge.navigate('traces')")
    page.wait_for_timeout(200)
    page.screenshot(path=str(out/'relayforge-traces.png'),full_page=True)
    page.evaluate("relayforge.navigate('tags')")
    assert page.locator('[data-tag-field="name"]').count()==19
    # Edit LAD using real commands, and exercise transactional undo/redo.
    page.evaluate("relayforge.navigate('block','main')")
    page.evaluate("relayforge.command('add-network')")
    assert page.evaluate("relayforge.project.blocks.find(b=>b.id==='main').networks.length")==7
    page.evaluate("relayforge.command('undo')")
    assert page.evaluate("relayforge.project.blocks.find(b=>b.id==='main').networks.length")==6
    page.evaluate("relayforge.command('redo')")
    assert page.evaluate("relayforge.project.blocks.find(b=>b.id==='main').networks.length")==7
    page.evaluate("relayforge.command('undo')")
    # ST diagnostics and recovery from an actual text edit.
    page.evaluate("relayforge.navigate('block','analog')")
    page.locator('.code-input').fill('Motor := 17;')
    assert page.evaluate('relayforge.compile(false)') is False
    page.evaluate("relayforge.command('undo')")
    assert page.evaluate('relayforge.compile(false)') is True
    # HMI layout edits must not reset or write the CPU.
    page.evaluate("relayforge.command('hmi-design')")
    widget=page.locator('.hmi-widget').first
    before_x=page.evaluate('relayforge.project.hmi[0].x')
    rect=widget.bounding_box()
    page.mouse.move(rect['x']+20,rect['y']+12);page.mouse.down()
    page.mouse.move(rect['x']+45,rect['y']+12,steps=5);page.mouse.up()
    assert page.evaluate('relayforge.project.hmi[0].x')!=before_x
    page.evaluate("relayforge.command('undo')")
    assert page.evaluate('relayforge.project.hmi[0].x')==before_x
    # Change a live I/O force through the same request path used by watch tables.
    page.evaluate("relayforge.compile(true)")
    page.evaluate("relayforge.writeTag('Motor',true,{kind:'force'})")
    page.evaluate('relayforge.step()')
    assert page.evaluate('relayforge.snapshot.outputs.Motor') is True
    page.evaluate("relayforge.writeTag('Motor',null,{kind:'release'})")
    page.evaluate('relayforge.step()')
    assert page.evaluate('relayforge.snapshot.outputs.Motor') is False
    page.evaluate("relayforge.command('save')")
    assert page.evaluate("JSON.parse(localStorage.getItem('relayforge.project.v1')).blocks.length")==3
    # Validate responsive layout without navigating this restricted browser.
    page.set_viewport_size({'width':430,'height':900})
    page.evaluate("relayforge.navigate('block','main')")
    page.wait_for_timeout(200)
    assert page.evaluate('document.body.scrollWidth')<=430
    page.screenshot(path=str(out/'relayforge-mobile.png'),full_page=True)
    print('errors:',errors)
    assert not errors,errors
    results={'environment':'Generated standalone artifact in a local document fixture; actual classic worker bundle; in-memory storage fixture; no navigation or GPU device','renderer':page.evaluate('relayforge.renderer'),'finalScan':page.evaluate('relayforge.snapshot.scan'),'pageErrors':errors,'tests':['application bootstrap','compile all three languages','worker simulation','delayed motor startup','FBD and ST views','HMI STOP and START writes','pause and single scan','trace view','tag table','LAD network edit','undo and redo','ST type diagnostic','ST source undo recovery','HMI drag edit','HMI layout undo','I/O force and release','local project serialization','responsive 430px layout']}
    out.joinpath('relayforge-browser-results.json').write_text(json.dumps(results,indent=2))
    browser.close()
