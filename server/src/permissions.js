'use strict';

/**
 * 授权聚合：一张照片可挂多条授权记录（同图不同授权）。
 * 有效权限 = 所有 active 授权的并集；撤销即 status='revoked'。
 * 所有媒体请求（含旧版本 URL）每次都重新过这里，保证撤下后不可再取。
 */
function effectiveLicense(db, photoId) {
  const rows = db.prepare(
    `SELECT label, allow_web, allow_original FROM licenses
     WHERE photo_id = ? AND status = 'active'`
  ).all(photoId);
  return {
    web: rows.some(r => r.allow_web),
    original: rows.some(r => r.allow_original),
    labels: rows.map(r => r.label),
  };
}

/** 公开可见 = 作品未下架 且 存在有效的网页展示授权 */
function isPubliclyVisible(db, photo) {
  if (!photo || photo.status !== 'active') return false;
  return effectiveLicense(db, photo.id).web;
}

module.exports = { effectiveLicense, isPubliclyVisible };
