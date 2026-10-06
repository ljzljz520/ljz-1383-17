'use strict';
/** 示例数据：分类 + 不同授权的样片 + 排序版本 */
const sharp = require('sharp');
const piexif = require('piexifjs');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';

const scenes = [
  { title: '群山日出', cat: 'landscape', color: { r: 244, g: 162, b: 97 }, license: { label: '公开展示', allowWeb: true, allowOriginal: false } },
  { title: '海岸长曝', cat: 'landscape', color: { r: 42, g: 111, b: 151 }, license: { label: '展示+原图', allowWeb: true, allowOriginal: true } },
  { title: '街头人像', cat: 'portrait', color: { r: 233, g: 196, b: 106 }, people: true, license: { label: '公开展示', allowWeb: true, allowOriginal: false } },
  { title: '棚拍肖像', cat: 'portrait', color: { r: 231, g: 111, b: 81 }, people: true, license: { label: '内部存档', allowWeb: false, allowOriginal: false } },
  { title: '城市夜景', cat: 'city', color: { r: 38, g: 70, b: 83 }, license: { label: '公开展示', allowWeb: true, allowOriginal: false } },
  { title: '雨后街道', cat: 'city', color: { r: 100, g: 120, b: 140 }, license: { label: '展示+原图', allowWeb: true, allowOriginal: true } },
];

async function main() {
  const api = (url, opts = {}) => fetch(BASE + url, {
    ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(r => r.json());

  for (const [slug, name, position] of [['landscape', '风光', 1], ['portrait', '人像', 2], ['city', '城市', 3]]) {
    await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ slug, name, position }) });
  }
  const ids = [];
  for (const s of scenes) {
    let buf = await sharp({ create: { width: 1600, height: 1067, channels: 3, background: s.color } })
      .jpeg().toBuffer();
    if (s.people) { // 人像样片写入 GPS EXIF，验证脱敏链路
      const exifObj = { GPS: {
        [piexif.GPSIFD.GPSLatitudeRef]: 'N', [piexif.GPSIFD.GPSLatitude]: [[31, 1], [14, 1], [0, 1]],
        [piexif.GPSIFD.GPSLongitudeRef]: 'E', [piexif.GPSIFD.GPSLongitude]: [[121, 1], [28, 1], [0, 1]],
      } };
      buf = Buffer.from(piexif.insert(piexif.dump(exifObj), buf.toString('binary')), 'binary');
    }
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'image/jpeg' }), s.title + '.jpg');
    fd.append('meta', JSON.stringify({ title: s.title, caption: s.title + ' · 示例作品', hasPeople: !!s.people, categories: [s.cat], license: s.license }));
    const res = await fetch(BASE + '/api/admin/photos', {
      method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Idempotency-Key': 'seed-' + scenes.indexOf(s) }, body: fd,
    });
    const body = await res.json();
    ids.push(body.photo.id);
    console.log('上传', s.title, body.photo.id, body.deduped ? '(去重)' : '');
  }
  const sv = await api('/api/admin/sort-versions', { method: 'POST', body: JSON.stringify({ name: '初始排序', order: ids }) });
  await api(`/api/admin/sort-versions/${sv.id}/activate`, { method: 'POST', body: '{}' });
  console.log('排序版本已激活:', sv.id);
}
main().catch(e => { console.error(e); process.exit(1); });
