'use strict';
const express = require('express');
const fs = require('fs');
const { effectiveLicense } = require('../permissions');

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
<rect width="100%" height="100%" fill="#1e293b"/>
<text x="50%" y="50%" fill="#64748b" font-size="28" text-anchor="middle" font-family="sans-serif">图片暂不可用</text>
</svg>`;

/**
 * 媒体服务：URL 携带内容版本 /media/:id/:variant/vN/...。
 * 每次请求都重新校验授权与版本：
 *  - 已撤下/未授权 → 410（变体）或 403（原图），旧链接无法复活；
 *  - 版本过期 → 404（缓存键已轮换）；
 *  - 公开变体 → immutable 长缓存；原图 → private no-store。
 */
module.exports = function mediaRoutes(db, cfg, queue) {
  const r = express.Router();

  r.get('/:photoId/:variant/v:version/:filename', async (req, res, next) => {
    try {
      const { photoId, variant, version } = req.params;
      const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId);
      if (!photo) return res.status(404).json({ error: 'not-found' });
      const lic = effectiveLicense(db, photoId);
      const delisted = photo.status !== 'active';

      if (variant === 'original') {
        // 原图下载：服务端强制鉴权，绝不只是隐藏按钮
        if (delisted || !lic.original) {
          res.set('Cache-Control', 'no-store');
          return res.status(403).json({ error: 'forbidden', reason: delisted ? 'delisted' : 'no-original-license' });
        }
        res.set('Cache-Control', 'private, no-store');
        res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(photo.original_name || 'original')}`);
        return res.sendFile(photo.original_path);
      }

      if (!cfg.variants[variant]) return res.status(404).json({ error: 'unknown-variant' });

      if (delisted || !lic.web) {
        // 已撤下或授权被撤销：任何版本（含旧版本）一律 410
        res.set('Cache-Control', 'no-store');
        return res.status(410).json({ error: 'gone', reason: delisted ? 'delisted' : 'license-revoked' });
      }
      if (Number(version) !== photo.media_version) {
        // 过期版本链接：缓存键已轮换，不可重新取得
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'stale-version' });
      }

      let row = db.prepare('SELECT * FROM variants WHERE photo_id=? AND name=?').get(photoId, variant);
      if ((!row || row.status !== 'ready' || !fs.existsSync(row.path || '')) ) {
        // 按需生成回退（受限流与像素预算约束）
        try { row = await queue.generateOnDemand(photoId, variant); }
        catch (e) {
          res.set('Cache-Control', 'no-store');
          return res.status(e.code === 'RATE_LIMITED' ? 429 : 404)
            .type('image/svg+xml').send(PLACEHOLDER_SVG);
        }
      }
      if (!row || row.status !== 'ready' || !fs.existsSync(row.path || '')) {
        res.set('Cache-Control', 'no-store');
        return res.status(404).type('image/svg+xml').send(PLACEHOLDER_SVG);
      }
      res.set('Cache-Control', `public, max-age=${cfg.cache.variantMaxAge}, immutable`);
      res.sendFile(row.path);
    } catch (e) { next(e); }
  });

  return r;
};
