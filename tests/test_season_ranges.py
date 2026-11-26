import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from server.episodes import SCHEMA, install_catalogues


class SeasonRangeTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.addCleanup(self.conn.close)
        self.conn.executescript(SCHEMA)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "catalogues.json"
        self.urls = [f"https://example.org/{i}.m3u8" for i in range(1, 6)]
        self.root = dict(work="show", source="modu", title="原有连播", urls=self.urls)
        self.season = dict(work="show-s2", source="modu", title="第二季", fromWork="show", first=3, last=5)

    def install(self, *rows):
        self.path.write_text(json.dumps(rows))
        install_catalogues(self.conn, self.path)

    def line(self, work, source="modu"):
        return self.conn.execute("SELECT * FROM episode_lines WHERE work_id=? AND source=?", (work, source)).fetchone()

    def test_split_preserves_original_revision_progress_and_season_overrides(self):
        self.install(self.root)
        original = self.line("show")
        progress = (1, "show", "modu", "第4集", 42)
        with self.conn:
            self.conn.execute("INSERT INTO episode_progress VALUES (?,?,?,?,?)", progress)
        first = dict(self.season, work="show-s1", title="第一季", first=1, last=2)
        self.install(first, self.season, self.root)
        self.assertEqual(self.line("show"), original)
        self.assertEqual(self.conn.execute("SELECT * FROM episode_progress").fetchone(), progress)
        self.assertEqual(json.loads(self.line("show-s2")[4]), [
            dict(label=f"第{i}集", url=url) for i, url in enumerate(self.urls[2:], 1)])
        with self.conn:
            self.conn.execute("UPDATE episode_lines SET revision='manual', title='自定义' WHERE work_id='show-s2'")
            self.conn.execute("DELETE FROM episode_lines WHERE work_id='show-s1'")
        override = self.line("show-s2")
        self.install(self.root, dict(first, title="第一季更新"), dict(self.season, title="第二季更新"))
        self.assertEqual(self.line("show-s2"), override)
        self.assertIsNone(self.line("show-s1"))
        self.assertEqual(self.conn.execute("SELECT * FROM episode_progress").fetchone(), progress)

    def test_removed_or_replaced_parent_not_republished_as_new_season(self):
        other = dict(self.root, source="hongniu")
        self.install(self.root, other)
        with self.conn:
            self.conn.execute("DELETE FROM episode_lines WHERE source='modu'")
            self.conn.execute("UPDATE episode_lines SET revision='manual' WHERE source='hongniu'")
        self.install(self.root, other, self.season, dict(self.season, source="hongniu"))
        self.assertIsNone(self.line("show-s2", "modu"))
        self.assertIsNone(self.line("show-s2", "hongniu"))
        self.assertEqual(self.line("show", "hongniu")[2], "manual")

    def test_invalid_ranges_and_foreign_sources_roll_back_whole_install(self):
        for change in (dict(first=0), dict(last=6), dict(first=5, last=4), dict(last=True),
                       dict(source="hongniu"), dict(fromWork="missing")):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.install(self.root, dict(self.season, **change))
            self.assertIsNone(self.line("show"))
            self.assertIsNone(self.conn.execute("SELECT digest FROM episode_bundle").fetchone())
