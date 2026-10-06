"""SQLite data layer: categories, licenses, photos, variants, sequence
snapshots and the global ordering version (seq_version)."""
import json
import os
import sqlite3
import threading
import time
import uuid

SCHEMA = """
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS licenses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  allow_download INTEGER NOT NULL DEFAULT 0,
  allow_public_view INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS photos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL,          -- same bytes may exist under several licenses
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id),
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  status TEXT NOT NULL DEFAULT 'active',       -- active | delisted
  position INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  exif_json TEXT NOT NULL DEFAULT '{}',        -- PRIVATE (may contain GPS)
  created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS variants(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id INTEGER NOT NULL REFERENCES photos(id),
  kind TEXT NOT NULL,                          -- thumb | medium | large | original
  version INTEGER NOT NULL,                    -- URL carries this; bump => new URL
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- pending|ready|failed|revoked
  UNIQUE(photo_id, kind, version));
CREATE TABLE IF NOT EXISTS sequences(          -- lightbox cursor snapshots
  id TEXT PRIMARY KEY,
  filter_json TEXT NOT NULL,
  ids_json TEXT NOT NULL,
  seq_version INTEGER NOT NULL,
  created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


class DB:
    def __init__(self, path):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        with self._lock, self.conn:
            self.conn.executescript(SCHEMA)
            self.conn.execute(
                "INSERT OR IGNORE INTO meta(k,v) VALUES('seq_version','1')")

    # ------------------------------------------------------------- helpers
    def _q(self, sql, args=()):
        with self._lock:
            return self.conn.execute(sql, args).fetchall()

    def _one(self, sql, args=()):
        rows = self._q(sql, args)
        return rows[0] if rows else None

    def _x(self, sql, args=()):
        with self._lock, self.conn:
            cur = self.conn.execute(sql, args)
            return cur.lastrowid

    # ------------------------------------------------------- global version
    def seq_version(self):
        return int(self._one("SELECT v FROM meta WHERE k='seq_version'")["v"])

    def bump_seq_version(self):
        with self._lock, self.conn:
            self.conn.execute(
                "UPDATE meta SET v=CAST(v AS INTEGER)+1 WHERE k='seq_version'")
        return self.seq_version()

    # ------------------------------------------------------------ taxonomy
    def add_category(self, name, position=0):
        return self._x(
            "INSERT OR IGNORE INTO categories(name,position) VALUES(?,?)",
            (name, position))

    def add_license(self, name, allow_download=0, allow_public_view=1):
        return self._x(
            "INSERT OR IGNORE INTO licenses(name,allow_download,allow_public_view)"
            " VALUES(?,?,?)", (name, allow_download, allow_public_view))

    def list_categories(self):
        return [dict(r) for r in self._q(
            "SELECT * FROM categories ORDER BY position,id")]

    def list_licenses(self, include_revoked=False):
        sql = "SELECT * FROM licenses"
        if not include_revoked:
            sql += " WHERE revoked=0"
        return [dict(r) for r in self._q(sql + " ORDER BY id")]

    def get_license(self, lic_id):
        r = self._one("SELECT * FROM licenses WHERE id=?", (lic_id,))
        return dict(r) if r else None

    def revoke_license(self, lic_id):
        """Revoking a license immediately affects every photo using it."""
        self._x("UPDATE licenses SET revoked=1 WHERE id=?", (lic_id,))
        self.bump_seq_version()

    # --------------------------------------------------------------- photos
    def create_photo(self, content_hash, title, description, category_id,
                     license_id, width, height, exif):
        pid = self._x(
            "INSERT INTO photos(content_hash,title,description,category_id,"
            "license_id,position,width,height,exif_json,created_at)"
            " VALUES(?,?,?,?,?,"
            " COALESCE((SELECT MAX(position)+1 FROM photos),0),?,?,?,?)",
            (content_hash, title, description, category_id, license_id,
             width, height, json.dumps(exif), time.time()))
        self.bump_seq_version()
        return pid

    def get_photo(self, pid):
        r = self._one("SELECT * FROM photos WHERE id=?", (pid,))
        return dict(r) if r else None

    def update_photo(self, pid, fields):
        cols = [f"{k}=?" for k in fields]
        self._x(f"UPDATE photos SET {','.join(cols)} WHERE id=?",
                (*fields.values(), pid))
        self.bump_seq_version()

    def set_status(self, pid, status):
        self._x("UPDATE photos SET status=? WHERE id=?", (status, pid))
        self.bump_seq_version()

    def reorder(self, ids):
        with self._lock, self.conn:
            for pos, pid in enumerate(ids):
                self.conn.execute(
                    "UPDATE photos SET position=? WHERE id=?", (pos, pid))
        self.bump_seq_version()

    def search_photos(self, category=None, license_id=None,
                      include_delisted=False, page=1, size=20):
        where, args = [], []
        if not include_delisted:
            where.append("p.status='active'")
            where.append("l.revoked=0")
            where.append("l.allow_public_view=1")
        if category:
            where.append("p.category_id=?")
            args.append(category)
        if license_id:
            where.append("p.license_id=?")
            args.append(license_id)
        w = ("WHERE " + " AND ".join(where)) if where else ""
        base = (f"FROM photos p JOIN licenses l ON l.id=p.license_id {w}")
        total = self._one(f"SELECT COUNT(*) c {base}", args)["c"]
        rows = self._q(
            f"SELECT p.* {base} ORDER BY p.position, p.id"
            " LIMIT ? OFFSET ?", (*args, size, (page - 1) * size))
        return [dict(r) for r in rows], total

    # -------------------------------------------------------------- variants
    def add_variant(self, photo_id, kind, version, width=0, height=0,
                    path="", status="pending"):
        return self._x(
            "INSERT INTO variants(photo_id,kind,version,width,height,path,status)"
            " VALUES(?,?,?,?,?,?,?)",
            (photo_id, kind, version, width, height, path, status))

    def update_variant(self, vid, **fields):
        cols = [f"{k}=?" for k in fields]
        self._x(f"UPDATE variants SET {','.join(cols)} WHERE id=?",
                (*fields.values(), vid))

    def get_variant(self, photo_id, kind, version=None):
        if version is None:
            r = self._one(
                "SELECT * FROM variants WHERE photo_id=? AND kind=?"
                " ORDER BY version DESC LIMIT 1", (photo_id, kind))
        else:
            r = self._one(
                "SELECT * FROM variants WHERE photo_id=? AND kind=? AND version=?",
                (photo_id, kind, version))
        return dict(r) if r else None

    def revoke_variants(self, photo_id):
        """Delist/revoke: every existing variant URL must die (410)."""
        self._x("UPDATE variants SET status='revoked'"
                " WHERE photo_id=? AND kind != 'original'", (photo_id,))

    # ------------------------------------------------------------- sequences
    def save_sequence(self, filter_obj, ids):
        sid = uuid.uuid4().hex
        self._x(
            "INSERT INTO sequences(id,filter_json,ids_json,seq_version,created_at)"
            " VALUES(?,?,?,?,?)",
            (sid, json.dumps(filter_obj), json.dumps(ids),
             self.seq_version(), time.time()))
        return sid

    def get_sequence(self, sid):
        r = self._one("SELECT * FROM sequences WHERE id=?", (sid,))
        if not r:
            return None
        d = dict(r)
        d["ids"] = json.loads(d.pop("ids_json"))
        d["filter"] = json.loads(d.pop("filter_json"))
        return d
