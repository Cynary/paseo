#!/usr/bin/env python3
"""Offline, additive Codex history merge. Python 3.10+, Codex 0.166 schema.

Both homes must be unused by Codex/Paseo during --apply. Default is a dry run.
Authentication, enrollment, settings, and machine-local execution state stay put.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time

STATE = 'state_5.sqlite'
HISTORY = 'thread_history_1.sqlite'
STATE_TABLES = ['thread_sections', 'projects', 'project_roots', 'project_idempotency_keys',
                'threads', 'thread_dynamic_tools', 'thread_spawn_edges', 'thread_attachments',
                'guardian_review_feedback', 'thread_read_receipts']
HISTORY_TABLES = ['thread_turns', 'thread_items', 'thread_history_projection_state', 'thread_realtime_items']


def connect(home, name):
    db = sqlite3.connect((home / name).as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def columns(db, table, schema='main'):
    return [r[1] for r in db.execute(f'PRAGMA {schema}.table_info("{table}")')]


def remap(value, mappings):
    if isinstance(value, str):
        for old, new in mappings:
            if value == old or value.startswith(old + '/'):
                return new + value[len(old):]
    elif isinstance(value, list):
        return [remap(v, mappings) for v in value]
    elif isinstance(value, dict):
        return {k: remap(v, mappings) for k, v in value.items()}
    return value


def require_offline(homes):
    # Linux can establish that no other process has either database open. Other
    # platforms still require the documented offline precondition.
    proc = Path('/proc')
    if not proc.exists():
        return
    protected = {str(home / name) for home in homes for name in (STATE, HISTORY)}
    for process in proc.iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            for fd in (process / 'fd').iterdir():
                try:
                    opened = str(fd.resolve())
                except OSError:
                    continue
                if opened in protected:
                    raise ValueError(f'Codex database is open in process {process.name}; stop both app-servers and Paseo before importing/exporting.')
        except (PermissionError, FileNotFoundError, ProcessLookupError):
            continue


def import_history(source, target, apply=False, mappings=()):
    source, target = Path(source).expanduser().resolve(), Path(target).expanduser().resolve()
    if source == target:
        raise ValueError('Homes are identical: use codex-bulk-import.mts to register existing history in Paseo.')
    if source in target.parents or target in source.parents:
        raise ValueError('Source and destination homes must not contain one another.')
    if apply:
        require_offline([source, target])
    src, dst = connect(source, STATE), connect(target, STATE)
    history_src, history_dst = connect(source, HISTORY), connect(target, HISTORY)
    try:
        for left, right, tables in [(src, dst, STATE_TABLES), (history_src, history_dst, HISTORY_TABLES)]:
            for table in tables:
                if not columns(left, table) or columns(left, table) != columns(right, table):
                    raise ValueError(f'Incompatible {table} schema; initialize both homes with the same Codex version first.')
        existing = {r[0] for r in dst.execute('SELECT id FROM threads')}
        rows = [dict(r) for r in src.execute('SELECT * FROM threads') if r['id'] not in existing]
        ids = {r['id'] for r in rows}
        sections = {r['thread_section_id'] for r in rows if r['thread_section_id']}
        projects = {r['project_id'] for r in rows if r['project_id']}
        for project_id in projects:
            target_roots = [r[0] for r in dst.execute('SELECT path FROM project_roots WHERE project_id=? ORDER BY position', (project_id,))]
            source_roots = [remap(r[0], mappings) for r in src.execute('SELECT path FROM project_roots WHERE project_id=? ORDER BY position', (project_id,))]
            if target_roots and target_roots != source_roots:
                raise ValueError(f'Project {project_id} already exists with different roots; resolve the collision before importing.')
        files = []
        for row in rows:
            original = Path(row['rollout_path'])
            # A transferred home retains the original absolute paths in its database.
            # Find the sessions/archived_sessions suffix inside the copied home.
            candidates = [source / Path(*original.parts[i:]) for i, p in enumerate(original.parts)
                          if p in ('sessions', 'archived_sessions')]
            found = next((p for p in candidates if p.is_file()), None)
            if not found:
                raise ValueError(f'Missing rollout for {row["id"]}; no changes made.')
            relative = found.relative_to(source)
            destination = target / relative
            if destination.exists():
                raise ValueError(f'Unindexed destination rollout already exists: {destination}')
            with found.open('rb') as f:
                first = f.readline()
            meta = json.loads(first)
            replacement = first
            if mappings:
                if meta.get('type') != 'session_meta':
                    raise ValueError(f'Cannot remap rollout without initial session_meta: {relative}')
                meta['payload'] = remap(meta['payload'], mappings)
                replacement = (json.dumps(meta, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
            files.append((found, destination, first, replacement, row['id']))
            row['rollout_path'] = str(destination)
            row['cwd'] = remap(row['cwd'], mappings)
            if mappings:
                row['sandbox_policy'] = json.dumps(remap(json.loads(row['sandbox_policy']), mappings))
        report = {'source': str(source), 'target': str(target), 'threads': len(rows),
                  'archived': sum(bool(r['archived']) for r in rows),
                  'duplicatesSkipped': len(existing & {r[0] for r in src.execute('SELECT id FROM threads')}),
                  'bytes': sum(p.stat().st_size for p, *_ in files), 'applied': False}
        if not apply or not rows:
            return report
        backup = target / 'paseo-import-backups' / f'{time.time_ns()}'
        backup.mkdir(parents=True, mode=0o700)
        for name, db in [(STATE, dst), (HISTORY, history_dst)]:
            copy = sqlite3.connect(backup / name)
            try:
                db.backup(copy)
            finally:
                copy.close()
        # One attached-database transaction; DELETE journals provide a shared
        # super-journal so state/history commit together rather than separate WALs.
        dst.close()
        history_dst.close()
        write = sqlite3.connect(target / STATE)
        write.execute('PRAGMA journal_mode=DELETE')
        write.execute('ATTACH DATABASE ? AS history', (str(target / HISTORY),))
        write.execute('PRAGMA history.journal_mode=DELETE')
        write.execute('PRAGMA foreign_keys=ON')
        copied = []
        deltas = {tid: len(new) - len(old) for _, _, old, new, tid in files}
        try:
            write.execute('BEGIN IMMEDIATE')
            for original, destination, first, replacement, _ in files:
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                # Exclusive creation prevents a racing importer from overwriting a rollout.
                with destination.open('xb') as output:
                    copied.append(destination)
                    os.chmod(destination, 0o600)
                    with original.open('rb') as inp:
                        inp.read(len(first))
                        output.write(replacement)
                        shutil.copyfileobj(inp, output)
                    output.flush()
                    os.fsync(output.fileno())

            def insert(table, row, schema='main', ignore=False):
                cols = list(row)
                sql = (f'INSERT {"OR IGNORE " if ignore else ""}INTO {schema}."{table}" (' +
                       ','.join('"' + c + '"' for c in cols) + ') VALUES (' + ','.join('?' for _ in cols) + ')')
                write.execute(sql, [row[c] for c in cols])

            for table in STATE_TABLES:
                if table == 'threads':
                    for row in rows:
                        insert(table, row)
                    continue
                for raw in src.execute(f'SELECT * FROM "{table}"'):
                    row = dict(raw)
                    if table == 'thread_sections':
                        include = row['id'] in sections
                    elif table == 'projects':
                        include = row['id'] in projects
                    elif table in ('project_roots', 'project_idempotency_keys'):
                        include = row['project_id'] in projects
                    elif table == 'thread_spawn_edges':
                        include = row['child_thread_id'] in ids and row['parent_thread_id'] in (ids | existing)
                    else:
                        include = row['thread_id'] in ids
                    if not include:
                        continue
                    if table == 'project_roots':
                        row['path'] = remap(row['path'], mappings)
                    if table == 'projects':
                        # Paseo's old host-specific mapping is not portable.
                        metadata = json.loads(row['metadata'])
                        row['metadata'] = json.dumps({k: v for k, v in metadata.items() if not k.startswith('paseo.')})
                    if table == 'project_idempotency_keys' and row['key'].startswith('paseo:'):
                        continue
                    insert(table, row, ignore=table in ('projects', 'project_roots', 'project_idempotency_keys', 'thread_sections'))
            for table in HISTORY_TABLES:
                for raw in history_src.execute(f'SELECT * FROM "{table}"'):
                    row = dict(raw)
                    if row['thread_id'] not in ids:
                        continue
                    delta = deltas[row['thread_id']]
                    for key in ('rollout_byte_offset', 'rollout_end_byte_offset', 'next_rollout_byte_offset'):
                        if row.get(key) is not None and row[key] > 0:
                            row[key] += delta
                    insert(table, row, 'history')
            if write.execute('PRAGMA foreign_key_check').fetchone():
                raise ValueError('Foreign-key verification failed; rolling back.')
            write.commit()
        except BaseException:
            write.rollback()
            for file in copied:
                file.unlink(missing_ok=True)
            raise
        finally:
            write.close()
        report.update(applied=True, backup=str(backup))
        (backup / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
        return report
    finally:
        src.close()
        dst.close()
        history_src.close()
        history_dst.close()


def export_history(source, destination):
    """Create a portable history-only directory; source must be offline."""
    source, destination = Path(source).expanduser().resolve(), Path(destination).expanduser().resolve()
    if destination.exists() or source in destination.parents:
        raise ValueError('Export destination must be a new directory outside the source home.')
    require_offline([source])
    destination.mkdir(parents=True, mode=0o700)
    try:
        for name, allowed in [(STATE, STATE_TABLES), (HISTORY, HISTORY_TABLES)]:
            original = connect(source, name)
            copy = sqlite3.connect(destination / name)
            try:
                original.backup(copy)
                tables = [r[0] for r in copy.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                for table in tables:
                    if table not in allowed and not table.startswith('sqlite_') and table != '_sqlx_migrations':
                        copy.execute('DELETE FROM "' + table.replace('"', '""') + '"')
                copy.commit()
                copy.execute('VACUUM')
            finally:
                copy.close()
                original.close()
            os.chmod(destination / name, 0o600)
        for name in ('sessions', 'archived_sessions'):
            if (source / name).exists():
                shutil.copytree(source / name, destination / name)
        (destination / 'paseo-history-export.json').write_text(json.dumps({'format': 1, 'source': str(source)}))
    except BaseException:
        shutil.rmtree(destination)
        raise
    return {'exported': str(destination), 'note': 'Contains private conversation history; does not include repositories or external attachments.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='Original or transferred Codex home')
    parser.add_argument('--target', help='Initialized destination Codex home')
    parser.add_argument('--apply', action='store_true', help='Merge; both homes must be offline')
    parser.add_argument('--map-path', action='append', default=[], metavar='OLD=NEW')
    parser.add_argument('--export', metavar='DIRECTORY', help='Create a portable history-only directory from an offline home')
    parser.add_argument('--inventory', action='store_true', help='Read thread/project inventory only')
    args = parser.parse_args()
    if args.export:
        print(json.dumps(export_history(args.source, args.export), indent=2))
        return
    if args.inventory:
        db = connect(Path(args.source).expanduser().resolve(), STATE)
        try:
            print(json.dumps({'threads': [dict(r) for r in db.execute('SELECT id,cwd,archived,source,project_id,name,first_user_message FROM threads')], 'projects': [dict(r) for r in db.execute('SELECT p.id,p.name,r.path FROM projects p JOIN project_roots r ON p.id=r.project_id WHERE r.position=0')]}))
        finally:
            db.close()
        return
    if not args.target:
        parser.error('--target is required for a merge')
    mappings = []
    for mapping in args.map_path:
        old, sep, new = mapping.partition('=')
        if not sep or not old.startswith('/') or not new.startswith('/'):
            parser.error('--map-path requires absolute OLD=NEW paths')
        mappings.append((old.rstrip('/'), new.rstrip('/')))
    mappings.sort(key=lambda pair: len(pair[0]), reverse=True)
    print(json.dumps(import_history(args.source, args.target, args.apply, mappings), indent=2))


if __name__ == '__main__':
    main()
