'use strict';
const path = require('path');
const express = require('express');
const { openDb } = require('./db');
const { VariantQueue } = require('./variants');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const mediaRoutes = require('./routes/media');

const SITE_ROOT = path.join(__dirname, '..', '..');

function createApp(overrides = {}) {
  const base = require('./config');
  const cfg = { ...base, ...overrides };
  cfg.queue = { ...base.queue, ...(overrides.queue || {}) };
  cfg.onDemand = { ...base.onDemand, ...(overrides.onDemand || {}) };
  cfg.cache = { ...base.cache, ...(overrides.cache || {}) };
  const db = openDb(cfg.dataDir);
  const queue = new VariantQueue(db, cfg);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.locals.db = db; app.locals.cfg = cfg; app.locals.queue = queue;

  // 只暴露白名单静态目录与根级 HTML，server/ 与数据目录绝不可达
  const assetHeaders = (res) => res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  for (const dir of ['css', 'js', 'images']) {
    app.use('/' + dir, express.static(path.join(SITE_ROOT, dir), { index: false, setHeaders: assetHeaders }));
  }
  app.get(/^\/([a-z0-9-]+\.html)?$/, (req, res, next) => {
    const file = req.params[0];
    if (!file) return res.redirect('/gallery.html');
    res.setHeader('Cache-Control', 'no-cache'); // 页面带 ETag 协商缓存，始终可重新验证
    res.sendFile(path.join(SITE_ROOT, file), (err) => err && next());
  });

  app.use('/api/public', publicRoutes(db, cfg));
  app.use('/api/admin', adminRoutes(db, cfg, queue));
  app.use('/media', mediaRoutes(db, cfg, queue));

  app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file-too-large' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad-json' });
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });

  return { app, db, queue, cfg };
}

module.exports = { createApp };
