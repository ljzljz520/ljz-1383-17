'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const exifr = require('exifr');
const { start, makeJpeg, makeGpsJpeg, upload, admin, j, TOKEN } = require('./helpers');

const WEB = { label: '公开展示', allowWeb: true, allowOriginal: false };
const WEB_ORIG = { label: '展示+原图', allowWeb: true, allowOriginal: true };

test('验收1: 原图 EXIF 含位置 → 公开元数据与变体剥离 GPS，原图不公开', async () => {
  const { base, queue, close } = await start();
  try {
    const gpsBuf = await makeGpsJpeg();
    const gps = await exifr.gps(gpsBuf);
    assert.ok(gps && Math.abs(gps.latitude - 39.908) < 0.01, '原图应含 GPS');

    const { body } = await upload(base, gpsBuf, { title: '外滩人像', hasPeople: true, license: WEB });
    const id = body.photo.id;
    await queue.idle();

    // 公开元数据：有拍摄参数，无 GPS
    const pub = await fetch(`${base}/api/public/photos/${id}`).then(j);
    assert.equal(pub.exif.Make, 'TestCam');
    assert.ok(!('latitude' in pub.exif) && !('gps' in pub.exif) && !('GPSLatitude' in pub.exif), '公开元数据不得含 GPS');

    // 管理端保留私有 EXIF（含 GPS）
    const adm = await admin(base, `/api/admin/photos`).then(j);
    assert.ok(adm.items[0].exif_private.gps, '管理端应保留 GPS 供作者参考');

    // 变体二进制不含任何 EXIF
    const vbuf = Buffer.from(await (await fetch(base + pub.variants.medium.url)).arrayBuffer());
    const vexif = await exifr.parse(vbuf).catch(() => null);
    assert.ok(!vexif || vexif.latitude === undefined, '变体不得携带 EXIF/GPS');

    // 无原图授权：下载被服务端拒绝（不只是没有按钮）
    assert.equal(pub.original, undefined);
    const dl = await fetch(`${base}/media/${id}/original/v1/photo.jpg`);
    assert.equal(dl.status, 403);
  } finally { close(); }
});

test('验收2: 撤销人物照片授权 → 信息流/变体/原图全部立即失效', async () => {
  const { base, queue, close } = await start();
  try {
    const { body } = await upload(base, await makeJpeg(), { title: '人像', hasPeople: true, license: WEB_ORIG });
    const id = body.photo.id;
    await queue.idle();
    const feed1 = await fetch(`${base}/api/public/feed`).then(j);
    assert.equal(feed1.items.length, 1);
    assert.equal(feed1.items[0].hasPeople, true);
    const thumbUrl = feed1.items[0].variants.thumb.url;
    assert.equal((await fetch(base + thumbUrl)).status, 200);

    // 撤销授权
    const licId = body.photo.licenses[0].id;
    await admin(base, `/api/admin/licenses/${licId}/revoke`, { method: 'POST', body: '{}' });

    assert.equal((await fetch(`${base}/api/public/feed`).then(j)).items.length, 0, '信息流应排除');
    assert.equal((await fetch(`${base}/api/public/photos/${id}`)).status, 404);
    const gone = await fetch(base + thumbUrl);
    assert.equal(gone.status, 410, '旧变体链接不得复活');
    assert.equal(gone.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/media/${id}/original/v1/x.jpg`)).status, 403);
    const st = await fetch(`${base}/api/public/photos/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }),
    }).then(j);
    assert.equal(st.status[id], 'gone', '灯箱墓碑校验应报告 gone');
  } finally { close(); }
});

test('验收3: 同图不同授权上传 → 去重为同一作品并追加授权', async () => {
  const { base, queue, close } = await start();
  try {
    const buf = await makeJpeg(640, 480, { r: 10, g: 200, b: 90 });
    const r1 = await upload(base, buf, { title: '同图', license: { label: '内部存档', allowWeb: false, allowOriginal: false } });
    const r2 = await upload(base, buf, { title: '同图（重复）', license: WEB_ORIG });
    assert.equal(r2.body.deduped, true);
    assert.equal(r1.body.photo.id, r2.body.photo.id, '同图应合并为同一作品');
    await queue.idle();

    const photos = await admin(base, '/api/admin/photos').then(j);
    assert.equal(photos.items.length, 1);
    assert.equal(photos.items[0].licenses.length, 2, '两条授权记录并存');

    const feed = await fetch(`${base}/api/public/feed`).then(j);
    assert.equal(feed.items.length, 1, '第二条授权使其公开');
    assert.ok(feed.items[0].original, '原图下载授权生效');

    // 撤销公开授权后回到不可见
    await admin(base, `/api/admin/licenses/${r2.body.photo.licenses[1].id}/revoke`, { method: 'POST', body: '{}' });
    assert.equal((await fetch(`${base}/api/public/feed`).then(j)).items.length, 0);
  } finally { close(); }
});

