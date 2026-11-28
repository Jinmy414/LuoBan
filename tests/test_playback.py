import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from server.app import COOKIE, create_app, digest
from server.episodes import HISTORY_MARKER, episode_summary


class PlaybackTest(unittest.TestCase):
    key = "animation-222-E5A4A7E880B3E69CB5E59BBEE59BBE-s2"

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = Path(temp.name) / "db"
        app = create_app(dict(AUTH_SECRET="test" * 12, DATABASE=str(self.db), PUBLIC_ORIGIN="https://unit.test"))
        self.client = app.test_client()
        self.client.set_cookie(COOKIE, "viewer")
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("INSERT INTO accounts VALUES (1,'A','a','a@example.test','unused')")
            conn.execute("INSERT INTO sessions VALUES (?,1,9999999999)", (digest("viewer"),))

    def test_real_progress_survives_opening_and_legacy_zero_reports(self):
        catalogue = "/api/episodes/" + self.key
        line = next(l for l in self.client.get(catalogue).json["lines"] if l["source"] == "youtube")
        def record(label, **fields):
            data = dict(source=line["source"], revision=line["revision"], accountId=1, label=label, **fields)
            return self.client.post("/api/episode-progress/" + self.key, json=data, headers={"Origin": "https://unit.test"})
        def history():
            return self.client.get("/api/history").json["items"][0]
        self.assertEqual(record("第1集", seconds=42).status_code, 200)
        self.assertEqual(record("第1集", seconds=0).status_code, 200)
        self.assertEqual((history()["kind"], history()["seconds"]), ("progress", 42))
        self.assertEqual(record("第2集", kind="opened", seconds=None).status_code, 200)
        self.assertEqual((history()["episode"], history()["seconds"], history()["kind"]), ("第2集", None, "opened"))
        detail = self.client.get(catalogue).json
        self.assertEqual(detail["progress"]["seconds"], 42)
        self.assertEqual(detail["lastOpened"]["label"], "第2集")
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("UPDATE episode_progress SET seconds=0")
            conn.execute("UPDATE watch_history SET url=?", (HISTORY_MARKER,))
        self.assertEqual((history()["kind"], history()["seconds"]), ("opened", None))
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("DELETE FROM episode_lines WHERE work_id=? AND source='youtube'", (self.key,))
        self.assertNotIn("episode", history())

    def test_summary_refreshes_and_counts_distinct_complete_episodes(self):
        self.assertEqual(episode_summary({"第1集上","第1集下","第2集","全季合集"}),
                         {"episodes":2, "collections":1, "sequential":True})
        self.assertNotIn("sequential", episode_summary({"第1集上","第2集"}))
        self.assertNotIn("sequential", episode_summary({"第1集","第3集"}))
        index = lambda: self.client.get("/api/playback-summary").json
        self.assertEqual(index()["works"][self.key], {"episodes":26, "sequential":True, "youtubeOnly":True})
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("DELETE FROM episode_lines WHERE work_id=?", (self.key,))
        self.assertNotIn(self.key, index()["works"])
        self.assertIn(self.key, index()["platforms"])
