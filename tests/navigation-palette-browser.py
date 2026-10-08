"""Mounted MissionControlShell acceptance for the global navigation palette.

Real MissionControlShell + real ChatDrawer, real key handling, real focus: the
API is a loopback-only synthetic fixture (see navigation-palette-browser-server.mjs)
and the chat WebSocket is completed by a stub upgrade handler. Nothing here
touches user data, the user's Chrome profile, or the live telemetry backend.

Covers the acceptance contract of epic MC-F07: keyboard open/close, search,
keyboard navigation (up/down selection, Enter activation, single-match Enter),
navigation, focus entry/restoration, Escape, editor/composer non-interference,
plugin-present vs plugin-absent catalogs, and the mobile behavior (no header
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
                    wait("!!document.querySelector('.palette-open-button')", 'Palette opener missing')

                # A real Lucide icon name (resolveIcon returns undefined for unknown
                # names, which renders a fallback icon span and would make label
                # extraction ambiguous).
                plugin_items = [{'to': '/reports', 'label': 'Plugin reports', 'icon': 'FileText', 'order': 25}]

                driver.call('Emulation.setDeviceMetricsOverride', width=1280, height=1000, deviceScaleFactor=1, mobile=False)
                driver.call('Page.navigate', url=base)
                wait("!!document.querySelector('.workspace-bar')", 'Shell failed to mount')
                wait("!!document.querySelector('.palette-open-button')", 'Palette opener missing')

                # --- 1. keyboard open, focus entry, close, focus restoration ---
                assert not is_open()
                press_shortcut(4)
                wait("!!document.querySelector('.navigation-palette')", 'Cmd+K did not open the palette')
                assert evaluate("document.querySelector('.navigation-palette').getAttribute('role')") == 'dialog'
                assert evaluate("document.querySelector('.navigation-palette').getAttribute('aria-modal')") == 'true'
                assert evaluate("document.activeElement === document.querySelector('.navigation-palette-search input')"), 'opening must move focus into the search input'
                assert active_selector().startswith('input'), active_selector()
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
                for expected in ('Overview', 'Sessions', 'Kanban', 'Cron', 'Config', 'Chat'):
                    assert expected in full, f'{expected} missing from the palette catalog: {full}'
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
                check('plugin-present and plugin-absent catalogs: plugin nav items appear, are searchable and navigate; absent when not registered')

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
                type_search('c')
                wait("document.querySelectorAll('.navigation-palette-item').length === 3", f'expected three matches, got: {labels()}')
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
                # No palette trigger in the header at mobile width. The shell reads
                # the media query through a listener, so give the state a tick.
                wait("document.querySelectorAll('.palette-open-button').length === 0",
                     f"the palette header trigger must not render on mobile: {report['mobile_debug']}")
                # The shortcut is inert and the overlay is not rendered: the palette
                # cannot be reached at all.
                press_shortcut(4)
                time.sleep(0.4)
                assert not is_open(), 'Cmd+K must not open the palette on mobile'
                assert not is_open(), 'the palette must be hidden on mobile'
                screenshot('palette-mobile-390')
                check('mobile 390px: no palette trigger in the header and the palette is not reachable (inert shortcut, hidden overlay)')

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
