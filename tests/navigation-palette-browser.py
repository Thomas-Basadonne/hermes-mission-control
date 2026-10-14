"""Mounted MissionControlShell acceptance for the global navigation palette.

Real MissionControlShell + real ChatDrawer, real key handling, real focus: the
API is a loopback-only synthetic fixture (see navigation-palette-browser-server.mjs)
and the chat WebSocket is completed by a stub upgrade handler. Nothing here
touches user data, the user's Chrome profile, or the live telemetry backend.

Covers the acceptance contract of epic MC-F07: keyboard open/close, search,
keyboard navigation (up/down selection, Enter activation, single-match Enter),
navigation, focus entry/restoration, Escape, editor/composer non-interference,
plugin-present vs plugin-absent catalogs, and the mobile behavior (no sidebar
trigger, palette not reachable below the breakpoint).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import build_opener, ProxyHandler

import psutil

ROOT = Path(__file__).resolve().parents[1]
HTTP = build_opener(ProxyHandler({}))
CHROME = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
KEY_K = 75


def stop_owned(process, birth):
    if process.poll() is not None:
        return
    owner = psutil.Process(process.pid)
    if owner.create_time() != birth:
        raise RuntimeError('Refusing to stop a recycled process')
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        if psutil.Process(process.pid).create_time() != birth:
            raise RuntimeError('Process ownership changed during teardown')
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=8)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, default=Path.home() / '.hermes/cache/scratch/navigation-palette-browser')
    parser.add_argument('--driver-path', type=Path)
    parser.add_argument('--source-root', type=Path, default=ROOT)
    parser.add_argument('--keep-open', action='store_true', help='leave the fixture and browser running for manual poking')
    args = parser.parse_args()
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    driver_path = args.driver_path or (Path(os.environ.get('HERMES_HOME', Path.home() / '.hermes'))
                                       / 'skills/software-development/browser-cdp-acceptance/scripts/cdp_driver.py')
    if not driver_path.is_file():
        raise RuntimeError('CDP driver unavailable: pass --driver-path to the installed browser-cdp-acceptance driver')
    spec = importlib.util.spec_from_file_location('palette_acceptance_driver', driver_path)
    driver_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver_module)
    if not CHROME.is_file():
        raise RuntimeError('Browser gate blocked: Chrome is unavailable')
    scratch = Path(os.environ['TMPDIR']).resolve()
    report = {'fixture_api': True, 'source': str(args.source_root), 'checks': [], 'screenshots': []}
    disposable = tempfile.mkdtemp(prefix='hermes-verify-palette-browser-', dir=scratch)
    runtime = Path(disposable)
    launched = []
    ports = []
    try:
        with (evidence / 'fixture-server.log').open('w') as log:
            server = subprocess.Popen(['node', 'tests/navigation-palette-browser-server.mjs', str(runtime), str(ROOT)],
                                      cwd=ROOT, env=os.environ, stdout=log, stderr=log, start_new_session=True)
            launched.append((server, psutil.Process(server.pid).create_time()))
            deadline = time.monotonic() + 45
            while not (runtime / 'port').exists():
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Fixture server did not start; inspect fixture-server.log')
                time.sleep(0.05)
            port = int((runtime / 'port').read_text())
            ports.append(port)
            base = f'http://127.0.0.1:{port}'
            profile = runtime / 'chrome-profile'
            browser = subprocess.Popen([str(CHROME), '--headless=new', '--no-first-run', '--no-default-browser-check',
                '--disable-extensions', '--disable-background-networking', '--disable-sync',
                '--disable-component-update', '--disable-default-apps', '--no-service-autorun',
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
                '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
                '--user-data-dir=' + str(profile), 'about:blank'], stdout=log, stderr=log, start_new_session=True)
            launched.append((browser, psutil.Process(browser.pid).create_time()))
            deadline = time.monotonic() + 20
            while not (profile / 'DevToolsActivePort').exists():
                if browser.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Owned Chrome did not start')
                time.sleep(0.05)
            debug_port = int((profile / 'DevToolsActivePort').read_text().splitlines()[0])
            ports.append(debug_port)

            with driver_module.Driver(debug_port, timeout=45) as driver:
                def evaluate(expression):
                    return driver.evaluate(expression)

                def wait(expression, message, timeout=20):
                    limit = time.monotonic() + timeout
                    while time.monotonic() < limit:
                        try:
                            if evaluate(expression):
                                return
                        except RuntimeError:
                            pass
                        time.sleep(0.05)
                    report['browser_errors'] = evaluate('window.failures || []')
                    report['console_errors'] = evaluate('window.consoleErrors || []')
                    report['requests'] = evaluate('window.requests || []')
                    report['rendered_text'] = evaluate("document.body?.innerText?.slice(0, 3000)")
                    report['palette_state'] = evaluate('''(() => {
                        const items = [...document.querySelectorAll('.navigation-palette-item')];
                        return { open: !!document.querySelector('.navigation-palette'),
                                 total: items.length,
                                 selected: items.findIndex(el => el.classList.contains('is-selected')),
                                 active: document.activeElement ? document.activeElement.className : null };
                    })()''')
                    driver.screenshot(str(evidence / 'failure.png'))
                    raise AssertionError(message)

                def dismiss_toasts(tone):
                    evaluate(f"document.querySelectorAll('[data-toast-item][data-toast-tone={tone}] button[aria-label^=Dismiss]').forEach(button => button.click())")
                    wait(f"document.querySelectorAll('[data-toast-item][data-toast-tone={tone}]').length === 0", f'{tone} toasts did not dismiss')

                def press_shortcut(modifiers=4):
                    driver.call('Input.dispatchKeyEvent', type='keyDown', key='k', code='KeyK',
                                modifiers=modifiers, windowsVirtualKeyCode=KEY_K, nativeVirtualKeyCode=KEY_K)
                    driver.call('Input.dispatchKeyEvent', type='keyUp', key='k', code='KeyK',
                                modifiers=modifiers, windowsVirtualKeyCode=KEY_K, nativeVirtualKeyCode=KEY_K)

                def press_escape():
                    driver.call('Input.dispatchKeyEvent', type='keyDown', key='Escape', code='Escape', windowsVirtualKeyCode=27)
                    driver.call('Input.dispatchKeyEvent', type='keyUp', key='Escape', code='Escape', windowsVirtualKeyCode=27)

                def click_selector(selector):
                    point = evaluate(f'''(() => {{ const el = document.querySelector({json.dumps(selector)});
                        if (!el || el.disabled) throw new Error('Missing or disabled control: ' + {json.dumps(selector)});
                        el.scrollIntoView({{block:'center'}}); const r = el.getBoundingClientRect();
                        return {{x: r.x + r.width / 2, y: r.y + r.height / 2}}; }})()''')
                    driver.call('Input.dispatchMouseEvent', type='mousePressed', button='left', buttons=1, clickCount=1, **point)
                    driver.call('Input.dispatchMouseEvent', type='mouseReleased', button='left', buttons=0, clickCount=1, **point)

                def click_item(label):
                    point = evaluate(f'''(() => {{ const el = [...document.querySelectorAll('.navigation-palette-item')]
                          .find(b => b.textContent.includes({json.dumps(label)}));
                        if (!el) throw new Error('Palette item not found: ' + {json.dumps(label)});
                        const r = el.getBoundingClientRect(); return {{x: r.x + r.width / 2, y: r.y + r.height / 2}}; }})()''')
                    driver.call('Input.dispatchMouseEvent', type='mousePressed', button='left', buttons=1, clickCount=1, **point)
                    driver.call('Input.dispatchMouseEvent', type='mouseReleased', button='left', buttons=0, clickCount=1, **point)

                def type_search(text):
                    evaluate(f'''(() => {{
                        const input = document.querySelector('.navigation-palette-search input');
                        if (!input) throw new Error('Palette search input missing');
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                        setter.call(input, {json.dumps(text)});
                        input.dispatchEvent(new Event('input', {{bubbles: true}}));
                        return true; }})()''')

                def focus_selector(selector):
                    evaluate(f'''(() => {{ const el = document.querySelector({json.dumps(selector)});
                        if (!el) throw new Error('Cannot focus missing element: ' + {json.dumps(selector)});
                        el.focus(); return document.activeElement === el; }})()''')

                def labels():
                    # The icon slot may itself be a fallback <span aria-hidden>; the
                    # label is the only span the host does not mark as decoration.
                    return evaluate('''[...document.querySelectorAll('.navigation-palette-item')].map(el =>
                        [...el.querySelectorAll('span')].filter(s => !s.hasAttribute('aria-hidden')).map(s => s.textContent).join(''))''')

                def is_open():
                    return evaluate("!!document.querySelector('.navigation-palette')")

                def active_selector():
                    return evaluate('''(() => { const el = document.activeElement;
                        if (!el) return null; return el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''); })()''')

                def check(name):
                    report['checks'].append(name)

                def screenshot(name):
                    target = evidence / (name + '.png')
                    driver.screenshot(str(target))
                    report['screenshots'].append(str(target))

                def remount(plugin_items):
                    evaluate('window.unmountShell()')
                    wait("!document.querySelector('.workspace-bar')", 'Shell did not unmount')
                    evaluate(f'window.mountShell({{pluginItems: {json.dumps(plugin_items)}}})')
                    wait("!!document.querySelector('.workspace-bar')", 'Shell failed to mount')
                    wait("!!document.querySelector('.side-menu-actions > .palette-open-button:first-child')", 'the palette opener must be the first row of the sidebar actions')

                # A real Lucide icon name (resolveIcon returns undefined for unknown
                # names, which renders a fallback icon span and would make label
                # extraction ambiguous).
                plugin_items = [{'to': '/reports', 'label': 'Plugin reports', 'icon': 'FileText', 'order': 25}]

                driver.call('Emulation.setDeviceMetricsOverride', width=1280, height=1000, deviceScaleFactor=1, mobile=False)
                driver.call('Page.navigate', url=base)
                wait("!!document.querySelector('.workspace-bar')", 'Shell failed to mount')
                wait("!!document.querySelector('.side-menu-actions > .palette-open-button:first-child')", 'the palette opener must be the first row of the sidebar actions')

                # Phase 2 intent groups and uniform rows, exercised on the mounted shell.
                wait("!!document.querySelector('.push-toggle')", 'Push row must render on the supported fixture browser')
                assert evaluate("!!document.querySelector('.side-menu-head-top .sidebar-version') && !document.querySelector('.side-menu-actions .sidebar-version')"), 'version must move to the sidebar head beside collapse'
                assert evaluate("document.querySelector('.side-menu-preferences')?.querySelectorAll('.push-toggle, .theme-toggle, .lang-toggle').length === 3 && !!document.querySelector('.side-menu-action-group > .lock-button')"), 'preferences and Lock must have separate intent groups'

                def assert_action_surfaces(mode):
                    surfaces = evaluate('''(() => {
                        const find = selector => document.querySelector(selector);
                        const style = selector => getComputedStyle(find(selector));
                        const rect = selector => find(selector).getBoundingClientRect();
                        const token = (name, property) => {
                            const probe = document.createElement('span');
                            probe.style[property] = 'var(' + name + ')';
                            find('.side-menu-actions').appendChild(probe);
                            const value = getComputedStyle(probe)[property];
                            probe.remove(); return value;
                        };
                        const search = style('.palette-open-button');
                        const card = style('.side-menu-preferences');
                        const lock = style('.lock-button');
                        const rows = [...find('.side-menu-preferences').children];
                        const segments = [...find('.side-menu-preferences').querySelectorAll('.theme-toggle-option, .lang-toggle-option')];
                        return {
                            searchPill: parseFloat(search.borderRadius) >= 22 && parseFloat(search.borderTopWidth) === 0 && search.backgroundColor !== style('.side-menu').backgroundColor && search.backgroundColor !== 'rgba(0, 0, 0, 0)',
                            cardSurface: parseFloat(card.borderRadius) >= 12 && card.backgroundColor !== style('.side-menu').backgroundColor && card.backgroundColor !== 'rgba(0, 0, 0, 0)',
                            noDividers: [card, style('.side-menu-action-group'), ...rows.map(el => getComputedStyle(el))].every(s => parseFloat(s.borderTopWidth) === 0),
                            contiguous: rows.every((el, i) => i === 0 || Math.abs(el.getBoundingClientRect().top - rows[i-1].getBoundingClientRect().bottom) < 1),
                            spacing: rect('.side-menu-preferences').top - rect('.palette-open-button').bottom >= 12 && rect('.lock-button').top - rect('.side-menu-preferences').bottom >= 8,
                            lockAccent: lock.color === token('--color-accent', 'color') && lock.color !== token('--color-negative', 'color') && lock.backgroundColor === token('--color-accent-subtle', 'backgroundColor') && parseFloat(lock.borderRadius) >= 22,
                            segments: segments.length === 4 && segments.every(el => el.getBoundingClientRect().width === 44 && el.getBoundingClientRect().height === 44 && getComputedStyle(el).backgroundClip === 'padding-box' && parseFloat(getComputedStyle(el).borderLeftWidth) === 5 && getComputedStyle(el).backgroundColor === token(el.classList.contains('is-active') ? '--color-accent-subtle' : '--color-surface-sunken', 'backgroundColor')),
                            pushAligned: rect('.push-toggle-label').right <= rect('.push-toggle-state').left && Math.abs(rect('.push-toggle-label').top + rect('.push-toggle-label').height / 2 - rect('.push-toggle-state').top - rect('.push-toggle-state').height / 2) < 3,
                        };
                    })()''')
                    report.setdefault('action_surfaces', {})[mode] = surfaces
                    report.setdefault('segment_styles', {})[mode] = evaluate("[...document.querySelectorAll('.side-menu-actions .theme-toggle-option, .side-menu-actions .lang-toggle-option')].map(el => ({clip: getComputedStyle(el).backgroundClip, border: getComputedStyle(el).borderLeftWidth, background: getComputedStyle(el).backgroundColor}))")
                    assert all(surfaces.values()), (mode, surfaces, report['segment_styles'][mode])
                    before_hover = evaluate("getComputedStyle(document.querySelector('.lock-button')).backgroundColor")
                    point = evaluate("(() => { const r = document.querySelector('.lock-button').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()")
                    driver.call('Input.dispatchMouseEvent', type='mouseMoved', **point)
                    wait(f"getComputedStyle(document.querySelector('.lock-button')).backgroundColor !== {json.dumps(before_hover)}", 'Lock hover must strengthen its own accent surface')
                    assert evaluate("document.querySelector('.lock-button').querySelectorAll('svg').length === 1 && !document.querySelector('.lock-button kbd, .lock-button input, .lock-button [role=switch]')"), 'Lock remains a single action without a trailing control'
                    driver.call('Input.dispatchMouseEvent', type='mouseMoved', x=500, y=100)
                    wait(f"getComputedStyle(document.querySelector('.lock-button')).backgroundColor === {json.dumps(before_hover)}", 'Lock hover surface must reset')
                    check(f'{mode}: computed search pill, contiguous preference card, isolated accent Lock, aligned Push and 44px segments')

                evaluate("document.documentElement.dataset.theme = 'dark'")
                time.sleep(0.3)  # Let token-dependent control transitions settle before sampling.
                assert_action_surfaces('dark')
                screenshot('sidebar-actions-dark')
                evaluate("document.documentElement.classList.remove('dark'); document.documentElement.dataset.theme = 'light'; window.__mcFixtureStore.resolvedTheme = 'light'")
                remount([])
                wait("!!document.querySelector('.push-toggle')", 'light Push row must render')
                time.sleep(0.3)
                assert_action_surfaces('light')
                screenshot('sidebar-actions-light')

                # Phase 1 placement and responsive shell geometry, using mounted controls.
                assert evaluate("document.querySelectorAll('.palette-open-button').length === 1 && !document.querySelector('.workspace-bar .palette-open-button')"), 'the sidebar must own the only opener'
                for width in (1024, 1440):
                    driver.call('Emulation.setDeviceMetricsOverride', width=width, height=1000, deviceScaleFactor=1, mobile=False)
                    wait("!document.querySelector('.layout-frame').classList.contains('is-collapsed')", 'sidebar must be expanded for the row check')
                    geometry = evaluate('''(() => {
                        const button = document.querySelector('.palette-open-button');
                        const row = button.getBoundingClientRect();
                        const actions = button.parentElement.getBoundingClientRect();
                        const title = document.querySelector('.workspace-title-wrap').getBoundingClientRect();
                        const chat = document.querySelector('.chat-open-button').getBoundingClientRect();
                        const rows = [...document.querySelectorAll('.side-menu-actions .side-action-button, .side-menu-actions .theme-toggle, .side-menu-actions .lang-toggle')];
                        const preferences = ['theme', 'lang'].every(prefix => {
                            const label = document.querySelector('.' + prefix + '-toggle-label').getBoundingClientRect();
                            const track = document.querySelector('.' + prefix + '-toggle-track').getBoundingClientRect();
                            return label.right <= track.left && Math.abs(label.y + label.height / 2 - track.y - track.height / 2) < 3;
                        });
                        const version = document.querySelector('.sidebar-version').getBoundingClientRect();
                        const collapse = document.querySelector('.desktop-sidebar-toggle').getBoundingClientRect();
                        return {fullWidth: Math.abs(row.width - actions.width) <= 2,
                            uniform: rows.length === 5 && rows.every(el => Math.abs(el.getBoundingClientRect().width - actions.width) <= 2 && el.getBoundingClientRect().height >= 44),
                            preferences,
                            headAligned: version.right <= collapse.left && Math.abs(version.y + version.height / 2 - collapse.y - collapse.height / 2) < 3,
                            chipVisible: button.querySelector('kbd').getBoundingClientRect().width > 0,
                            named: button.getAttribute('aria-label') === button.title && !!button.title,
                            aligned: title.right <= chat.left && Math.abs(title.y + title.height / 2 - chat.y - chat.height / 2) < 3};
                    })()''')
                    assert all(geometry.values()), (width, geometry)
                    screenshot(f'sidebar-palette-expanded-{width}')
                    check(f'{width}px: first sidebar action is full-width, named, with shortcut chip; header title and Chat align')
                    check(f'{width}px: all five actions have uniform full-width 44px rows; preference labels sit left of segments; version aligns beside collapse')
                click_selector('.lang-toggle-option:last-child')
                wait("document.querySelector('.push-toggle-label').textContent === 'Push' && document.querySelector('.push-toggle').getAttribute('aria-pressed') === 'false'", 'Italian idle Push must have a stable label and accessible off state')
                assert evaluate("document.querySelector('.push-toggle').title === 'Attiva le notifiche push per le risposte di Hermes'"), 'Push tooltip must be localized too'
                click_selector('.lang-toggle-option:first-child')
                wait("document.querySelector('.push-toggle-label').textContent === 'Push' && document.querySelector('.push-toggle').getAttribute('aria-pressed') === 'false'", 'English idle Push must keep its label and accessible off state')
                check('Language segments change locale; Push label and tooltip use existing translations')
                # Simulate only the browser subscription boundary: mount the real
                # PushToggle/getPushState without requesting permission or sending push.
                evaluate('''(() => {
                    window.__originalSWRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
                    navigator.serviceWorker.register = async () => ({pushManager: {getSubscription: async () => ({})}});
                })()''')
                remount([])
                wait("document.querySelector('.push-toggle-label')?.textContent === 'Push' && document.querySelector('.push-toggle').getAttribute('aria-pressed') === 'true'", 'English subscribed Push must retain its label and accessible on state')
                assert evaluate("document.querySelector('.push-toggle').title === 'Push notifications are on' && document.querySelector('.push-toggle').getAttribute('aria-label') === document.querySelector('.push-toggle').title"), 'English on state remains accessible'
                on_switch = evaluate("({background: getComputedStyle(document.querySelector('.push-toggle-state')).backgroundColor, thumb: getComputedStyle(document.querySelector('.push-toggle-state'), '::after').transform})")
                click_selector('.lang-toggle-option:last-child')
                wait("document.querySelector('.push-toggle-label').textContent === 'Push' && document.querySelector('.push-toggle').getAttribute('aria-pressed') === 'true'", 'Italian subscribed Push must retain its label and accessible on state')
                assert evaluate("document.querySelector('.push-toggle').title === 'Le notifiche push sono attive' && document.querySelector('.push-toggle').getAttribute('aria-pressed') === 'true'"), 'subscribed Push must retain pressed state and localized tooltip'
                click_selector('.lang-toggle-option:first-child')
                wait("document.querySelector('.push-toggle-label').textContent === 'Push' && document.querySelector('.push-toggle').getAttribute('aria-pressed') === 'true'", 'English subscribed Push state must be restored')
                evaluate('navigator.serviceWorker.register = window.__originalSWRegister; delete window.__originalSWRegister')
                remount([])
                wait("document.querySelector('.push-toggle-label')?.textContent === 'Push' && document.querySelector('.push-toggle').getAttribute('aria-pressed') === 'false'", 'real idle Push fixture must be restored')
                off_switch = evaluate("({background: getComputedStyle(document.querySelector('.push-toggle-state')).backgroundColor, thumb: getComputedStyle(document.querySelector('.push-toggle-state'), '::after').transform})")
                assert on_switch['background'] != off_switch['background'] and on_switch['thumb'] != off_switch['thumb'], 'Only the switch must visually reflect the changed Push state'
                check('Push label stays stable in EN/IT and on/off states; accessible state and localized tooltips follow the real component')
                click_selector('.desktop-sidebar-toggle')
                wait("document.querySelector('.layout-frame').classList.contains('is-collapsed')", 'sidebar did not collapse')
                assert evaluate('''(() => {
                    const b = document.querySelector('.palette-open-button');
                    const r = b.getBoundingClientRect();
                    return r.width === 44 && r.height === 44 && !!b.getAttribute('aria-label')
                        && b.querySelector('svg').getBoundingClientRect().width > 0
                        && [...b.querySelectorAll('.palette-open-label, kbd')].every(el => el.getBoundingClientRect().width === 0);
                })()'''), 'collapsed opener must be a named 44x44 icon-only control'
                assert evaluate('''(() => {
                    const controls = [...document.querySelectorAll('.side-menu-actions button')];
                    return controls.length === 7 && controls.every(el => {
                        const r = el.getBoundingClientRect();
                        return r.width === 44 && r.height === 44 && !!el.getAttribute('aria-label');
                    }) && document.querySelector('.sidebar-version').getBoundingClientRect().width === 0
                        && [...document.querySelectorAll('.theme-toggle-label, .lang-toggle-label, .push-toggle-label, .push-toggle-state, .lock-label')].every(el => el.getBoundingClientRect().width === 0);
                })()'''), 'collapsed actions must preserve separate named 44x44 controls with labels, state and version hidden'
                click_selector('.palette-open-button')
                wait("!!document.querySelector('.navigation-palette')", 'collapsed opener did not open palette')
                press_escape()
                wait("document.activeElement === document.querySelector('.palette-open-button')", 'collapsed opener focus was not restored')
                screenshot('sidebar-palette-collapsed')
                check('collapsed sidebar: named 44x44 icon-only opener opens palette and receives restored focus')
                click_selector('.desktop-sidebar-toggle')
                # Accepted drawer band (641-980px): the sidebar is off-canvas here, so
                # the trigger moved out of the header is NOT visible with the drawer
                # closed — reachable via Cmd+K or after opening the drawer. The
                # assertions below pin that consequence explicitly instead of assuming
                # the previous header placement's behavior.
                driver.call('Emulation.setDeviceMetricsOverride', width=800, height=1000, deviceScaleFactor=1, mobile=False)
                wait("document.querySelector('.palette-open-button').getBoundingClientRect().right <= 0", '800px closed drawer must hide the palette trigger off-canvas')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", '800px Cmd+K must open the palette immediately with drawer closed')
                press_escape()
                wait("!document.querySelector('.navigation-palette')", '800px Escape must close palette')
                click_selector('.mobile-sidebar-toggle')
                wait("document.querySelector('.palette-open-button').getBoundingClientRect().left >= 0", '800px open drawer must reveal the palette trigger')
                click_selector('.palette-open-button')
                wait("!!document.querySelector('.navigation-palette')", '800px drawer trigger must open palette on click')
                press_escape()
                wait("!document.querySelector('.navigation-palette')", '800px palette must close')
                assert evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.side-menu').scrollWidth <= document.querySelector('.side-menu').clientWidth"), '800px open drawer must not overflow horizontally'
                screenshot('sidebar-actions-drawer-800')
                check('800px: closed drawer hides trigger; Cmd+K opens immediately; header toggle reveals clickable trigger; open drawer has no horizontal overflow')
                click_selector('.mobile-nav-backdrop')
                wait("!document.querySelector('.layout-frame').classList.contains('is-open')", '800px backdrop must close the drawer before desktop checks')
                driver.call('Emulation.setDeviceMetricsOverride', width=1280, height=1000, deviceScaleFactor=1, mobile=False)

                # Cmd+K must not put the palette above the independent Overview restart dialog.
                wait("!!document.querySelector('.widget-quick-actions button')", 'Quick Actions widget did not render on Overview')
                evaluate("""(() => {
                    const button = [...document.querySelectorAll('.widget-quick-actions button')]
                      .find((item) => item.textContent.trim() === 'Restart gateway');
                    if (!button) throw new Error('Quick Actions restart trigger missing');
                    button.click(); return true;
                })()""")
                wait("!!document.querySelector('[role=alertdialog]')", 'Quick Actions restart confirmation did not open')
                press_shortcut(4)
                time.sleep(0.1)
                assert not is_open(), 'Cmd+K must not open the palette over another modal dialog'
                assert evaluate("document.querySelector('[role=alertdialog]')?.contains(document.activeElement)"), 'the Quick Actions dialog must retain keyboard focus'
                assert evaluate('window.__mcActionCalls.length') == 0, 'opening a shortcut during confirmation must not invoke restart'
                click_selector('[role=alertdialog] button:first-of-type')
                wait("!document.querySelector('[role=alertdialog]')", 'Quick Actions dialog did not cancel')
                check('Cmd+K is suppressed while the independent Quick Actions restart dialog is open')

                # Quick Actions uses the same transient toast surface as the palette.
                evaluate("""(() => {
                    const button = [...document.querySelectorAll('.widget-quick-actions button')]
                      .find((item) => item.textContent.trim() === 'Refresh');
                    if (!button) throw new Error('Quick Actions refresh trigger missing');
                    button.click(); return true;
                })()""")
                wait("window.__mcActionCalls.length === 1", 'Quick Actions refresh did not invoke the existing action handler')
                wait("[...document.querySelectorAll('[data-toast-item][data-toast-tone=info]')].some(item => item.textContent.includes('Refresh handler finished'))", 'Quick Actions refresh success toast missing')
                assert evaluate("document.querySelectorAll('.widget-quick-actions [role=status], .widget-quick-actions [role=alert]').length") == 0, 'Quick Actions must not retain inline status feedback'
                check('Quick Actions refresh reports success in the shared toast')

                evaluate('window.__mcActionFailure = true')
                evaluate("""(() => {
                    const button = [...document.querySelectorAll('.widget-quick-actions button')]
                      .find((item) => item.textContent.trim() === 'Refresh');
                    button.click(); return true;
                })()""")
                wait("window.__mcActionCalls.length === 2", 'failed Quick Actions refresh did not invoke its handler exactly once')
                wait("[...document.querySelectorAll('[data-toast-item][data-toast-tone=error]')].some(item => item.textContent.includes('Refresh action failed. No automatic retry was attempted.'))", 'Quick Actions refresh failure toast missing')
                assert evaluate('window.__mcActionCalls.length') == 2, 'Quick Actions refresh must not retry automatically'
                evaluate('window.__mcActionFailure = false; window.__mcActionCalls = []')
                check('Quick Actions refresh reports failures in the shared toast without retrying')

                evaluate("""(() => {
                    const button = [...document.querySelectorAll('.widget-quick-actions button')]
                      .find((item) => item.textContent.trim() === 'Restart gateway');
                    if (!button) throw new Error('Quick Actions restart trigger missing');
                    button.click(); return true;
                })()""")
                wait("!!document.querySelector('[role=alertdialog]')", 'Quick Actions restart confirmation did not reopen')
                click_selector('[role=alertdialog] button:last-of-type')
                wait("window.__mcActionCalls.length === 1", 'Quick Actions restart did not invoke its existing action handler')
                wait("[...document.querySelectorAll('[data-toast-item][data-toast-tone=success]')].some(item => item.textContent.includes('Gateway restart request accepted; completion has not been verified.'))", 'Quick Actions restart acceptance toast missing')
                assert evaluate("document.querySelectorAll('.widget-quick-actions [role=status], .widget-quick-actions [role=alert]').length") == 0, 'Quick Actions must not retain inline restart feedback'
                evaluate('window.__mcActionCalls = []')
                check('Quick Actions restart uses the shared toast and preserves accepted-not-completed wording')

                # --- 1. keyboard open, focus entry, close, focus restoration ---
                assert not is_open()
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not open the palette')
                assert evaluate("document.querySelector('.navigation-palette').getAttribute('role')") == 'dialog'
                assert evaluate("document.querySelector('.navigation-palette').getAttribute('aria-modal')") == 'true'
                assert evaluate("document.activeElement === document.querySelector('.navigation-palette-search input')"), 'opening must move focus into the search input'
                assert active_selector().startswith('input'), active_selector()
                expected_group_names = evaluate("[...document.querySelectorAll('[data-palette-group]')].map(group => group.getAttribute('aria-label'))")
                ax_nodes = driver.call('Accessibility.getFullAXTree').get('nodes', [])
                ax_groups = {
                    node.get('name', {}).get('value'): node
                    for node in ax_nodes
                    if node.get('role', {}).get('value') == 'group'
                }
                for group_name in expected_group_names:
                    ax_group = ax_groups.get(group_name)
                    assert ax_group, f'palette group {group_name!r} must be exposed in the accessibility tree'
                    child_roles = [
                        node.get('role', {}).get('value')
                        for node in ax_nodes
                        if node.get('parentId') == ax_group.get('nodeId') and not node.get('ignored')
                    ]
                    assert child_roles and all(role == 'option' for role in child_roles), (
                        f'listbox group {group_name!r} may expose only option children; got {child_roles}'
                    )
                check('palette listbox exposes named groups containing only options in the accessibility tree')
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'Escape did not close the palette')
                check('keyboard open (Cmd+K) moves focus into the search input; Escape closes')

                # Ctrl+K is accepted too (non-Mac clients).
                press_shortcut(2)
                wait("!!document.querySelector('.navigation-palette')", 'Ctrl+K did not open the palette')
                press_shortcut(2)
                wait("!document.querySelector('.navigation-palette')", 'Ctrl+K did not close the palette')
                check('Ctrl+K toggles the palette as well')

                # Focus restoration through the visible opener control.
                click_selector('.palette-open-button')
                wait("!!document.querySelector('.navigation-palette')", 'Opener button did not open the palette')
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'Escape did not close the palette')
                wait("document.activeElement === document.querySelector('.palette-open-button')", 'closing must restore focus to the opener control')
                check('focus restoration: closing returns focus to the control that opened the palette')

                # --- 2. search + core catalog + navigation ---
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not reopen the palette')
                full = labels()
                assert evaluate("!!document.querySelector('[data-palette-group=actions]')"), 'the palette must expose a distinct actions group'
                assert 'Refresh current view' in full, f'current-view refresh action missing: {full}'
                assert 'Restart gateway' in full, f'gateway restart action missing: {full}'
                for expected in ('Overview', 'Sessions', 'Kanban', 'Cron', 'Config', 'Chat'):
                    assert expected in full, f'{expected} missing from the palette catalog: {full}'

                # Locale labels are part of the real shell, not a mock translation.
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'palette did not close before changing locale')
                click_selector('.lang-toggle-option:not(.is-active)')
                wait("document.querySelector('.lang-toggle-option.is-active')?.textContent.includes('Italiano')", 'Italian locale did not activate')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not reopen in Italian')
                assert evaluate("document.querySelector('.navigation-palette')?.getAttribute('aria-label')") == 'Tavolozza dei comandi'
                assert 'Aggiorna vista corrente' in labels() and 'Riavvia gateway' in labels(), labels()
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'Italian palette did not close')
                click_selector('.lang-toggle-option:not(.is-active)')
                wait("document.querySelector('.lang-toggle-option.is-active')?.textContent.includes('English')", 'English locale restore failed')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not reopen in English')

                # Current-view refresh uses the registered page handler only.
                dismiss_toasts('info')
                type_search('refresh current view')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", 'refresh action search failed')
                assert evaluate("document.querySelector('.navigation-palette-item')?.dataset.paletteAction") == 'refresh-current-view'
                driver.call('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                driver.call('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                wait("window.__mcRefreshCalls.length === 1", 'refresh action did not call the current page handler')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not reopen during refresh')
                type_search('refresh current view')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", 'refresh action disappeared while running')
                assert evaluate("document.querySelector('.navigation-palette-item')?.getAttribute('aria-disabled') === 'true'"), 'refresh option must expose its busy state as aria-disabled'
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'palette did not close during refresh')
                wait("!!document.querySelector('[data-toast-viewport] [data-toast-item][data-toast-tone=info]')?.textContent.includes('Refresh handler finished')", 'refresh completion toast missing')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not reopen over the refresh toast')
                assert evaluate("Number(getComputedStyle(document.querySelector('[data-toast-viewport]')).zIndex) > Number(getComputedStyle(document.querySelector('.navigation-palette-backdrop')).zIndex)"), 'toast must remain above the palette backdrop'
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'palette did not close after toast layering check')
                check('refresh action is searchable, keyboard-activatable, and runs the current page handler once')

                evaluate('window.__mcRegisterExtraRefresh()')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not open for ambiguous refresh registrations')
                assert not evaluate("[...document.querySelectorAll('.navigation-palette-item')].some(el => el.dataset.paletteAction === 'refresh-current-view')"), 'refresh must fail closed when multiple current-view handlers are registered'
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'palette did not close after ambiguous handler check')
                evaluate('window.__mcUnregisterExtraRefresh()')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not reopen after resolving refresh handler ambiguity')
                assert evaluate("[...document.querySelectorAll('.navigation-palette-item')].some(el => el.dataset.paletteAction === 'refresh-current-view')"), 'refresh should return when exactly one handler remains'
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'palette did not close after single-handler restoration')
                check('current-view refresh fails closed for multiple registrations and returns when one handler remains')

                dismiss_toasts('error')
                evaluate('window.__mcRefreshFailure = true')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not reopen for refresh error test')
                type_search('refresh current view')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1 && !document.querySelector('.navigation-palette-item').disabled", 'refresh action did not become available for error test')
                driver.call('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                driver.call('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                wait("[...document.querySelectorAll('[data-toast-viewport] [data-toast-item][data-toast-tone=error]')].some(item => item.textContent.trim().startsWith('Action failed.'))", 'refresh failure toast missing')
                refresh_call_count = evaluate('window.__mcRefreshCalls.length')
                assert refresh_call_count == 2, f'refresh should run once per explicit invocation; got {refresh_call_count}'
                evaluate('window.__mcRefreshFailure = false')
                check('refresh failure is surfaced and does not trigger a retry')

                # A registered handler can throw before it returns a Promise; this must not wedge the refresh lock.
                dismiss_toasts('error')
                evaluate('window.__mcSyncRefreshFailure = true')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not reopen for synchronous refresh failure')
                type_search('refresh current view')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1 && !document.querySelector('.navigation-palette-item').disabled", 'refresh action did not become available for synchronous failure')
                driver.call('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                driver.call('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                wait("[...document.querySelectorAll('[data-toast-viewport] [data-toast-item][data-toast-tone=error]')].some(item => item.textContent.trim().startsWith('Action failed.'))", 'synchronous refresh failure toast missing')
                assert evaluate('window.__mcRefreshCalls.length') == 3, 'synchronous refresh should be attempted exactly once'
                evaluate('window.__mcSyncRefreshFailure = false')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'refresh failure should leave the palette usable')
                type_search('refresh current view')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1 && !document.querySelector('.navigation-palette-item').disabled", 'refresh lock stayed stuck after synchronous failure')
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'palette did not close after synchronous refresh error')
                check('synchronous refresh errors are surfaced and release the in-flight lock')

                # Restart cancellation must not invoke the existing gateway handler.
                click_selector('.palette-open-button')
                wait("!!document.querySelector('.navigation-palette')", 'palette trigger did not reopen palette for restart')
                type_search('restart gateway')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", 'restart action search failed')
                driver.call('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                driver.call('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                wait("!!document.querySelector('[role=alertdialog]')", 'restart action did not request confirmation')
                time.sleep(0.15)  # include the shell's deferred palette focus restoration
                focus_checks = evaluate("""(() => {
                    const dialog = document.querySelector('[role=alertdialog]');
                    const [cancel, confirm] = dialog.querySelectorAll('button');
                    const initial = document.activeElement === cancel;
                    confirm.focus();
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                    const tabWrap = document.activeElement === cancel;
                    cancel.focus();
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
                    const shiftTabWrap = document.activeElement === confirm;
                    document.querySelector('.palette-open-button').focus();
                    const outsideFocusTrapped = dialog.contains(document.activeElement);
                    return { initial, tabWrap, shiftTabWrap, outsideFocusTrapped };
                })()""")
                assert focus_checks == {'initial': True, 'tabWrap': True, 'shiftTabWrap': True, 'outsideFocusTrapped': True}, focus_checks
                click_selector('[role=alertdialog] button:first-of-type')
                wait("!document.querySelector('[role=alertdialog]')", 'restart cancellation did not close confirmation')
                wait("document.activeElement === document.querySelector('.palette-open-button')", 'cancel must restore focus to the palette opener')
                assert evaluate('window.__mcActionCalls.length') == 0, 'cancel must not call the gateway handler'
                check('restart dialog traps focus, wraps Tab, restores focus on cancel, and performs no action')

                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not reopen palette for Escape cancellation')
                type_search('restart gateway')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", 'restart action search failed for Escape cancellation')
                driver.call('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                driver.call('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                wait("!!document.querySelector('[role=alertdialog]')", 'restart confirmation did not open for Escape cancellation')
                press_escape()
                wait("!document.querySelector('[role=alertdialog]')", 'Escape did not cancel restart confirmation')
                assert evaluate('window.__mcActionCalls.length') == 0, 'Escape cancellation must not call the gateway handler'
                check('Escape cancels restart confirmation without invoking the gateway handler')

                # Confirm twice during a pending request: the handler runs once.
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not reopen palette after cancel')
                type_search('restart gateway')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", 'restart action search failed after cancel')
                evaluate("[...document.querySelectorAll('[data-toast-viewport] [data-toast-item][data-toast-tone=success]')].filter(item => item.textContent.includes('Gateway restart request accepted; completion has not been verified.')).forEach(item => item.querySelector('button[aria-label^=Dismiss]')?.click())")
                wait("![...document.querySelectorAll('[data-toast-viewport] [data-toast-item][data-toast-tone=success]')].some(item => item.textContent.includes('Gateway restart request accepted; completion has not been verified.'))", 'stale Quick Actions restart toast did not dismiss')
                evaluate("""(() => {
                    window.__mcRestartObservedToasts = [];
                    window.__mcToastObserver = new MutationObserver((records) => {
                        for (const record of records) for (const node of record.addedNodes) {
                            if (!(node instanceof HTMLElement)) continue;
                            const toast = node.matches('[data-toast-item]') ? node : node.querySelector('[data-toast-item]');
                            if (!toast) continue;
                            window.__mcRestartObservedToasts.push({
                                tone: toast.dataset.toastTone,
                                message: toast.querySelector('[data-toast-message]')?.textContent || '',
                            });
                        }
                    });
                    window.__mcToastObserver.observe(document.querySelector('[data-toast-viewport]'), { childList: true, subtree: true });
                })()""")
                driver.call('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                driver.call('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                wait("!!document.querySelector('[role=alertdialog]')", 'restart confirmation did not reopen')
                evaluate("(() => { const b=document.querySelector('[role=alertdialog] button:last-of-type'); b.click(); b.click(); return true; })()")
                time.sleep(0.04)
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not reopen during gateway restart')
                type_search('restart gateway')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", 'restart action disappeared while running')
                assert evaluate("document.querySelector('.navigation-palette-item')?.getAttribute('aria-disabled') === 'true'"), 'restart option must expose its busy state as aria-disabled'
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'palette did not close while restart was pending')
                wait("window.__mcActionCalls.length === 1 && window.__mcRestartObservedToasts.length === 1", 'restart action produced no single toast')
                restart_toast_tone = evaluate('window.__mcRestartObservedToasts[0].tone')
                accepted_restart_message = evaluate('window.__mcRestartObservedToasts[0].message')
                evaluate('window.__mcToastObserver.disconnect()')
                assert restart_toast_tone == 'success', f'restart outcome was {restart_toast_tone}: {accepted_restart_message}'
                assert 'completion has not been verified' in accepted_restart_message.lower(), accepted_restart_message
                check('restart confirmation invokes the existing handler once and reports accepted, not completed')

                # Failure is visible and never retried automatically.
                dismiss_toasts('error')
                evaluate('window.__mcRestartFailure = true')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not reopen palette for restart error test')
                type_search('restart gateway')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", 'restart action search failed for error test')
                driver.call('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                driver.call('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                wait("!!document.querySelector('[role=alertdialog]')", 'restart confirmation missing on error test')
                click_selector('[role=alertdialog] button:last-of-type')
                wait("[...document.querySelectorAll('[data-toast-viewport] [data-toast-item][data-toast-tone=error]')].some(item => item.textContent.trim().startsWith('Action failed.'))", 'restart failure toast missing')
                assert evaluate('window.__mcActionCalls.length') == 2, 'uncertain/failed restart must not be retried automatically'
                evaluate('window.__mcRestartFailure = false')
                check('restart failure is surfaced without an automatic retry')

                for mode, expected_calls in [('disconnect', 3), ('timeout', 4)]:
                    dismiss_toasts('warning')
                    evaluate(f"window.__mcRestartFailureMode = '{mode}'")
                    press_shortcut(4)
                    wait("!!document.querySelector('.navigation-palette')", f'palette did not reopen for {mode} case')
                    type_search('restart gateway')
                    wait("document.querySelectorAll('.navigation-palette-item').length === 1 && !document.querySelector('.navigation-palette-item').disabled", f'restart search did not become actionable for {mode} case')
                    driver.call('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                    driver.call('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                    wait("!!document.querySelector('[role=alertdialog]')", f'confirmation missing for {mode} case')
                    click_selector('[role=alertdialog] button:last-of-type')
                    wait("!!document.querySelector('[data-toast-viewport] [data-toast-item][data-toast-tone=warning]')?.textContent.includes('Check gateway status before retrying')", f'{mode} must be reported as uncertain, not failed or accepted')
                    assert evaluate('window.__mcActionCalls.length') == expected_calls, f'{mode} must not automatically retry'
                    evaluate('window.__mcRestartFailureMode = null')
                    check(f'restart {mode} outcome is reported as uncertain without retrying')

                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not reopen palette after restart failure')

                type_search('crOn')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", f'case-insensitive search did not filter: {labels()}')
                assert labels() == ['Cron'], labels()
                type_search('/cron')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", 'route-path search did not filter')
                assert labels() == ['Cron'], labels()
                type_search('no-such-page')
                wait("!!document.querySelector('.navigation-palette-empty')", 'empty state did not render')
                assert labels() == []
                type_search('')
                wait(f"document.querySelectorAll('.navigation-palette-item').length === {len(full)}", 'clearing the query must restore the catalog')
                click_item('Cron')
                wait("!document.querySelector('.navigation-palette')", 'selecting a route did not close the palette')
                wait("document.querySelector('[data-testid=location]')?.textContent === '/cron'", f'route item did not navigate: {evaluate("document.querySelector(\"[data-testid=location]\").textContent")}')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not open on Cron')
                type_search('refresh current view')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1 && !document.querySelector('.navigation-palette-item').disabled", 'refresh did not become available on the registered Cron view')
                driver.call('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                driver.call('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
                wait("window.__mcRefreshCalls.length === 4 && window.__mcRefreshCalls.at(-1) === '/cron'", 'refresh did not invoke the newly active Cron handler')
                check('route change replaces the current-view refresh handler')
                check('search filters case-insensitively and by route path; selecting a route navigates and closes')

                # --- 3. chat entry from the palette ---
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not open the palette')
                type_search('chat')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", f'chat item is not searchable: {labels()}')
                click_item('Chat')
                wait("!document.querySelector('.navigation-palette')", 'selecting chat did not close the palette')
                wait("document.querySelector('.chat-drawer')?.classList.contains('is-open')", 'chat item did not open the drawer')
                check('the chat entry is searchable and opens the chat drawer')

                # --- 4. global shortcut still works from the open drawer ---
                # A real click on the drawer's non-editable header: the target is
                # not a text field, so the shortcut must still work here.
                click_selector('.chat-drawer-head h2')
                assert not active_selector().startswith(('input', 'textarea')), active_selector()
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K must still open the palette from non-editable parts of the open chat drawer')
                screenshot('palette-over-open-drawer')
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'Escape did not close the palette over the drawer')
                assert evaluate("document.querySelector('.chat-drawer')?.classList.contains('is-open')"), 'Escape must close only the topmost layer (the palette), not the chat drawer under it'
                check('the shortcut works from a non-editable part of the open chat drawer (regression guard for the chatOpen suppression)')
                check('Escape closes only the top palette layer; the chat drawer underneath stays open')

                # --- 5. composer/editor non-interference ---
                wait("!!document.querySelector('.chat-composer textarea')", 'chat composer textarea missing')
                wait("!document.querySelector('.chat-composer textarea')?.disabled", 'chat composer textarea never became enabled', timeout=30)
                focus_selector('.chat-composer textarea')
                assert active_selector().startswith('textarea'), active_selector()
                press_shortcut(4)
                time.sleep(0.3)
                assert not is_open(), 'the palette must not steal Cmd+K from the chat composer'
                assert active_selector().startswith('textarea'), active_selector()
                # A plain page input (config-style textarea) keeps its own shortcut too.
                evaluate('''(() => {
                    const host = document.createElement('div');
                    host.id = 'fixture-editable';
                    host.innerHTML = '<textarea aria-label="fixture editor"></textarea>';
                    document.body.appendChild(host); return true; })()''')
                focus_selector('#fixture-editable textarea')
                driver.call('Input.dispatchKeyEvent', type='keyDown', key='k', code='KeyK',
                            modifiers=4, windowsVirtualKeyCode=KEY_K, nativeVirtualKeyCode=KEY_K)
                driver.call('Input.dispatchKeyEvent', type='keyUp', key='k', code='KeyK',
                            modifiers=4, windowsVirtualKeyCode=KEY_K, nativeVirtualKeyCode=KEY_K)
                time.sleep(0.3)
                assert not is_open(), 'the palette must not steal Cmd+K from a plain textarea'
                assert evaluate("document.activeElement === document.querySelector('#fixture-editable textarea')"), 'the editor must keep focus'
                # The probe still owns a live, editable target: real text entry lands there.
                driver.call('Input.insertText', text='k')
                wait("document.querySelector('#fixture-editable textarea').value.includes('k')", 'the focused editor must still accept typing')
                evaluate("document.getElementById('fixture-editable').remove()")
                check('composer and plain editor/textarea keep Cmd+K; the palette does not steal it')

                # Close the drawer before the plugin/mobile passes.
                click_selector('.chat-drawer-head h2')
                press_escape()
                wait("!document.querySelector('.chat-drawer')?.classList.contains('is-open')", 'drawer did not close')

                # --- 6. plugin present vs absent ---
                remount([])
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not open the palette (no-plugin mount)')
                without_plugins = labels()
                assert 'Plugin reports' not in without_plugins, without_plugins
                assert 'Overview' in without_plugins and 'Chat' in without_plugins, without_plugins
                type_search('reports')
                time.sleep(0.2)
                assert labels() == [], f'plugin-only query must be empty without plugins: {labels()}'
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'Escape did not close the palette')
                screenshot('palette-no-plugins')

                remount(plugin_items)
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not open the palette (plugin mount)')
                with_plugins = labels()
                assert 'Plugin reports' in with_plugins, with_plugins
                type_search('plugin')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", f'plugin item is not searchable: {labels()}')
                assert labels() == ['Plugin reports'], labels()
                click_item('Plugin reports')
                wait("!document.querySelector('.navigation-palette')", 'selecting a plugin route did not close the palette')
                wait("document.querySelector('[data-testid=location]')?.textContent === '/reports'", 'plugin route item did not navigate')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not open on an unsupported plugin route')
                assert not evaluate("[...document.querySelectorAll('.navigation-palette-item')].some(el => el.dataset.paletteAction === 'refresh-current-view')"), 'refresh must be excluded when the current view has no handler'
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'palette did not close on plugin route')
                check('plugin-present and plugin-absent catalogs: plugin nav items appear, are searchable and navigate; absent when not registered')

                evaluate("window.__mcFixtureStore.storedToken = ''")
                remount(plugin_items)
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'palette did not open without a gateway token')
                assert not evaluate("[...document.querySelectorAll('.navigation-palette-item')].some(el => el.dataset.paletteAction === 'restart-gateway')"), 'restart must be excluded without an authorization token'
                press_escape()
                evaluate("window.__mcFixtureStore.storedToken = 'fixture-only'")
                remount(plugin_items)

                # --- 7. keyboard navigation: arrows cycle, Enter activates ---
                driver.call('Emulation.setDeviceMetricsOverride', width=1280, height=1000, deviceScaleFactor=1, mobile=False)
                evaluate('window.mountShell({pluginItems: ' + json.dumps(plugin_items) + '})')
                wait("!!document.querySelector('.palette-open-button')", 'shell failed to remount for the keyboard pass')

                def press_key(key, code, vk):
                    driver.call('Input.dispatchKeyEvent', type='keyDown', key=key, code=code, windowsVirtualKeyCode=vk)
                    driver.call('Input.dispatchKeyEvent', type='keyUp', key=key, code=code, windowsVirtualKeyCode=vk)
                    # Let React flush the state update before the next key, so a
                    # fast burst of arrows cannot race the re-render.
                    time.sleep(0.06)

                def selected_index():
                    return evaluate('''[...document.querySelectorAll('.navigation-palette-item')]
                        .findIndex(el => el.classList.contains('is-selected'))''')

                def selected_label():
                    return evaluate('''(() => { const el = document.querySelector('.navigation-palette-item.is-selected');
                        if (!el) return null;
                        return [...el.querySelectorAll('span')].filter(s => !s.hasAttribute('aria-hidden')).map(s => s.textContent).join(''); })()''')

                def selected_route():
                    return evaluate('''(() => { const el = document.querySelector('.navigation-palette-item.is-selected');
                        if (!el) return null; const kbd = el.querySelector('kbd'); return kbd ? kbd.textContent : null; })()''')

                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not open the palette')
                total = evaluate("document.querySelectorAll('.navigation-palette-item').length")
                assert total >= 8, total
                assert selected_index() == -1, 'nothing must be preselected before the user arrows'
                assert evaluate("document.querySelector('.navigation-palette-search input').getAttribute('role')") == 'combobox'
                assert evaluate("document.querySelector('.navigation-palette-results').getAttribute('role')") == 'listbox'

                def wait_selected(n, message=''):
                    wait(f"(document.querySelectorAll('.navigation-palette-item')[{n}]||{{}}).classList?.contains('is-selected')",
                         message or f'expected option {n} to be highlighted')

                press_key('ArrowDown', 'ArrowDown', 40)
                wait_selected(0, 'ArrowDown from no selection must select the first option')
                first_label = selected_label()
                assert evaluate("document.querySelector('.navigation-palette-search input').getAttribute('aria-activedescendant')") == 'navigation-palette-option-0', 'the combobox must point at the selected option'
                assert evaluate("document.querySelector('.navigation-palette-item.is-selected').getAttribute('aria-selected')") == 'true', 'the selected option must be marked aria-selected'
                assert evaluate("document.querySelector('.navigation-palette-search input') === document.activeElement"), 'arrowing must keep focus in the search field'
                assert evaluate("document.querySelectorAll('.navigation-palette-item.is-selected').length === 1"), 'exactly one option must be highlighted'

                # Cyclic movement, then wrap-around at both ends.
                press_key('ArrowDown', 'ArrowDown', 40)
                wait_selected(1)
                press_key('ArrowUp', 'ArrowUp', 38)
                wait_selected(0)
                press_key('ArrowUp', 'ArrowUp', 38)
                wait_selected(total - 1, 'ArrowUp from the first option must wrap to the last')
                press_key('ArrowDown', 'ArrowDown', 40)
                wait_selected(0, 'ArrowDown from the last option must wrap to the first')
                assert selected_label() == first_label, (selected_label(), first_label)
                screenshot('palette-keyboard-selection')
                check('arrow keys cycle the selection with a visible/aria highlight, wrapping at both ends and keeping focus in the search field')

                # Enter navigates to the option currently selected: arrow down to a
                # route the fixture actually renders, then activate it.
                for _ in range(total):
                    if selected_route() == '/cron':
                        break
                    press_key('ArrowDown', 'ArrowDown', 40)
                    time.sleep(0.05)
                assert selected_route() == '/cron', f'expected to reach /cron by arrowing, got {selected_route()}'
                press_key('Enter', 'Enter', 13)
                wait("!document.querySelector('.navigation-palette')", 'Enter did not activate the selected option')
                wait("document.querySelector('[data-testid=location]')?.textContent === '/cron'", 'Enter did not navigate to the selected route')
                check('Enter navigates to the option selected with the arrow keys')

                # Single filtered match: Enter goes straight there, no arrows.
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not reopen the palette')
                type_search('cron')
                wait("document.querySelectorAll('.navigation-palette-item').length === 1", f'search did not collapse to a single match: {labels()}')
                assert selected_index() == -1, 'filtering must not auto-select an option the user never chose'
                press_key('Enter', 'Enter', 13)
                wait("!document.querySelector('.navigation-palette')", 'Enter on a single result did not close the palette')
                wait("document.querySelector('[data-testid=location]')?.textContent === '/cron'", 'Enter on a single result did not navigate directly')
                check('a single filtered result is activated by Enter directly, without arrowing')

                # Regression (PR #105 review): a selection made with the arrows must
                # not survive a query edit. The index is positional, so after the list
                # is re-filtered the same number can point at a different destination;
                # Enter would then activate an item the user never selected.
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not reopen the palette')
                type_search('')
                wait("document.querySelectorAll('.navigation-palette-item').length > 3", f'expected the full list back: {labels()}')
                press_key('ArrowDown', 'ArrowDown', 40)
                press_key('ArrowDown', 'ArrowDown', 40)
                press_key('ArrowDown', 'ArrowDown', 40)
                wait_selected(2, 'three ArrowDown presses must select the third option')
                stale_label = selected_label()
                stale_route = selected_route()
                # Narrow the query to a set that is still longer than the stale index,
                # so a length-only guard would keep it while a query-aware guard clears
                # it. The third entry of the narrowed list is a different destination.
                # The refresh action also matches its searchable alias "current".
                type_search('c')
                wait("document.querySelectorAll('.navigation-palette-item').length === 4", f'expected four matches, got: {labels()}')
                assert selected_index() == -1, f'editing the query must clear the stale selection, kept index {selected_index()}'
                assert stale_route != '/cron', f'the stale entry must differ from the first match (stale was {stale_route})'
                press_key('Enter', 'Enter', 13)
                wait("!document.querySelector('.navigation-palette')", 'Enter after a query edit did not close the palette')
                wait("document.querySelector('[data-testid=location]')?.textContent === '/cron'", 'Enter after a query edit did not navigate to the current first match')
                check('editing the query after an arrow selection clears the stale index: Enter activates the current match, not the previously highlighted item')

                # Empty state: Enter does nothing, arrows select nothing.
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not reopen the palette')
                type_search('no-such-page')
                wait("!!document.querySelector('.navigation-palette-empty')", 'empty state did not render')
                press_key('ArrowDown', 'ArrowDown', 40)
                press_key('Enter', 'Enter', 13)
                time.sleep(0.3)
                assert is_open(), 'Enter on an empty result set must not navigate'
                assert selected_index() == -1, 'an empty result set has no selectable option'
                check('empty result set: arrows select nothing and Enter is inert')
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'Escape did not close the palette')

                # --- 8. mobile: no trigger, not reachable ---
                driver.call('Emulation.setDeviceMetricsOverride', width=390, height=844, deviceScaleFactor=3, mobile=True)
                evaluate('window.mountShell({pluginItems: ' + json.dumps(plugin_items) + '})')
                wait("!!document.querySelector('.workspace-bar')", 'mobile shell failed to mount')
                assert evaluate('innerWidth') == 390, evaluate('innerWidth')
                report['mobile_debug'] = evaluate("({ innerWidth, mm: matchMedia('(max-width: 640px)').matches, buttons: document.querySelectorAll('.palette-open-button').length })")
                # No palette trigger in the sidebar at mobile width. The shell reads
                # the media query through a listener, so give the state a tick.
                wait("document.querySelectorAll('.palette-open-button').length === 0",
                     f"the palette sidebar trigger must not render on mobile: {report['mobile_debug']}")
                # The shortcut is inert and the overlay is not rendered: the palette
                # cannot be reached at all.
                press_shortcut(4)
                time.sleep(0.4)
                assert not is_open(), 'Cmd+K must not open the palette on mobile'
                assert not is_open(), 'the palette must be hidden on mobile'
                assert evaluate('''(() => {
                    const title = document.querySelector('.workspace-title-wrap').getBoundingClientRect();
                    const chat = document.querySelector('.chat-open-button').getBoundingClientRect();
                    return title.right <= chat.left && chat.right <= innerWidth
                        && Math.abs(title.y + title.height / 2 - chat.y - chat.height / 2) < 3;
                })()'''), '390px header title and Chat must align without overlap or overflow'
                check('390px: header title and Chat align without overlap or overflow')
                screenshot('palette-mobile-390')
                check('mobile 390px: no palette trigger in the sidebar and the palette is not reachable (inert shortcut, hidden overlay)')

                # Back to desktop: the palette is reachable again.
                driver.call('Emulation.setDeviceMetricsOverride', width=1280, height=1000, deviceScaleFactor=1, mobile=False)
                evaluate('window.mountShell({pluginItems: ' + json.dumps(plugin_items) + '})')
                wait("!!document.querySelector('.palette-open-button')", 'desktop shell failed to remount')
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K must open the palette again above the mobile breakpoint')
                press_escape()
                wait("!document.querySelector('.navigation-palette')", 'Escape did not close the palette')
                check('desktop is unaffected: the palette opens again above the mobile breakpoint')

                report['requests'] = evaluate('window.requests || []')
                report['browser_errors'] = evaluate('window.failures')
                assert not report['browser_errors'], report['browser_errors']
                report['success'] = True
                if args.keep_open:
                    print(json.dumps({'base': base, 'debug_port': debug_port, 'runtime': str(runtime)}))
                    return
    except Exception as error:
        report['success'] = False
        report['failure'] = str(error)
        raise
    finally:
        if not args.keep_open:
            for process, birth in reversed(launched):
                stop_owned(process, birth)
            report['ports_closed'] = []
            for port in ports:
                with socket.socket() as connection:
                    closed = connection.connect_ex(('127.0.0.1', port)) != 0
                    report['ports_closed'].append(closed)
            (evidence / 'browser-results.json').write_text(json.dumps(report, indent=2))
            assert all(report['ports_closed']), 'Owned probe port leaked'
            shutil.rmtree(runtime, ignore_errors=True)
    if not args.keep_open:
        assert not runtime.exists(), 'Disposable browser runtime leaked'
        print(json.dumps({'browser_pass': True, 'checks': len(report['checks']), 'evidence': str(evidence), 'cleanup': True}))


if __name__ == '__main__':
    main()