test('验收4: 翻页期间新增/下架 → keyset 分页不乱序不重复', async () => {
  const { base, queue, close } = await start();
  try {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const { body } = await upload(base, await makeJpeg(100 + i, 100), { title: 'P' + i, license: WEB });
      ids.push(body.photo.id);
    }
    await queue.idle();
    // 固定排序版本，保证测试确定性
    const sv = await admin(base, '/api/admin/sort-versions', { method: 'POST', body: JSON.stringify({ name: 'v1', order: ids }) }).then(j);
    await admin(base, `/api/admin/sort-versions/${sv.id}/activate`, { method: 'POST', body: '{}' });

    const p1 = await fetch(`${base}/api/public/feed?limit=2`).then(j);
    assert.deepEqual(p1.items.map(x => x.id), [ids[0], ids[1]]);
    assert.equal(p1.sortVersion, sv.id);

    // 翻页间隙：新增一张 + 下架一张
    await upload(base, await makeJpeg(50, 50), { title: 'NEW', license: WEB });
    await admin(base, `/api/admin/photos/${ids[3]}`, { method: 'PATCH', body: JSON.stringify({ status: 'delisted' }) });

    const p2 = await fetch(`${base}/api/public/feed?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`).then(j);
    const all = [...p1.items, ...p2.items].map(x => x.id);
    assert.deepEqual(all, [ids[0], ids[1], ids[2], ids[4]],
      '新增作品不插入已翻过的位置，下架作品被跳过，无重复无回跳');
    assert.equal(p2.nextCursor, null, '序列到此结束');
    // 伪造/过期游标应被明确拒绝而非静默重置
    assert.equal((await fetch(`${base}/api/public/feed?cursor=@@@`)).status, 400);
  } finally { close(); }
});

test('验收5: 网络中断 → 幂等键重试不产生重复；截断上传不留半成品', async () => {
  const { base, close } = await start();
  try {
    const buf = await makeJpeg();
    const key = 'upload-' + Date.now();
    const r1 = await upload(base, buf, { title: '断网重试', license: WEB }, key);
    assert.equal(r1.status, 201);
    // 模拟客户端超时后重试（同幂等键）
    const r2 = await upload(base, buf, { title: '断网重试', license: WEB }, key);
    assert.equal(r2.body.idempotentReplay, true);
    assert.equal(r2.body.photo.id, r1.body.photo.id);
    const photos = await admin(base, '/api/admin/photos').then(j);
    assert.equal(photos.items.length, 1, '重试不得产生重复作品');

    // 截断上传：连接中途断开，不得留下照片记录
    await new Promise((resolve) => {
      const req = http.request(base + '/api/admin/photos', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'multipart/form-data; boundary=xx', 'Content-Length': 10_000_000 },
      }, () => resolve());
      req.on('error', () => resolve());
      req.write('--xx\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\n\r\npartial');
      setTimeout(() => { req.destroy(); resolve(); }, 100);
    });
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await admin(base, '/api/admin/photos').then(j)).items.length, 1, '截断请求不得产生半成品');
  } finally { close(); }
});

test('验收6: 原图下载权限由服务端强制（按钮隐藏之外）', async () => {
  const { base, queue, close } = await start();
  try {
    const buf = await makeJpeg();
    const { body } = await upload(base, buf, { license: WEB }); // 不允许原图
    const id = body.photo.id;
    await queue.idle();
    const feed = await fetch(`${base}/api/public/feed`).then(j);
    assert.equal(feed.items[0].original, undefined, '响应中不下发原图地址');
    assert.equal((await fetch(`${base}/media/${id}/original/v1/photo.jpg`)).status, 403, '直接构造 URL 也被拒');

    // 追加原图授权 → 可下载且字节一致；撤销 → 立即 403
    await admin(base, `/api/admin/photos/${id}/licenses`, { method: 'POST', body: JSON.stringify({ label: '原图授权', allowWeb: false, allowOriginal: true }) });
    const dl = await fetch(`${base}/media/${id}/original/v1/photo.jpg`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), buf);
    const lic2 = (await admin(base, '/api/admin/photos').then(j)).items[0].licenses[1];
    await admin(base, `/api/admin/licenses/${lic2.id}/revoke`, { method: 'POST', body: '{}' });
    assert.equal((await fetch(`${base}/media/${id}/original/v1/photo.jpg`)).status, 403);
  } finally { close(); }
});

