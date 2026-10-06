'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos (
  id            TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  caption       TEXT NOT NULL DEFAULT '',
  has_people    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',      -- active | delisted
  media_version INTEGER NOT NULL DEFAULT 1,          -- 重新处理时 +1，使旧变体 URL 失效
  sort_key      REAL NOT NULL DEFAULT 0,
  width         INTEGER, height INTEGER,
  original_path TEXT NOT NULL,
  original_name TEXT,
  mime          TEXT,
  bytes         INTEGER,
  exif_public   TEXT NOT NULL DEFAULT '{}',          -- 已脱敏（无 GPS）
  exif_private  TEXT NOT NULL DEFAULT '{}',          -- 含 GPS，仅管理端可见
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(content_hash);
CREATE INDEX IF NOT EXISTS idx_photos_feed ON photos(status, sort_key, id);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS photo_categories (
  photo_id TEXT NOT NULL, category_id TEXT NOT NULL,
  PRIMARY KEY (photo_id, category_id)
);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY, photo_id TEXT NOT NULL,
  label TEXT NOT NULL,
  allow_web INTEGER NOT NULL DEFAULT 0,       -- 允许公开网页展示（变体）
  allow_original INTEGER NOT NULL DEFAULT 0,  -- 允许公开下载原图
  status TEXT NOT NULL DEFAULT 'active',      -- active | revoked
  created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_licenses_photo ON licenses(photo_id, status);

CREATE TABLE IF NOT EXISTS variants (
  photo_id TEXT NOT NULL, name TEXT NOT NULL,
  version INTEGER NOT NULL,                   -- 与 photos.media_version 对齐
  width INTEGER, height INTEGER, path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | ready | failed
  error TEXT, updated_at TEXT,
  PRIMARY KEY (photo_id, name)
);

CREATE TABLE IF NOT EXISTS sort_versions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sort_items (
  version_id TEXT NOT NULL, photo_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (version_id, photo_id)
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY, photo_id TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'originals'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'variants'), { recursive: true });
  const db = new Database(path.join(dataDir, 'photos.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const now = () => new Date().toISOString();
const newId = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

module.exports = { openDb, now, newId };
