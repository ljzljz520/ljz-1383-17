'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const piexif = require('piexifjs');
const { createApp } = require('../src/app');

const TOKEN = 'dev-admin-token';

async function start(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-'));
  const { app, db, queue, cfg } = createApp({ dataDir: dir, ...overrides });
  const server = await new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, db, queue, cfg, base, dir, close: () => { server.close(); db.close(); } };
}

function makeJpeg(w = 800, h = 600, color = { r: 90, g: 120, b: 200 }) {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
}

/** 构造含 GPS 的 JPEG（模拟人物外拍原图） */
function makeGpsJpeg() {
  return makeJpeg(1200, 800, { r: 200, g: 80, b: 80 }).then((buf) => {
    const exifObj = {
      '0th': { [piexif.ImageIFD.Make]: 'TestCam', [piexif.ImageIFD.Model]: 'TC-1' },
      Exif: {
        [piexif.ExifIFD.DateTimeOriginal]: '2024:05:01 10:30:00',
        [piexif.ExifIFD.ISOSpeedRatings]: 200,
        [piexif.ExifIFD.FNumber]: [28, 10],
      },
      GPS: {
        [piexif.GPSIFD.GPSLatitudeRef]: 'N',
        [piexif.GPSIFD.GPSLatitude]: [[39, 1], [54, 1], [3000, 100]],
        [piexif.GPSIFD.GPSLongitudeRef]: 'E',
        [piexif.GPSIFD.GPSLongitude]: [[116, 1], [23, 1], [4500, 100]],
      },
    };
    return Buffer.from(piexif.insert(piexif.dump(exifObj), buf.toString('binary')), 'binary');
  });
}

async function upload(base, buf, meta = {}, idemKey) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'image/jpeg' }), meta.filename || 'photo.jpg');
  fd.append('meta', JSON.stringify(meta));
  const headers = { Authorization: 'Bearer ' + TOKEN };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  const res = await fetch(base + '/api/admin/photos', { method: 'POST', headers, body: fd });
  return { status: res.status, body: await res.json() };
}

const admin = (base, url, opts = {}) => fetch(base + url, {
  ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

const j = (res) => res.json();

module.exports = { start, makeJpeg, makeGpsJpeg, upload, admin, j, TOKEN };
