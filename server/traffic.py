"""Private traffic reports from the site's current and rotated access logs."""
import gzip
import os
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit

from flask import render_template, request

BEIJING = timezone(timedelta(hours=8))
# Ignore referrers and user agents. Only the request path, status and body size are needed.
LINE = re.compile(rb'^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+|-) ')
ROTATED = re.compile(r'\.(?:\d+|\d{4}-\d{2}-\d{2})(?:\.gz)?$')


@lru_cache(maxsize=512)
def local_hour(stamp):
    # All requests in one log hour share the same conversion.
    return datetime.strptime(stamp.decode("ascii"), "%d/%b/%Y:%H %z").astimezone(BEIJING)


@dataclass
class Counts:
    hits: int = 0
    home: int = 0
    size: int = 0
    home_ips: set = field(default_factory=set)

    def merge(self, other):
        self.hits += other.hits
        self.home += other.home
        self.size += other.size
        self.home_ips.update(other.home_ips)


@dataclass
class FileTotals:
    hours: dict = field(default_factory=lambda: defaultdict(Counts))
    offset: int = 0
    signature: tuple = ()
    skipped: int = 0


def read_file(path, previous):
    compressed = path.suffix == ".gz"
    with (gzip.open(path, "rb") if compressed else path.open("rb")) as stream:
        stat = os.fstat(stream.fileno())
        identity = (stat.st_dev, stat.st_ino)
        signature = (*identity, stat.st_size, stat.st_mtime_ns)
        if previous and previous.signature == signature:
            return previous
        if (not compressed and previous and previous.signature[:2] == identity
                and stat.st_size > previous.signature[2]):
            result = previous
            stream.seek(result.offset)
        else:
            result = FileTotals()
        for line in stream:
            if not line.endswith(b"\n"):
                break  # Retry a partially written line on the next read.
            result.offset += len(line)
            match = LINE.match(line)
            if not match:
                result.skipped += 1
                continue
            ip, stamp, request_line, status, size = match.groups()
            try:
                clock, zone = stamp.split()
                hour = local_hour(clock.rsplit(b":", 2)[0] + b" " + zone)
            except (ValueError, UnicodeError):
                result.skipped += 1
                continue
            bucket = result.hours[hour]
            bucket.hits += 1
            if size != b"-":
                bucket.size += int(size)
            parts = request_line.split()
            if (len(parts) >= 2 and parts[0] == b"GET" and status in (b"200", b"304")
                    and parts[1].split(b"?", 1)[0] in (b"/", b"/index.html")):
                bucket.home += 1
                bucket.home_ips.add(hash(ip))
        result.signature = signature
        return result


class AccessLogs:
    def __init__(self, base):
        self.base = base
        self.files = {}
        self.lock = Lock()

    def report(self, start, end):
        hours = defaultdict(Counts)
        oldest = None
        skipped = 0
        with self.lock:
            paths = [self.base]
            paths.extend(path for path in self.base.parent.glob(self.base.name + ".*")
                         if ROTATED.fullmatch(path.name[len(self.base.name):]))
            files = {}
            for path in paths:
                try:
                    item = read_file(path, self.files.get(path))
                except FileNotFoundError:
                    continue
                files[path] = item
                skipped += item.skipped
                if item.hours:
                    first = min(item.hours)
                    oldest = min(oldest, first) if oldest else first
                for hour, counts in item.hours.items():
                    if start <= hour.date() <= end:
                        hours[hour].merge(counts)
            self.files = files
            if not files:
                raise FileNotFoundError
        return hours, oldest, skipped


def mount(app, active_user, admin):
    host = urlsplit(app.config["PUBLIC_ORIGIN"]).hostname
    base = Path(app.config.get("TRAFFIC_ACCESS_LOG") or f"/var/log/{host}.access.log")
    logs = AccessLogs(base)

    @app.get("/admin/traffic")
    def traffic_report():
        user = active_user()
        if not admin(user):
            return render_template("traffic.html", denied=True), 403 if user else 401
        now = datetime.now(BEIJING)
        today = now.date()
        week = request.args.get("period") == "week"
        try:
            end = date.fromisoformat(request.args.get("date", today.isoformat()))
            if end > today or (week and end != today):
                raise ValueError
        except ValueError:
            return render_template("traffic.html", error="请选择有效的日期，最晚可选今天。"), 400
        start = end - timedelta(days=6) if week else end
        context = dict(today=today, yesterday=today-timedelta(days=1), start=start, end=end,
                       week=week, checked=now.strftime("%H:%M"), denied=False)
        try:
            hours, oldest, skipped = logs.report(start, end)
        except (OSError, EOFError):
            return render_template("traffic.html", **context, error="暂时无法读取服务器访问日志，请稍后重试。"), 503
        totals = Counts()
        grouped = defaultdict(Counts)
        for hour, counts in hours.items():
            totals.merge(counts)
            grouped[hour.date() if week else hour.hour].merge(counts)
        keys = [start + timedelta(days=i) for i in range(7)] if week else range(24)
        rows = []
        for key in keys:
            at = datetime.combine(key if week else end, datetime.min.time(), BEIJING)
            if not week:
                at += timedelta(hours=key)
            until = at + (timedelta(days=1) if week else timedelta(hours=1))
            if at > now or not oldest or until <= oldest:
                counts = None
            else:
                counts = grouped[key]
            rows.append((at.strftime("%m-%d" if week else "%H:00"), counts))
        peak = max((counts.hits for _, counts in rows if counts), default=0)
        return render_template("traffic.html", **context, totals=totals, rows=rows, peak=max(1, peak),
                               oldest=oldest, skipped=skipped)
