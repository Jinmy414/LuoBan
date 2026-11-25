import gzip
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import date
from pathlib import Path

from server.app import COOKIE, create_app, digest
from server.traffic import AccessLogs


def hit(time, path="/", ip="192.0.2.1", status=200, size=100):
    return f'{ip} - - [{time} +0000] "GET {path} HTTP/1.1" {status} {size} "-" "test"\n'.encode()


class TrafficTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.log = Path(temp.name) / "site.access.log"
        self.db = Path(temp.name) / "test.sqlite"
        self.app = create_app(dict(TESTING=True, DATABASE=str(self.db), SUPER_ADMIN_ID=1,
                                   PUBLIC_ORIGIN="http://localhost:8000", AUTH_SECRET="test"*12,
                                   TRAFFIC_ACCESS_LOG=str(self.log)))
        self.client = self.app.test_client()
        with closing(sqlite3.connect(self.db)) as conn, conn:
            for n in range(1, 4):
                conn.execute("INSERT INTO accounts VALUES (?,?,?,?,?)", (n, f"user{n}", f"user{n}", f"{n}@example.test", "unused"))
                conn.execute("INSERT INTO sessions VALUES (?,?,?)", (digest(str(n)), n, 9999999999))
            conn.execute("INSERT INTO editors(user_id) VALUES (2)")

    def test_roles_and_revocation(self):
        self.log.write_bytes(hit("24/Nov/2020:09:15:00"))
        url = "/admin/traffic?date=2020-11-24"
        self.assertEqual(self.client.get(url).status_code, 401)
        for n, code in [(1, 200), (2, 200), (3, 403)]:
            self.client.set_cookie(COOKIE, str(n))
            response = self.client.get(url)
            self.assertEqual(response.status_code, code)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual("首页来源 IP" in response.get_data(as_text=True), code == 200)
            self.assertNotIn(b"192.0.2.1", response.data)
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("DELETE FROM editors WHERE user_id=2")
        self.client.set_cookie(COOKIE, "2")
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_rotation_append_timezone_and_deduplication(self):
        archive = self.log.with_suffix(".log.2.gz")
        archive.write_bytes(gzip.compress(hit("23/Nov/2020:15:59:00") + hit("23/Nov/2020:16:01:00")))
        old = hit("24/Nov/2020:09:15:00", "/?q=test", status=304, size=0)
        self.log.write_bytes(old + hit("24/Nov/2020:09:15:01", "/assets/a.jpg", size=500))
        logs = AccessLogs(self.log)
        day = date(2020, 11, 24)

        def counts():
            hours, oldest, skipped = logs.report(day, day)
            self.assertEqual(oldest.day, 23)
            self.assertEqual(skipped, 0)
            return (sum(c.hits for c in hours.values()), sum(c.home for c in hours.values()),
                    sum(c.size for c in hours.values()), len(set().union(*(c.home_ips for c in hours.values()))))
        self.assertEqual(counts(), (3, 2, 600, 1))
        with self.log.open("ab") as stream:
            stream.write(hit("24/Nov/2020:10:00:00", "/index.html", "192.0.2.2")[:-1])
        self.assertEqual(counts(), (3, 2, 600, 1))
        with self.log.open("ab") as stream:
            stream.write(b"\n")
        self.assertEqual(counts(), (4, 3, 700, 2))
        os.rename(self.log, str(self.log) + ".1")
        self.log.write_bytes(hit("24/Nov/2020:10:05:00", "/missing", status=404, size=25))
        self.assertEqual(counts(), (5, 3, 725, 2))
        self.assertEqual(counts(), (5, 3, 725, 2))

    def test_missing_invalid_and_uncovered_dates(self):
        self.client.set_cookie(COOKIE, "1")
        self.assertEqual(self.client.get("/admin/traffic").status_code, 503)
        self.assertEqual(self.client.get("/admin/traffic?date=no").status_code, 400)
        self.log.write_bytes(hit("24/Nov/2020:08:10:00"))
        day = self.client.get("/admin/traffic?date=2020-11-24").get_data(as_text=True)
        self.assertIn('scope="row">16:00', day)
        self.assertNotIn('scope="row">15:00', day)
        old = self.client.get("/admin/traffic?date=2020-11-23").get_data(as_text=True)
        self.assertIn("所选时段没有可用的访问日志", old)
        self.assertEqual(self.client.get("/admin/traffic?period=week").status_code, 200)
