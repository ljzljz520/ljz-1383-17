'use strict';
const exifr = require('exifr');

/** 允许进入公开元数据的 EXIF 白名单 —— 明确不含 GPS / 设备序列号等隐私字段 */
const PUBLIC_KEYS = ['Make', 'Model', 'LensModel', 'FocalLength', 'FNumber',
  'ExposureTime', 'ISO', 'DateTimeOriginal'];

async function extractExif(buffer) {
  let raw = null;
  try { raw = await exifr.parse(buffer, { gps: true, translateValues: true }); }
  catch { raw = null; }
  const pub = {};
  const priv = {};
  if (raw) {
    for (const k of PUBLIC_KEYS) {
      if (raw[k] !== undefined && raw[k] !== null) pub[k] = raw[k] instanceof Date ? raw[k].toISOString() : raw[k];
    }
    if (raw.latitude !== undefined && raw.longitude !== undefined) {
      priv.gps = { latitude: raw.latitude, longitude: raw.longitude };
    }
  }
  return { public: pub, private: priv };
}

module.exports = { extractExif };
