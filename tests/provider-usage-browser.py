"""Mounted Provider Usage acceptance on a loopback-only synthetic fixture.

Uses real React components/loaders/styles and an owned Chrome profile. The API
is a fixture, not CodexBar/account access. Shortens the 10s request deadline to
2s and the 15s UI clock to 50ms; poll intervals are unchanged.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from urllib.request import Request, build_opener, ProxyHandler

import psutil

ROOT = Path(__file__).resolve().parents[1]
HTTP = build_opener(ProxyHandler({}))
CHROME = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')


def stamp(offset=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=offset)).isoformat()


def fixture():
    common = {'available': True, 'dataState': 'ready', 'updatedAt': stamp(),
              'lastAttemptAt': stamp(), 'freshUntil': stamp(300), 'staleAfterSeconds': 300,
              'refreshState': 'idle', 'source': 'api', 'stale': False}
    future = {**common, 'provider': 'future-provider',
              'windows': [{'id': 'primary', 'label': 'API key spend cap', 'usedPercent': 0.005, 'featured': True},
                          {'id': 'extra:daily', 'label': 'Daily requests', 'usedPercent': 125, 'featured': True}],
              'balances': [{'id': 'balance', 'label': 'Balance', 'value': 88, 'currency': 'USD', 'scope': 'account', 'updatedAt': stamp(), 'featured': True},
                           {'id': 'workspace', 'label': 'Workspace credits', 'value': 45, 'unit': 'credits', 'scope': 'workspace', 'featured': True}],
              'metrics': [{'id': f'metric-{i}', 'label': f'Metric {i}', 'value': i, 'featured': i in (1, 2)} for i in range(1, 8)]}
    openrouter = {**common, 'provider': 'openrouter', 'windows': [],
                  'balances': [{'id': 'balance', 'label': 'Balance', 'value': 8, 'currency': 'USD'}],
                  'metrics': [{'id': 'spend', 'label': 'Total spend', 'value': 12, 'currency': 'USD'}]}
    nous = {**common, 'provider': 'nous', 'windows': [], 'balances': [],
            'metrics': [{'id': 'credits', 'label': 'Credits', 'value': 30, 'unit': 'credits'}]}
    ids = [('future-provider', 'Future Provider'), ('openrouter', 'OpenRouter'), ('nous', 'Nous Portal')]
    return {'catalog': {'available': True, 'providers': [
                {'provider': pid, 'displayName': label, 'enabled': True, 'defaultEnabled': True,
                 'source': 'mission-control' if pid == 'nous' else 'codexbar', 'selectable': True} for pid, label in ids],
                'selectedProviders': [pid for pid, _ in ids]},
            'snapshot': {'schemaVersion': 2, 'success': True, 'available': True,
                         'updatedAt': stamp(), 'providers': [future, openrouter, nous]}}


def stop_owned(process, birth):
    if process.poll() is not None:
        return
    owner = psutil.Process(process.pid)
    if owner.create_time() != birth:
        raise RuntimeError('Refusing to stop a recycled process')
    # Each launched fixture has its own session/process group.
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
    parser.add_argument('--evidence-dir', type=Path, default=Path.home() / '.hermes/cache/scratch/provider-browser')
    parser.add_argument('--driver-path', type=Path)
    parser.add_argument('--source-root', type=Path, default=ROOT)
    parser.add_argument('--gate', choices=('featured', 'all'), default='all')
    args = parser.parse_args()
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    core = (Path(os.environ['HERMES_HOME']) / 'hermes-agent').resolve()
    driver_path = args.driver_path or core.parent / 'skills/software-development/browser-cdp-acceptance/scripts/cdp_driver.py'
    if not driver_path.is_file():
        raise RuntimeError('CDP driver unavailable: pass --driver-path to the installed browser-cdp-acceptance driver')
    spec = importlib.util.spec_from_file_location('provider_acceptance_driver', driver_path)
    driver_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver_module)
    if not CHROME.is_file():
        raise RuntimeError('Browser gate blocked: Chrome is unavailable')
    scratch = Path(os.environ['TMPDIR']).resolve()
    report = {'fixture_api': True, 'source': str(args.source_root), 'checks': [], 'screenshots': []}
    with tempfile.TemporaryDirectory(prefix='hermes-verify-provider-browser-', dir=scratch) as disposable:
        runtime = Path(disposable)
        data = fixture()
        payload = runtime / 'fixture.json'
        payload.write_text(json.dumps(data))
        launched = []
        ports = []
        try:
            with (evidence / 'fixture-server.log').open('w') as log:
                server = subprocess.Popen(['node', 'tests/provider-usage-browser-server.mjs', str(payload), str(runtime), str(args.source_root.resolve())],
                                          cwd=ROOT, env=os.environ, stdout=log, stderr=log, start_new_session=True)
                launched.append((server, psutil.Process(server.pid).create_time()))
                deadline = time.monotonic() + 30
                while not (runtime / 'port').exists():
                    if server.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError('Fixture server did not start; inspect fixture-server.log')
                    time.sleep(0.05)
                port = int((runtime / 'port').read_text())
                ports.append(port)
                base = f'http://127.0.0.1:{port}'
                try:
                    HTTP.open(base + '/api/local/provider-usage', timeout=5)
                    raise AssertionError('Anonymous fixture request must be rejected')
                except __import__('urllib.error', fromlist=['HTTPError']).HTTPError as error:
                    assert error.code == 401
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
                            if evaluate(expression):
                                return
                            time.sleep(0.05)
                        report['browser_errors'] = evaluate('window.failures || []')
                        report['requests'] = evaluate('window.requests || []')
                        report['rendered_text'] = evaluate("document.body?.innerText?.slice(0, 3000)")
                        driver.screenshot(str(evidence / 'failure.png'))
                        raise AssertionError(message)

                    def click(selector):
                        point = evaluate(f'''(() => {{ const el = document.querySelector({json.dumps(selector)});
                            if (!el || el.disabled) throw new Error('Missing or disabled control: ' + {json.dumps(selector)});
                            el.scrollIntoView({{block:'center'}}); const r=el.getBoundingClientRect();
                            return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()''')
                        driver.call('Input.dispatchMouseEvent', type='mousePressed', button='left', buttons=1, clickCount=1, **point)
                        driver.call('Input.dispatchMouseEvent', type='mouseReleased', button='left', buttons=0, clickCount=1, **point)

                    def button(text):
                        point = evaluate(f'''(() => {{ const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === {json.dumps(text)});
                            if (!el || el.disabled) throw new Error('Missing or disabled button: ' + {json.dumps(text)});
                            el.scrollIntoView({{block:'center'}}); const r=el.getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()''')
                        driver.call('Input.dispatchMouseEvent', type='mousePressed', button='left', buttons=1, clickCount=1, **point)
                        driver.call('Input.dispatchMouseEvent', type='mouseReleased', button='left', buttons=0, clickCount=1, **point)

                    def check(name):
                        report['checks'].append(name)

                    def control(payload):
                        response = HTTP.open(Request(base + '/fixture/control', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}), timeout=5)
                        assert json.load(response)['accepted']

                    def screenshot(name):
                        target = evidence / (name + '.png')
                        driver.screenshot(str(target)); report['screenshots'].append(str(target))

                    driver.call('Emulation.setDeviceMetricsOverride', width=1024, height=1100, deviceScaleFactor=1, mobile=False)
                    driver.call('Page.navigate', url=base)
                    wait("document.querySelectorAll('article[role=group]').length === 3", 'Mounted cards failed to load')
                    wait("!document.querySelector('button[aria-haspopup=dialog]')?.disabled", 'Customize must be usable')
                    assert evaluate("[...document.querySelectorAll('article:first-child [data-field-id]')].some(el => el.innerText.includes('Metric 2') && el.getClientRects().length)")
                    check('F6: second featured metric mounted and visible')
                    if args.gate == 'featured':
                        screenshot('featured-base-gate')
                    else:
                        assert evaluate("document.body.innerText.includes('125%') && document.body.innerText.includes('<0.01%')")
                        assert evaluate("document.querySelector('article').innerText.includes('Workspace credits')")
                        assert evaluate("!document.querySelectorAll('article')[1].innerText.includes('Session')")
                        check('generic future provider, tiny/overage, balances and uncapped card')
                        assert evaluate("getComputedStyle(document.querySelector('.provider-usage-grid')).gridTemplateColumns.split(' ').length === 2")
                        assert evaluate("document.documentElement.scrollWidth <= innerWidth")
                        screenshot('compact-1024'); check('1024px container grid and no horizontal overflow')
                        click('.provider-fields-overflow summary')
                        assert evaluate("document.querySelector('[data-field-id=metric-7]').getClientRects().length > 0")
                        check('regular overflow accessible by real disclosure click')
                        wait("document.querySelectorAll('article')[2].getAttribute('aria-label').toLowerCase().includes('available')", 'Fixture must start with a fresh card')
                        before = evaluate('window.requests.length')
                        evaluate('window.fixtureNow += 360000')
                        wait("document.querySelectorAll('article')[2].getAttribute('aria-label').toLowerCase().includes('stale')", 'Local clock must expire a card without GET')
                        assert evaluate('window.requests.length') == before
                        evaluate('window.fixtureNow -= 360000')
                        check('F3: local freshness expiry without network request')
                        # Add typed details/chart and visible retained diagnostics.
                        data['snapshot']['providers'][0]['error'] = 'Upstream temporarily unavailable.'
                        data['snapshot']['providers'][0]['refreshState'] = 'failed'
                        data['snapshot']['providers'][0]['metrics'] += [
                            {'id': 'detail', 'label': 'Detail row', 'value': '12 requests', 'secondaryValue': 'per day', 'progress': 0.4, 'sectionLabel': 'Usage'},
                            {'id': 'chart', 'label': 'Daily chart', 'kind': 'chart', 'value': None,
                             'chart': {'kind': 'line', 'title': 'Daily observations', 'points': [{'label': 'One', 'value': 0}, {'label': 'Two', 'value': -2}]}}]
                        control({'snapshot': data['snapshot']})
                        button('Check now')
                        wait("document.body.innerText.includes('Upstream temporarily unavailable.')", 'Retained error hidden')
                        button('Customize')
                        button('Display')

                        radios = evaluate("[...document.querySelectorAll('input[name=provider-usage-view]')].map(el=>el.parentElement.innerText)")
                        assert len(radios) == 2
                        click('input[name=provider-usage-view]:not(:checked)')
                        click('button[aria-label="Close dialog"]')
                        wait("document.body.innerText.includes('Daily observations')", 'Detailed chart missing')
                        assert evaluate("document.querySelector('table')?.innerText.includes('-2')")
                        screenshot('detailed-1024'); check('F4: last-good error/attempt footer and typed details/chart')
                        # Cache malformed field must not erase the healthy siblings.
                        malformed = json.loads(json.dumps(data['snapshot']))
                        malformed['providers'][1]['windows'] = [None]
                        control({'snapshot': malformed}); button('Check now')
                        wait("!document.querySelector('[aria-labelledby=provider-usage-title]').getAttribute('aria-busy') || document.querySelector('[aria-labelledby=provider-usage-title]').getAttribute('aria-busy') === 'false'", 'Malformed refresh did not settle')
                        assert evaluate("document.querySelectorAll('article[role=group]').length === 3")
                        assert evaluate("document.querySelectorAll('article')[1].innerText.includes('$8')")
                        check('F11: malformed field keeps sibling cards and last-good balance')
                        control({'snapshot': data['snapshot']})
                        # Block an old catalog JSON body, save B, then release old A.
                        evaluate("window.holdNext['/api/local/provider-usage/catalog']='oldCatalog'")
                        button('Check now'); wait('!!window.holds.oldCatalog', 'Old catalog body was not held')
                        button('Customize')
                        button('Providers')
                        click('input[aria-label="Collect usage: Nous Portal"]')
                        button('Save selection')
                        wait("!document.querySelector('[role=dialog]')", 'Save did not close the dialog')
                        assert json.loads((runtime / 'selection.json').read_text())['selectedProviders'] == ['future-provider', 'openrouter']
                        evaluate('window.holds.oldCatalog()')
                        wait("document.querySelectorAll('article[role=group]').length === 2", 'Old GET regressed newer selection')
                        check('F7: mounted old GET/PUT race; durable fixture read-back B')
                        # A PUT commits but its JSON response never finishes: reconcile, do not resend.
                        button('Customize')
                        button('Providers')
                        click('input[aria-label="Collect usage: OpenRouter"]')
                        evaluate("window.holdNext['/api/local/provider-usage/selection']='uncertainPut'")
                        put_count = evaluate("window.requests.filter(r=>r.method==='PUT').length")
                        button('Save selection'); wait('!!window.holds.uncertainPut', 'PUT body was not held')
                        wait("!document.querySelector('input[aria-label=\"Collect usage: Future Provider\"]')?.disabled", 'Uncertain save did not reconcile', timeout=10)
                        assert json.loads((runtime / 'selection.json').read_text())['selectedProviders'] == ['future-provider']
                        assert evaluate("window.requests.filter(r=>r.method==='PUT').length") == put_count + 1
                        evaluate('window.holds.uncertainPut()')
                        click('button[aria-label="Close dialog"]')
                        wait("document.querySelectorAll('article[role=group]').length === 1", 'Reconciled selection was lost')
                        check('F5/F7: body-inclusive PUT timeout, reconciliation and no duplicate write')
                        evaluate("window.holdNext['/api/local/provider-usage']='pendingUsage'")
                        button('Check now'); wait('!!window.holds.pendingUsage', 'Usage body was not held')
                        wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Check now'&&!b.disabled)", 'Usage body timeout kept refresh disabled', timeout=10)
                        assert evaluate("document.querySelectorAll('article[role=group]').length === 1")
                        evaluate('window.holds.pendingUsage()')
                        check('F5: stalled usage JSON recovers controls and retains data')
                        driver.call('Emulation.setDeviceMetricsOverride', width=480, height=1000, deviceScaleFactor=1, mobile=False)
                        assert evaluate("getComputedStyle(document.querySelector('.provider-usage-grid')).gridTemplateColumns.split(' ').length === 1")
                        assert evaluate('document.documentElement.scrollWidth <= innerWidth')
                        screenshot('detailed-480'); check('480px wrapping and one-column layout')
                        evaluate('window.unmountPanel()')
                        count = evaluate('window.requests.length')
                        time.sleep(0.15)
                        assert evaluate('window.requests.length') == count
                        check('unmount cancels mounted lifecycle')
                    report['requests'] = evaluate('window.requests')
                    report['browser_errors'] = evaluate('window.failures')
                    assert not report['browser_errors'], report['browser_errors']
                    report['success'] = True
        except Exception as error:
            report['success'] = False
            report['failure'] = str(error)
            raise
        finally:
            for process, birth in reversed(launched):
                stop_owned(process, birth)
            report['ports_closed'] = []
            for port in ports:
                with socket.socket() as connection:
                    closed = connection.connect_ex(('127.0.0.1', port)) != 0
                    report['ports_closed'].append(closed)
            (evidence / 'browser-results.json').write_text(json.dumps(report, indent=2))
            assert all(report['ports_closed']), 'Owned probe port leaked'
    assert not runtime.exists(), 'Disposable browser runtime leaked'
    print(json.dumps({'browser_pass': True, 'checks': len(report['checks']), 'evidence': str(evidence), 'cleanup': True}))


if __name__ == '__main__':
    main()