test('验收7: 缓存版本化 → 重新处理后旧链接失效，撤下后任何版本不可取', async () => {
  const { base, queue, close } = await start();
  try {
    const { body } = await upload(base, await makeJpeg(), { license: WEB });
    const id = body.photo.id;
    await queue.idle();
    const v1 = `${base}/media/${id}/thumb/v1/image.jpg`;
    const r1 = await fetch(v1);
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('cache-control'), /immutable/, '版本化变体可长缓存');

    await admin(base, `/api/admin/photos/${id}/reprocess`, { method: 'POST', body: '{}' });
    await queue.idle();
    const stale = await fetch(v1);
    assert.equal(stale.status, 404, '旧版本链接不得再取到变体');
    assert.equal((await fetch(`${base}/media/${id}/thumb/v2/image.jpg`)).status, 200);

    await admin(base, `/api/admin/photos/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'delisted' }) });
    assert.equal((await fetch(`${base}/media/${id}/thumb/v2/image.jpg`)).status, 410);
    assert.equal((await fetch(v1)).status, 410, '撤下后历史版本同样 410');

    // 页面与静态资源缓存策略
    const html = await fetch(`${base}/gallery.html`);
    assert.match(html.headers.get('cache-control'), /no-cache/);
    const css = await fetch(`${base}/css/gallery.css?v=2`);
    assert.match(css.headers.get('cache-control'), /must-revalidate/);
  } finally { close(); }
});

test('验收8: 像素预算超限 → 变体失败回退占位图；按需生成受限流', async () => {
  const { base, queue, close } = await start({ queue: { maxInputPixels: 5000 }, onDemand: { maxPerMinute: 1 } });
  try {
    const { body } = await upload(base, await makeJpeg(200, 200), { license: WEB }); // 4 万像素 > 5000 预算
    const id = body.photo.id;
    await queue.idle();
    const adm = await admin(base, '/api/admin/photos').then(j);
    assert.ok(adm.items[0].variants.every(v => v.status === 'failed'), '超预算变体应标记失败');
    assert.match(adm.items[0].variants[0].error, /pixel-budget/);

    const feed = await fetch(`${base}/api/public/feed`).then(j);
    assert.deepEqual(feed.items[0].variants, {}, '失败变体不下发，前端回退占位图');

    // 按需生成第一次（预算内失败）→ 占位图；第二次触发限流 → 429
    const m1 = await fetch(`${base}/media/${id}/thumb/v1/image.jpg`);
    assert.equal(m1.status, 404);
    assert.match(m1.headers.get('content-type'), /svg/);
    const m2 = await fetch(`${base}/media/${id}/thumb/v1/image.jpg`);
    assert.equal(m2.status, 429, '按需生成应受每分钟限流');
  } finally { close(); }
});

test('验收9: 未认证访问管理接口被拒；分类与排序版本管理', async () => {
  const { base, close } = await start();
  try {
    assert.equal((await fetch(`${base}/api/admin/photos`)).status, 401);
    await admin(base, '/api/admin/categories', { method: 'POST', body: JSON.stringify({ slug: 'landscape', name: '风光' }) });
    const { body } = await upload(base, await makeJpeg(), { title: '山', categories: ['landscape'], license: WEB });
    const cats = await fetch(`${base}/api/public/categories`).then(j);
    assert.equal(cats.items[0].slug, 'landscape');
    const filtered = await fetch(`${base}/api/public/feed?category=landscape`).then(j);
    assert.equal(filtered.items.length, 1);
    const none = await fetch(`${base}/api/public/feed?category=portrait`).then(j);
    assert.equal(none.items.length, 0);
    assert.ok(body.photo.id);
  } finally { close(); }
});
