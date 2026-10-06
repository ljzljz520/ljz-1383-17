'use strict';
const express = require('express');
const { effectiveLicense, isPubliclyVisible } = require('../permissions');

const b64u = (s) => Buffer.from(s).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString();

function variantUrls(photo, variantRows) {
  const out = {};
  for (const v of variantRows) {
    if (v.status !== 'ready') continue; // 失败变体不下发，前端回退占位图
    out[v.name] = {
      url: `/media/${photo.id}/${v.name}/v${v.version}/image.jpg`,
      width: v.width, height: v.height,
    };
  }
  return out;
}

function publicPhoto(db, photo, cfg) {
  const cats = db.prepare(
    `SELECT c.slug, c.name FROM categories c
     JOIN photo_categories pc ON pc.category_id = c.id WHERE pc.photo_id = ?`).all(photo.id);
  const lic = effectiveLicense(db, photo.id);
  const variants = variantUrls(photo,
    db.prepare('SELECT * FROM variants WHERE photo_id = ?').all(photo.id));
  const exif = JSON.parse(photo.exif_public || '{}'); // 仅白名单字段，绝无 GPS
  const body = {
    id: photo.id,
    title: photo.title,
    caption: photo.caption,
    hasPeople: !!photo.has_people,
    categories: cats,
    exif,
    variants,
    sortKey: photo.sort_key,
    updatedAt: photo.updated_at,
  };
  if (lic.original) {
    body.original = { url: `/media/${photo.id}/original/v${photo.media_version}/${encodeURIComponent(photo.original_name || 'original')}` };
  }
  return body;
}

module.exports = function publicRoutes(db, cfg) {
  const r = express.Router();

  const activeSortVersion = () =>
    (db.prepare('SELECT id FROM sort_versions WHERE active = 1').get() || {}).id || 'default';

  /** 信息流：keyset 分页（sort_key, id），翻页期间新增/下架不会导致重复或回跳 */
  r.get('/feed', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 12, 50);
    const category = req.query.category || null;
    let cursor = null;
    if (req.query.cursor) {
      try { cursor = JSON.parse(unb64u(String(req.query.cursor))); }
      catch { return res.status(400).json({ error: 'bad-cursor' }); }
    }
    const where = [`p.status = 'active'`,
      `EXISTS (SELECT 1 FROM licenses l WHERE l.photo_id = p.id AND l.status='active' AND l.allow_web=1)`];
    const args = [];
    if (category) {
      where.push(`EXISTS (SELECT 1 FROM photo_categories pc JOIN categories c ON c.id = pc.category_id
                  WHERE pc.photo_id = p.id AND c.slug = ?)`);
      args.push(category);
    }
    if (cursor) {
      where.push(`(p.sort_key > ? OR (p.sort_key = ? AND p.id > ?))`);
      args.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = db.prepare(
      `SELECT p.* FROM photos p WHERE ${where.join(' AND ')}
       ORDER BY p.sort_key ASC, p.id ASC LIMIT ?`).all(...args, limit + 1);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    res.json({
      items: items.map(p => publicPhoto(db, p, cfg)),
      nextCursor: rows.length > limit && last ? b64u(JSON.stringify([last.sort_key, last.id])) : null,
      sortVersion: activeSortVersion(),
    });
  });

  r.get('/categories', (req, res) => {
    res.json({ items: db.prepare('SELECT slug, name FROM categories ORDER BY position, name').all() });
  });

  r.get('/photos/:id', (req, res) => {
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (!isPubliclyVisible(db, photo)) return res.status(404).json({ error: 'not-found' });
    res.json(publicPhoto(db, photo, cfg));
  });

  /** 灯箱序列快照的墓碑校验：批量确认作品当前是否仍公开 */
  r.post('/photos/status', (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 200) : [];
    const out = {};
    const stmt = db.prepare('SELECT * FROM photos WHERE id = ?');
    for (const id of ids) out[id] = isPubliclyVisible(db, stmt.get(id)) ? 'public' : 'gone';
    res.json({ status: out, sortVersion: activeSortVersion() });
  });

  return r;
};
