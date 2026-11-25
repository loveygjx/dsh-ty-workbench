#!/usr/bin/env python3
"""Run isolated LibreOffice UNO row operations on a new XLSX file.

Batch mode: --ops-file JSON with a list of {"sheet","operation","row","count"}.
Legacy single-operation mode: --sheet/--operation/--row/--count (one op).
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent


def stop_group(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)


def _load_ops(args):
    """Ops list: either --ops-file JSON or the legacy single-op arguments."""
    if args.ops_file:
        raw = json.loads(Path(args.ops_file).read_text(encoding='utf-8'))
        if not isinstance(raw, list) or not raw:
            raise ValueError('ops file must be a non-empty JSON array')
        ops = []
        for item in raw:
            if not isinstance(item, dict) or set(item) != {'sheet', 'operation', 'row', 'count'}:
                raise ValueError('each op needs exactly sheet/operation/row/count')
            if item['operation'] not in ('insert', 'delete'):
                raise ValueError('operation must be insert or delete')
            if int(item['row']) < 1 or int(item['count']) < 1:
                raise ValueError('row and count must be positive')
            ops.append((str(item['sheet']), item['operation'], int(item['row']), int(item['count'])))
        sheets = [o[0] for o in ops]
        if len(set(sheets)) != len(sheets):
            raise ValueError('at most one operation per sheet')
        return ops
    if args.row < 1 or args.count < 1 or not args.sheet:
        raise ValueError('sheet, positive row/count are required in single-op mode')
    return [(args.sheet, args.operation, args.row, args.count)]


def run(args):
    source = Path(args.source).expanduser().resolve(strict=True)
    target = Path(args.target).expanduser().absolute()
    if source.suffix.lower() != '.xlsx' or target.suffix.lower() != '.xlsx':
        raise ValueError('source and target must be XLSX files')
    if target.resolve() == source or target.exists():
        raise ValueError('target must differ from source and must not already exist')
    if args.timeout <= 0:
        raise ValueError('positive timeout is required')
    ops = _load_ops(args)
    java_home = Path(args.java_home).expanduser().resolve(strict=True)
    java = java_home / 'bin/java'
    javac = Path(args.javac).expanduser().resolve(strict=True) if args.javac else java_home / 'bin/javac'
    soffice = Path(args.soffice).expanduser().resolve(strict=True)
    jars = Path(args.uno_jars).expanduser().resolve(strict=True)
    for executable in (java, javac, soffice):
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValueError(f'executable unavailable: {executable}')
    if not (jars / 'juh.jar').is_file():
        raise ValueError('UNO jars directory does not contain juh.jar')
    with tempfile.TemporaryDirectory(prefix='uno-row-') as temp:
        temp = Path(temp)
        env = os.environ.copy()
        env.update({'HOME': str(temp), 'TMPDIR': str(temp), 'JAVA_HOME': str(java_home)})
        subprocess.run([str(javac), '-cp', str(jars / '*'), '-d', str(temp), str(HERE / 'RowBridge.java')], check=True, timeout=args.timeout, env=env)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        profile = (temp / 'profile').as_uri()
        out = temp / 'result.xlsx'
        with (temp / 'soffice.log').open('w+') as log:
            server = subprocess.Popen([str(soffice), '-env:UserInstallation=' + profile, '--headless', '--norestore', '--nodefault', '--nofirststartwizard', f'--accept=socket,host=127.0.0.1,port={port};urp;StarOffice.ServiceManager'], stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
            try:
                deadline = time.monotonic() + args.timeout
                while True:
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(f'LibreOffice exited early: {log.read()}')
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=.25):
                            break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError('LibreOffice UNO connection timeout')
                        time.sleep(.1)
                cp = str(temp) + os.pathsep + str(jars / '*')
                command = [str(java), '-cp', cp, 'RowBridge', str(port), source.as_uri(), out.as_uri()]
                for sheet, operation, row, count in ops:
                    command += [sheet, operation, str(row), str(count)]
                subprocess.run(command, check=True, timeout=args.timeout, env=env)
                if not out.is_file():
                    raise RuntimeError('UNO did not create output')
                with out.open('rb') as src, target.open('xb') as dst:
                    try:
                        shutil.copyfileobj(src, dst)
                    except BaseException:
                        dst.close()
                        target.unlink(missing_ok=True)
                        raise
            finally:
                stop_group(server)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--java-home', required=True, help='JDK home (or JRE home with --javac)')
    parser.add_argument('--javac', help='javac executable when java-home is a JRE')
    parser.add_argument('--soffice', required=True, help='LibreOffice soffice executable')
    parser.add_argument('--uno-jars', required=True, help='LibreOffice Java jars directory')
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True, help='new file; existing files never overwritten')
    parser.add_argument('--ops-file', help='JSON array of {sheet,operation,row,count}; batch mode')
    parser.add_argument('--sheet', help='exact worksheet name (legacy single-op mode)')
    parser.add_argument('--operation', choices=('insert', 'delete'), help='legacy single-op mode')
    parser.add_argument('--row', type=int, help='1-based insertion/deletion row (legacy single-op mode)')
    parser.add_argument('--count', type=int, help='legacy single-op mode')
    parser.add_argument('--timeout', type=float, default=30, help='seconds for each startup or subprocess stage')
    run(parser.parse_args())


if __name__ == '__main__':
    main()
