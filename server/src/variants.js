'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { now } = require('./db');

/**
 * 变体生成队列。
 * 设计权衡（详见 DESIGN.md）：默认「上传时预生成」，首访延迟可预测；
 * 「按需生成」仅作为缺失回退，并受并发 + 像素预算 + 每分钟限流约束。
 */
class VariantQueue {
  constructor(db, cfg) {
    this.db = db;
    this.cfg = cfg;
    this.running = 0;
    this.pending = [];
    this.waiters = [];
    this.inflight = new Map(); // photoId:name -> Promise（按需生成去重锁）
    this.minuteWindow = { ts: 0, count: 0 }; // 按需生成限流
  }

  enqueue(photoId) {
    this.pending.push(photoId);
    this._pump();
  }

  /** 测试用：等待队列清空 */
  idle() {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise(res => this.waiters.push(res));
  }

  _pump() {
    while (this.running < this.cfg.queue.concurrency && this.pending.length) {
      const photoId = this.pending.shift();
      this.running++;
      this._generateAll(photoId)
        .catch(() => {})
        .finally(() => {
          this.running--;
          this._pump();
          if (this.running === 0 && this.pending.length === 0) {
            this.waiters.splice(0).forEach(r => r());
          }
        });
    }
  }

  _pixelCheck(meta) {
    const px = (meta.width || 0) * (meta.height || 0);
    if (px > this.cfg.queue.maxInputPixels) {
      const err = new Error(`pixel-budget-exceeded: ${px} > ${this.cfg.queue.maxInputPixels}`);
      err.code = 'PIXEL_BUDGET';
      throw err;
    }
  }

  async _generateAll(photoId) {
    const photo = this.db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId);
    if (!photo) return;
    const meta = await sharp(photo.original_path, { limitInputPixels: false }).metadata();
    for (const name of Object.keys(this.cfg.variants)) {
      await this._generateOne(photo, name, meta);
    }
  }

  async _generateOne(photo, name, meta) {
    const spec = this.cfg.variants[name];
    const upd = this.db.prepare(
      `UPDATE variants SET status=?, error=?, width=?, height=?, path=?, version=?, updated_at=?
       WHERE photo_id=? AND name=?`);
    try {
      this._pixelCheck(meta); // 像素预算：超限直接失败回退
      const outDir = path.join(this.cfg.dataDir, 'variants', photo.id);
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `${name}-v${photo.media_version}.jpg`);
      let img = sharp(photo.original_path, { limitInputPixels: false })
        .rotate() // 依据 EXIF 方向归正；输出默认剥离全部 EXIF（含 GPS）
        .resize({
          width: spec.width, height: spec.height || undefined,
          fit: spec.fit, withoutEnlargement: true,
        })
        .jpeg({ quality: spec.quality, mozjpeg: true });
      const info = await img.toFile(outPath);
      upd.run('ready', null, info.width, info.height, outPath, photo.media_version, now(), photo.id, name);
    } catch (e) {
      // 失败回退：标记 failed，公开端回退到占位图 / 更小变体
      upd.run('failed', String(e.message || e), null, null, null, photo.media_version, now(), photo.id, name);
    }
  }

  /** 按需生成回退：去重 + 每分钟限流 + 同样的像素预算 */
  async generateOnDemand(photoId, name) {
    if (!this.cfg.onDemand.enabled) return null;
    const w = this.minuteWindow, t = Date.now();
    if (t - w.ts > 60_000) { w.ts = t; w.count = 0; }
    if (++w.count > this.cfg.onDemand.maxPerMinute) {
      const e = new Error('on-demand-rate-limited'); e.code = 'RATE_LIMITED'; throw e;
    }
    const key = `${photoId}:${name}`;
    if (!this.inflight.has(key)) {
      const photo = this.db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId);
      if (!photo) return null;
      const p = (async () => {
        const meta = await sharp(photo.original_path, { limitInputPixels: false }).metadata();
        await this._generateOne(photo, name, meta);
      })().finally(() => setTimeout(() => this.inflight.delete(key), 1000));
      this.inflight.set(key, p);
    }
    await this.inflight.get(key);
    return this.db.prepare('SELECT * FROM variants WHERE photo_id=? AND name=?').get(photoId, name);
  }
}

module.exports = { VariantQueue };
