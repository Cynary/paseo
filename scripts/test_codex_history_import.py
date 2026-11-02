from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('history_import', Path(__file__).with_name('codex-history-import.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

@contextmanager
def database(file):
    db = sqlite3.connect(file)
    try:
        with db:
            yield db
    finally:
        db.close()


class HistoryImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source, self.target = [Path(self.tmp.name) / n for n in ('source', 'target')]
        for home in (self.source, self.target):
            home.mkdir()
            with database(home / module.STATE) as db:
                db.executescript('''
                    CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT,
                      sandbox_policy TEXT, archived INTEGER, thread_section_id TEXT, project_id TEXT);
                    CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, metadata TEXT);
                    CREATE TABLE project_roots(project_id TEXT, position INTEGER, path TEXT, PRIMARY KEY(project_id,position));
                    CREATE TABLE project_idempotency_keys(key TEXT PRIMARY KEY, project_id TEXT);
                    CREATE TABLE thread_sections(id TEXT PRIMARY KEY, name TEXT);
                    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY);
                    CREATE TABLE remote_control_enrollments(secret TEXT);
                ''')
                for table in ('thread_dynamic_tools', 'thread_attachments', 'guardian_review_feedback', 'thread_read_receipts'):
                    db.execute(f'CREATE TABLE {table}(thread_id TEXT PRIMARY KEY, data TEXT)')
                db.execute('INSERT INTO remote_control_enrollments VALUES (?)', (home.name,))
            with database(home / module.HISTORY) as db:
                for table in module.HISTORY_TABLES:
                    db.execute(f'CREATE TABLE {table}(thread_id TEXT PRIMARY KEY, rollout_byte_offset INTEGER, data TEXT)')
        file = self.source / 'archived_sessions' / 'session.jsonl'
        file.parent.mkdir()
        first = json.dumps({'type': 'session_meta', 'payload': {'id': 'thread', 'cwd': '/old/repo'}}).encode() + b'\n'
        file.write_bytes(first + b'{"type":"event_msg","payload":{}}\n')
        self.original = file.read_bytes()
        self.offset = len(first)
        with database(self.source / module.STATE) as db:
            db.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?)', ('thread', str(file), '/old/repo', '{"writable_roots":["/old/repo"]}', 1, 'section', 'project'))
            db.execute('INSERT INTO projects VALUES (?,?,?)', ('project', 'My project', '{"paseo.projectId":"old","custom":"kept"}'))
            db.execute('INSERT INTO project_roots VALUES (?,?,?)', ('project', 0, '/old/repo'))
            db.execute('INSERT INTO thread_sections VALUES (?,?)', ('section', 'Pinned'))
        with database(self.source / module.HISTORY) as db:
            for table in module.HISTORY_TABLES:
                db.execute(f'INSERT INTO {table} VALUES (?,?,?)', ('thread', self.offset, 'history only in SQLite'))

    def tearDown(self):
        self.tmp.cleanup()

    def test_dry_run_then_additive_idempotent_merge(self):
        result = module.import_history(self.source, self.target)
        self.assertEqual(result['threads'], 1)
        self.assertFalse((self.target / 'archived_sessions').exists())
        result = module.import_history(self.source, self.target, True)
        self.assertEqual(result['archived'], 1)
        self.assertTrue(Path(result['backup'], module.STATE).exists())
        self.assertEqual((self.target / 'archived_sessions/session.jsonl').read_bytes(), self.original)
        with database(self.target / module.STATE) as db:
            self.assertEqual(db.execute('SELECT secret FROM remote_control_enrollments').fetchone()[0], 'target')
            self.assertEqual(db.execute('SELECT name FROM projects').fetchone()[0], 'My project')
        with database(self.target / module.HISTORY) as db:
            self.assertEqual(db.execute('SELECT data FROM thread_items').fetchone()[0], 'history only in SQLite')
        self.assertEqual(module.import_history(self.source, self.target, True)['duplicatesSkipped'], 1)

    def test_path_mapping_keeps_rollout_offsets_valid(self):
        module.import_history(self.source, self.target, True, [('/old', '/different/new')])
        data = (self.target / 'archived_sessions/session.jsonl').read_bytes()
        self.assertEqual(json.loads(data.splitlines()[0])['payload']['cwd'], '/different/new/repo')
        with database(self.target / module.HISTORY) as db:
            offset = db.execute('SELECT rollout_byte_offset FROM thread_turns').fetchone()[0]
            self.assertEqual(data[offset:], self.original[self.offset:])
        with database(self.target / module.STATE) as db:
            self.assertEqual(db.execute('SELECT cwd FROM threads').fetchone()[0], '/different/new/repo')

    def test_history_failure_rolls_back_state_and_files(self):
        with database(self.target / module.HISTORY) as db:
            db.execute('INSERT INTO thread_items VALUES (?,?,?)', ('thread', 1, 'conflict'))
        with self.assertRaises(sqlite3.IntegrityError):
            module.import_history(self.source, self.target, True)
        with database(self.target / module.STATE) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM threads').fetchone()[0], 0)
        self.assertFalse((self.target / 'archived_sessions/session.jsonl').exists())

    def test_export_excludes_enrollment_and_reimports(self):
        bundle = Path(self.tmp.name) / 'bundle'
        module.export_history(self.source, bundle)
        with database(bundle / module.STATE) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM remote_control_enrollments').fetchone()[0], 0)
        module.import_history(bundle, self.target, True)
        self.assertEqual((self.target / 'archived_sessions/session.jsonl').read_bytes(), self.original)

    def test_schema_mismatch_fails_before_mutation(self):
        with database(self.target / module.STATE) as db:
            db.execute('ALTER TABLE threads ADD COLUMN new_field TEXT')
        with self.assertRaisesRegex(ValueError, 'Incompatible threads schema'):
            module.import_history(self.source, self.target, True)
        self.assertFalse((self.target / 'paseo-import-backups').exists())


if __name__ == '__main__':
    unittest.main()
