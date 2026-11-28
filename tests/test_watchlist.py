import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from server.app import COOKIE, create_app, digest


class PrivateWatchlistTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / 'accounts.sqlite3'
        self.app = create_app(dict(TESTING=True, AUTH_SECRET='x'*48, DATABASE=str(self.path),
                                   PUBLIC_ORIGIN='https://example.test'))
        self.client = self.app.test_client()
        self.second_device = self.app.test_client()
        self.other = self.app.test_client()
        self.guest = self.app.test_client()
        with closing(sqlite3.connect(self.path)) as db, db:
            for i in (1, 2):
                db.execute('INSERT INTO accounts VALUES (?,?,?,?,?)',
                           (i, f'user{i}', f'user{i}', f'{i}@example.test', 'unused'))
            for session, user in [('phone', 1), ('tablet', 1), ('other', 2)]:
                db.execute('INSERT INTO sessions VALUES (?,?,?)', (digest(session), user, 9999999999))
        for client, cookie in [(self.client, 'phone'), (self.second_device, 'tablet'), (self.other, 'other')]:
            client.set_cookie(COOKIE, cookie)

    def set_wanted(self, work, wanted, client=None, account_id=1):
        return (client or self.client).post('/api/watchlist',
            json=dict(accountId=account_id, id=work, wanted=wanted), headers={'Origin':'https://example.test'})

    def test_private_unlimited_by_showcase_and_idempotent(self):
        keys = [f'yellowstone-s{i}' for i in range(1, 6)]
        for key in keys:
            self.assertEqual(self.set_wanted(key, True).status_code, 200)
        self.assertEqual(self.set_wanted(keys[0], True).status_code, 200)
        self.assertEqual(self.second_device.get('/api/watchlist').json['workIds'], list(reversed(keys)))
        self.assertTrue(self.second_device.get('/api/watchlist?id='+keys[0]).json['wanted'])
        self.assertEqual(self.other.get('/api/watchlist').json['workIds'], [])
        self.assertFalse(self.other.get('/api/watchlist?id='+keys[0]).json['wanted'])
        profile = self.guest.get('/api/members/id/1').json
        self.assertEqual((profile['favoriteIds'], profile['workIds']), ([], []))
        self.assertNotIn(keys[0], str(profile))
        for unused in range(2):
            self.assertFalse(self.set_wanted(keys[0], False, self.second_device).json['wanted'])
        self.assertFalse(self.client.get('/api/watchlist?id='+keys[0]).json['wanted'])

    def test_only_published_works_and_authenticated_owner(self):
        key = 'entry-' + 'a'*32
        self.assertEqual(self.guest.get('/api/watchlist').status_code, 401)
        self.assertEqual(self.set_wanted(key, True, self.guest).status_code, 401)
        self.assertEqual(self.set_wanted(key, True, self.other).status_code, 403)
        self.assertEqual(self.set_wanted(key, 1).status_code, 400)
        self.assertEqual(self.set_wanted(key, True).status_code, 404)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("INSERT INTO contributions VALUES (?,1,NULL,'{}','pending','',1,0)", (key,))
        self.assertEqual(self.set_wanted(key, True).status_code, 404)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE contributions SET live='{}',status='approved' WHERE id=?", (key,))
        self.assertEqual(self.set_wanted(key, True).status_code, 200)
        self.assertEqual(self.client.get('/api/watchlist').json['workIds'], [key])
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('DELETE FROM contributions WHERE id=?', (key,))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM private_watchlist').fetchone()[0], 0)
        self.assertEqual(self.client.get('/api/watchlist').json['workIds'], [])
