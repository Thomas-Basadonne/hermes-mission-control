#!/usr/bin/env python3
"""Read-only Mission Control health checks; no agent, completion or restart."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import plistlib
from html.parser import HTMLParser
import re
import subprocess
import signal
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

SERVICES = ('ai.hermes.mission-control', 'ai.hermes.dashboard-api', 'ai.hermes.mission-control-telemetry')
DEFAULT_TARGETS = {'frontend': 'http://127.0.0.1:5174', 'backend': 'http://127.0.0.1:9119', 'telemetry': 'http://127.0.0.1:8765'}


class HealthFailure(ValueError):
    """Only static, credential-free diagnostics may use this exception."""


class CheckDeadline(BaseException):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a bearer credential to a different origin.
        return None


class LocalHTTP:
    def __init__(self, targets, token):
        self.targets = {}
        for name, url in targets.items():
            parsed = urlparse(url)
            if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'} or parsed.username or parsed.password or parsed.path not in {'', '/'} or parsed.query or parsed.fragment:
                raise HealthFailure('Health targets must be HTTP loopback base URLs')
            self.targets[name] = url.rstrip('/')
        self.token = token
        self.deadline = time.monotonic() + 75
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def read(self, target, path, *, authenticated=True, json_body=True) -> Any:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Health check budget exhausted')
        headers = {'Accept': 'application/json' if json_body else '*/*'}
        if authenticated:
            if not self.token:
                raise HealthFailure('MC credential missing')
            headers['Authorization'] = 'Bearer ' + self.token
        with self.opener.open(Request(self.targets[target] + path, headers=headers), timeout=min(4, remaining)) as response:
            content_type = response.headers.get('Content-Type', '').split(';')[0].lower()
            body = response.read(2_000_001)
        if len(body) > 2_000_000:
            raise HealthFailure('Health response exceeds size limit')
        if not json_body:
            return content_type, body.decode('utf-8')
        if content_type != 'application/json':
            raise HealthFailure('Expected JSON, received a non-API response')
        payload = json.loads(body)
        if not isinstance(payload, dict) or payload.get('error'):
            raise HealthFailure('Malformed or error API response')
        return payload


class Bootstrap(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = False
        self.module = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.root = self.root or attrs.get('id') == 'root'
        src = attrs.get('src', '') or ''
        if tag == 'script' and attrs.get('type') == 'module' and src.startswith('/src/') and not urlparse(src).netloc:
            self.module = src


def service_status(label):
    process = subprocess.run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{label}'], capture_output=True, text=True, timeout=3)
    pid = re.search(r'^\s*pid = (\d+)\s*$', process.stdout, re.M)
    return {'running': process.returncode == 0 and bool(re.search(r'^\s*state = running\s*$', process.stdout, re.M)) and bool(pid), 'pid': int(pid.group(1)) if pid else None}


def probe_websocket(api):
    from websockets.sync.client import connect

    content_type, html = api.read('frontend', '/api/gateway-root', json_body=False)
    match = re.search(r'__HERMES_SESSION_TOKEN__\s*(?:=|:)\s*["\x27]([^"\x27]+)["\x27]', html)
    if 'html' not in content_type or not match:
        raise HealthFailure('Loopback WebSocket credential unavailable')
    url = api.targets['frontend'].replace('http://', 'ws://', 1) + '/api/ws?' + urlencode({'token': match.group(1)})
    with connect(url, open_timeout=4, close_timeout=1, proxy=None) as socket:
        event = json.loads(socket.recv(timeout=4))
        if event.get('method') != 'event' or event.get('params', {}).get('type') != 'gateway.ready':
            raise HealthFailure('WebSocket did not announce gateway.ready')
    return 'authenticated WebSocket + gateway.ready'


def safe_error(exc):
    # Exception messages may contain request URLs with the ephemeral WS credential.
    if isinstance(exc, HealthFailure):
        return str(exc)
    if isinstance(exc, HTTPError):
        return f'HTTP {exc.code}'
    if isinstance(exc, URLError):
        return f'URLError ({type(exc.reason).__name__})'
    return type(exc).__name__


def check_health(targets, token, *, service_probe=service_status):
    api = LocalHTTP(targets, token)
    checks = {}

    def check(name, probe):
        try:
            checks[name] = {'status': 'ok', 'detail': probe()}
            return checks[name]['detail']
        except Exception as exc:
            checks[name] = {'status': 'failed', 'error': safe_error(exc)}
            return None

    def frontend():
        content_type, body = api.read('frontend', '/', authenticated=False, json_body=False)
        bootstrap = Bootstrap()
        bootstrap.feed(body)
        if 'html' not in content_type or not bootstrap.root or not bootstrap.module:
            raise HealthFailure('MC HTML/bootstrap missing')
        return bootstrap.module

    module = check('frontend_html', frontend)
    if module:
        def javascript():
            content_type, body = api.read('frontend', module, authenticated=False, json_body=False)
            if 'javascript' not in content_type or not body.strip():
                raise HealthFailure('Vite bootstrap is not JavaScript')
            return 'compiled bootstrap module'
        check('frontend_javascript', javascript)
    else:
        checks['frontend_javascript'] = {'status': 'skipped', 'detail': 'frontend bootstrap unavailable'}

    def status(target):
        data = api.read(target, '/api/status')
        if not isinstance(data.get('gateway_running'), bool) or not isinstance(data.get('install_id'), str) or not data['install_id']:
            raise HealthFailure('Dashboard status schema invalid')
        return data

    direct = check('backend_api', lambda: status('backend'))
    proxied = check('backend_proxy', lambda: status('frontend'))
    if direct is not None and proxied is not None:
        def identity():
            if direct['install_id'] != proxied['install_id']:
                raise HealthFailure('Vite proxy targets a different installation')
            return 'direct/proxied install_id matched'
        check('backend_identity', identity)
    else:
        checks['backend_identity'] = {'status': 'skipped', 'detail': 'API unavailable'}

    if proxied is not None:
        def gateway():
            if not proxied['gateway_running'] or proxied.get('gateway_state') != 'running':
                raise HealthFailure('Messaging gateway not running')
            return 'running'
        check('gateway', gateway)
    else:
        checks['gateway'] = {'status': 'skipped', 'detail': 'API unavailable'}
    for name in ['backend_api', 'backend_proxy']:
        if checks[name]['status'] == 'ok':
            checks[name]['detail'] = 'authenticated status JSON'

    def telemetry(target, path):
        data = api.read(target, path)
        if data.get('ok') is not True or data.get('service') != 'mission-control-local-telemetry':
            raise HealthFailure('Wrong or unhealthy telemetry service')
        return str(data.get('source', 'unknown'))

    check('telemetry_api', lambda: telemetry('telemetry', '/health'))
    check('telemetry_proxy', lambda: telemetry('frontend', '/api/local/health'))

    def metrics():
        data = api.read('frontend', '/api/local/system')
        if data.get('source') not in {'local-psutil', 'local-darwin'} or not isinstance(data.get('cpuCores'), int) or data['cpuCores'] <= 0:
            raise HealthFailure('Live host metrics missing')
        for name in ['ramUsage', 'diskUsage']:
            total = data.get(name, {}).get('totalGb')
            if not isinstance(total, (int, float)) or total <= 0:
                raise HealthFailure('Host metrics schema invalid')
        return 'live CPU/RAM/disk payload'
    check('system_metrics', metrics)

    def cron():
        data = api.read('frontend', '/api/local/cron/jobs')
        if not isinstance(data.get('jobs'), list) or data.get('count') != len(data['jobs']) or any(not isinstance(j, dict) or not j.get('id') for j in data['jobs']):
            raise HealthFailure('Cron inventory malformed')
        return f"{data['count']} jobs; declared count matches inventory"
    check('cron_inventory', cron)

    def sessions():
        data = api.read(
            'frontend',
            '/api/local/sessions?limit=1&include_facets=0&include_recent_messages=0',
        )
        if data.get('success') is not True or data.get('available') is not True or not isinstance(data.get('items'), list):
            raise HealthFailure('Canonical sessions API unavailable')
        return 'available; read-only limit=1'
    check('sessions_api', sessions)

    def usage():
        data = api.read('frontend', '/api/local/provider-usage')
        if data.get('success') is not True or data.get('available') is not True or not isinstance(data.get('providers'), (dict, list)):
            raise HealthFailure('Provider usage cache unavailable')
        return 'available; cached data, no provider completion'
    check('provider_usage', usage)
    check('chat_websocket', lambda: probe_websocket(api))
    for label in SERVICES:
        def service(label=label):
            detail = service_probe(label)
            if not detail.get('running') or not detail.get('pid'):
                raise HealthFailure('Required MC service not running')
            return detail
        check(label, service)
    failed = [name for name, detail in checks.items() if detail['status'] == 'failed']
    return {'status': 'failed' if failed else 'ok', 'failed_checks': failed, 'checks': checks}


def render_report(report, *, compact=False, event=None):
    checks = report.get('checks', {})
    failed = report.get('failed_checks', [])
    ok = report.get('status') == 'ok'
    heading = '✅ operativo' if ok else '❌ degradato'
    if event == 'recovered':
        heading = '✅ ripristinato dopo un errore'
    elif event == 'initial':
        heading = '✅ monitor attivato' if ok else heading
    lines = ['# 🛰️ Mission Control · Health report', '', f'**Esito:** {heading}']
    if not compact:
        lines += [f"**Verifica:** {report.get('checked_at', '—')} · {report.get('duration_seconds', '—')} s"]
    if compact and not ok:
        # Keep incident signatures stable: no time, latency, PIDs or healthy metrics.
        lines += ['', '## Controlli falliti']
        lines += [f"- **{name}:** {checks[name].get('error', 'failed')}" for name in failed]
    else:
        passed = sum(detail['status'] == 'ok' for detail in checks.values())
        lines += [f'**Controlli:** {passed}/{len(checks)} superati', '']
        if not compact:
            lines += ['| Controllo | Esito | Dettaglio |', '|---|---|---|']
        for name, detail in checks.items():
            value = detail.get('error', detail.get('detail', ''))
            if isinstance(value, dict):
                value = f"PID {value.get('pid', '—')}"
            value = str(value).replace('|', '/').replace('\n', ' ')
            badge = {'ok': '✅', 'failed': '❌', 'skipped': '⏭️'}[detail['status']]
            lines.append(f'- {badge} **{name}**: {value}' if compact else f'| {name} | {badge} | {value} |')
    lines += ['', '**Limiti:** nessun completion, apprendimento o riavvio; nessuna simulazione di un turno chat. Se lo scheduler Hermes si ferma, questo cron non può inviare alert.', '']
    return '\n'.join(lines)


def collect_report(targets, token, *, service_probe=service_status):
    started = time.monotonic()
    try:
        report = check_health(targets, token, service_probe=service_probe)
    except (Exception, CheckDeadline) as exc:
        report = {'status': 'failed', 'failed_checks': ['watchdog'], 'checks': {'watchdog': {'status': 'failed', 'error': safe_error(exc)}}}
    report['checked_at'] = datetime.now(timezone.utc).isoformat()
    report['duration_seconds'] = round(time.monotonic() - started, 2)
    return report


def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.mc-health-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run_watchdog(home, targets, token, *, service_probe=service_status):
    path = home / 'run/mc-health-watchdog.json'
    previous = None
    state_error = None
    if path.exists():
        try:
            previous = json.loads(path.read_text())['status']
            if previous not in {'ok', 'failed'}:
                raise HealthFailure('Invalid prior watchdog status')
        except Exception as exc:
            state_error = safe_error(exc)
    report = collect_report(targets, token, service_probe=service_probe)
    if state_error:
        report['checks']['watchdog_state'] = {'status': 'failed', 'error': state_error}
        report['failed_checks'].append('watchdog_state')
        report['status'] = 'failed'
    event = 'failed' if report['status'] == 'failed' else 'recovered' if previous == 'failed' else 'initial' if previous is None else None
    report['event'] = event
    private_write(home / 'run/mc-health-watchdog.md', render_report(report, event=event))
    private_write(path, json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    # Persistent ERROR remains nonzero; Hermes incident handling dedupes failures.
    return report, render_report(report, compact=True, event=event) if event else ''


def load_token():
    path = Path.home() / 'Library/LaunchAgents/ai.hermes.mission-control.plist'
    with path.open('rb') as stream:
        environment = plistlib.load(stream).get('EnvironmentVariables', {})
    token = environment.get('MISSION_CONTROL_TOKEN') or environment.get('API_SERVER_KEY')
    if not isinstance(token, str) or not token:
        raise HealthFailure('MC credential absent in the frontend LaunchAgent')
    return token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preview', action='store_true', help='Print a live report without state writes or Telegram delivery')
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERMES_HOME') or Path.home() / '.hermes'))
    for target, default in DEFAULT_TARGETS.items():
        parser.add_argument('--' + target, default=default)
    args = parser.parse_args()
    targets = {name: getattr(args, name) for name in DEFAULT_TARGETS}

    def deadline(signum, frame):
        raise CheckDeadline()

    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(100)
    try:
        token = load_token()
        if args.preview:
            report = collect_report(targets, token)
            output = render_report(report)
        else:
            directory = args.home / 'run'
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(directory / 'mc-health-watchdog.lock', os.O_RDWR | os.O_CREAT, 0o600)
            with os.fdopen(fd, 'a') as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                report, output = run_watchdog(args.home, targets, token)
        if output:
            print(output, end='')
        return 0 if report['status'] == 'ok' else 1
    except (Exception, CheckDeadline) as exc:
        report = {'status': 'failed', 'failed_checks': ['watchdog'], 'checks': {'watchdog': {'status': 'failed', 'error': safe_error(exc)}}}
        print(render_report(report, compact=True))
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    sys.exit(main())
