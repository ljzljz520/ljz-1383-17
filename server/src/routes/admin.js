'use strict';
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { now, newId } = require('../db');
const { extractExif } = require('../exif');
const { effectiveLicense } = require('../permissions');

module.exports = function adminRoutes(db, cfg, queue) {
  const r = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cfg.queue.maxInputBytes, files: 1 },
  });

  // 简单 Bearer 鉴权（个人站单管理员）
  r.use((req, res, next) => {
    if ((req.headers.authorization || '') !== `Bearer ${cfg.adminToken}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  const fullPhoto = (id) => {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    if (!p) return null;
    return {
      ...p,
      exif_public: JSON.parse(p.exif_public), exif_private: JSON.parse(p.exif_private),
      categories: db.prepare(`SELECT c.slug FROM categories c JOIN photo_categories pc ON pc.category_id=c.id WHERE pc.photo_id=?`).all(id).map(x => x.slug),
      licenses: db.prepare('SELECT * FROM licenses WHERE photo_id=? ORDER BY created_at').all(id),
      variants: db.prepare('SELECT name, version, status, error, width, height FROM variants WHERE photo_id=?').all(id),
      effective: effectiveLicense(db, id),
    };
  };

  /**
   * 上传原图。要点：
   *  - Idempotency-Key：网络中断重试不产生重复记录；
   *  - content_hash 去重：同图不同授权 → 挂到同一作品新增授权记录；
   *  - 事务写入 + 异步入队生成变体。
   */
  r.post('/photos', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file-required' });
      const idem = req.get('Idempotency-Key') || null;
      if (idem) {
        const hit = db.prepare('SELECT photo_id FROM idempotency WHERE key = ?').get(idem);
        if (hit) return res.status(200).json({ photo: fullPhoto(hit.photo_id), idempotentReplay: true });
      }
      const meta = JSON.parse(req.body.meta || '{}');
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const existing = db.prepare('SELECT id FROM photos WHERE content_hash = ?').get(hash);

      if (existing) {
        // 同图再传：不新建作品，仅追加授权（若有）
        if (meta.license) {
          db.prepare(`INSERT INTO licenses (id, photo_id, label, allow_web, allow_original, status, created_at)
                      VALUES (?,?,?,?,?,'active',?)`)
            .run(newId('lic'), existing.id, String(meta.license.label || '未命名授权'),
              meta.license.allowWeb ? 1 : 0, meta.license.allowOriginal ? 1 : 0, now());
        }
        if (idem) db.prepare('INSERT OR IGNORE INTO idempotency (key, photo_id, created_at) VALUES (?,?,?)').run(idem, existing.id, now());
        return res.status(200).json({ photo: fullPhoto(existing.id), deduped: true });
      }

      const id = newId('ph');
      const ext = (req.file.originalname.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase();
      const origPath = path.join(cfg.dataDir, 'originals', id + ext);
      fs.writeFileSync(origPath, req.file.buffer);

      let dims = { width: null, height: null };
      try { const m = await sharp(req.file.buffer, { limitInputPixels: false }).metadata(); dims = { width: m.width, height: m.height }; }
      catch { /* 无法解析的图也收下，变体阶段会标记 failed */ }
      const exif = await extractExif(req.file.buffer);
      const ts = now();
      const sortKey = -Math.floor(Date.now() / 1000); // 默认新作品在前

      db.transaction(() => {
        db.prepare(`INSERT INTO photos (id, content_hash, title, caption, has_people, status, media_version,
                    sort_key, width, height, original_path, original_name, mime, bytes,
                    exif_public, exif_private, created_at, updated_at)
                    VALUES (?,?,?,?,?,'active',1,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, hash, String(meta.title || ''), String(meta.caption || ''), meta.hasPeople ? 1 : 0,
            sortKey, dims.width, dims.height, origPath, req.file.originalname || ('original' + ext),
            req.file.mimetype, req.file.size,
            JSON.stringify(exif.public), JSON.stringify(exif.private), ts, ts);
        for (const slug of meta.categories || []) {
          const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
          if (cat) db.prepare('INSERT OR IGNORE INTO photo_categories (photo_id, category_id) VALUES (?,?)').run(id, cat.id);
        }
        if (meta.license) {
          db.prepare(`INSERT INTO licenses (id, photo_id, label, allow_web, allow_original, status, created_at)
                      VALUES (?,?,?,?,?,'active',?)`)
            .run(newId('lic'), id, String(meta.license.label || '未命名授权'),
              meta.license.allowWeb ? 1 : 0, meta.license.allowOriginal ? 1 : 0, ts);
        }
        for (const name of Object.keys(cfg.variants)) {
          db.prepare(`INSERT INTO variants (photo_id, name, version, status, updated_at) VALUES (?,?,1,'pending',?)`).run(id, name, ts);
        }
        if (idem) db.prepare('INSERT OR IGNORE INTO idempotency (key, photo_id, created_at) VALUES (?,?,?)').run(idem, id, ts);
      })();
      queue.enqueue(id);
      res.status(201).json({ photo: fullPhoto(id) });
    } catch (e) { next(e); }
  });

  r.get('/photos', (req, res) => {
    const rows = db.prepare('SELECT id FROM photos ORDER BY sort_key, id').all();
    res.json({ items: rows.map(x => fullPhoto(x.id)) });
  });

  r.patch('/photos/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM photos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not-found' });
    const b = req.body || {};
    db.transaction(() => {
      if (b.title !== undefined || b.caption !== undefined || b.hasPeople !== undefined) {
        db.prepare('UPDATE photos SET title=?, caption=?, has_people=?, updated_at=? WHERE id=?')
          .run(b.title !== undefined ? String(b.title) : p.title,
            b.caption !== undefined ? String(b.caption) : p.caption,
            b.hasPeople !== undefined ? (b.hasPeople ? 1 : 0) : p.has_people, now(), p.id);
      }
      if (Array.isArray(b.categories)) {
        db.prepare('DELETE FROM photo_categories WHERE photo_id=?').run(p.id);
        for (const slug of b.categories) {
          const cat = db.prepare('SELECT id FROM categories WHERE slug=?').get(slug);
          if (cat) db.prepare('INSERT OR IGNORE INTO photo_categories (photo_id, category_id) VALUES (?,?)').run(p.id, cat.id);
        }
      }
      if (b.status !== undefined && ['active', 'delisted'].includes(b.status)) {
        db.prepare('UPDATE photos SET status=?, updated_at=? WHERE id=?').run(b.status, now(), p.id);
      }
    })();
    res.json({ photo: fullPhoto(p.id) });
  });

  /** 重新处理：media_version +1 → 旧变体 URL 全部失效，重新入队生成 */
  r.post('/photos/:id/reprocess', (req, res) => {
    const p = db.prepare('SELECT * FROM photos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not-found' });
    db.transaction(() => {
      db.prepare('UPDATE photos SET media_version = media_version + 1, updated_at=? WHERE id=?').run(now(), p.id);
      db.prepare(`UPDATE variants SET status='pending', error=NULL, version=version+1, updated_at=? WHERE photo_id=?`).run(now(), p.id);
    })();
    queue.enqueue(p.id);
    res.json({ photo: fullPhoto(p.id) });
  });

  // ---- 授权管理 ----
  r.post('/photos/:id/licenses', (req, res) => {
    const p = db.prepare('SELECT id FROM photos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not-found' });
    const b = req.body || {};
    const id = newId('lic');
    db.prepare(`INSERT INTO licenses (id, photo_id, label, allow_web, allow_original, status, created_at)
                VALUES (?,?,?,?,?,'active',?)`)
      .run(id, p.id, String(b.label || '未命名授权'), b.allowWeb ? 1 : 0, b.allowOriginal ? 1 : 0, now());
    res.status(201).json({ photo: fullPhoto(p.id) });
  });

  r.post('/licenses/:id/revoke', (req, res) => {
    const lic = db.prepare('SELECT * FROM licenses WHERE id=?').get(req.params.id);
    if (!lic) return res.status(404).json({ error: 'not-found' });
    db.prepare(`UPDATE licenses SET status='revoked', revoked_at=? WHERE id=?`).run(now(), lic.id);
    res.json({ photo: fullPhoto(lic.photo_id) });
  });

  // ---- 分类管理 ----
  r.get('/categories', (req, res) => {
    res.json({ items: db.prepare('SELECT * FROM categories ORDER BY position, name').all() });
  });
  r.post('/categories', (req, res) => {
    const b = req.body || {};
    if (!b.slug || !b.name) return res.status(400).json({ error: 'slug-name-required' });
    const id = newId('cat');
    db.prepare('INSERT INTO categories (id, name, slug, position) VALUES (?,?,?,?)')
      .run(id, String(b.name), String(b.slug), Number(b.position) || 0);
    res.status(201).json({ id, slug: b.slug, name: b.name });
  });

  // ---- 排序版本：保存命名排序，激活后原子生效，信息流携带版本号 ----
  r.get('/sort-versions', (req, res) => {
    const versions = db.prepare('SELECT * FROM sort_versions ORDER BY created_at DESC').all();
    const items = db.prepare('SELECT * FROM sort_items ORDER BY position').all();
    res.json({
      items: versions.map(v => ({ ...v, order: items.filter(i => i.version_id === v.id).map(i => i.photo_id) })),
    });
  });
  r.post('/sort-versions', (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.order) || !b.order.length) return res.status(400).json({ error: 'order-required' });
    const id = newId('sv');
    db.transaction(() => {
      db.prepare('INSERT INTO sort_versions (id, name, active, created_at) VALUES (?,?,0,?)')
        .run(id, String(b.name || '未命名排序'), now());
      const ins = db.prepare('INSERT INTO sort_items (version_id, photo_id, position) VALUES (?,?,?)');
      b.order.forEach((pid, i) => ins.run(id, pid, i));
    })();
    res.status(201).json({ id });
  });
  r.post('/sort-versions/:id/activate', (req, res) => {
    const v = db.prepare('SELECT * FROM sort_versions WHERE id=?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'not-found' });
    db.transaction(() => {
      db.prepare('UPDATE sort_versions SET active = 0').run();
      db.prepare('UPDATE sort_versions SET active = 1 WHERE id=?').run(v.id);
      const items = db.prepare('SELECT * FROM sort_items WHERE version_id=? ORDER BY position').all(v.id);
      const upd = db.prepare('UPDATE photos SET sort_key=?, updated_at=? WHERE id=?');
      items.forEach((it, i) => upd.run(i, now(), it.photo_id));
    })();
    res.json({ ok: true, active: v.id });
  });

  return r;
};
