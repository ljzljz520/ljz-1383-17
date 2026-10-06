'use strict';
const path = require('path');

/**
 * 全局配置：变体规格、生成队列并发、像素预算、按需生成限流。
 * 所有值可被环境变量覆盖，便于测试注入更小的预算。
 */
module.exports = {
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  adminToken: process.env.ADMIN_TOKEN || 'dev-admin-token',
  port: Number(process.env.PORT || 8080),

  // 尺寸变体定义（服务端预生成）
  variants: {
    thumb:  { width: 480,  height: 480, fit: 'cover',  quality: 78 },
    medium: { width: 1280, height: null, fit: 'inside', quality: 82 },
    large:  { width: 2560, height: null, fit: 'inside', quality: 85 },
  },

  // 生成队列：并发数 + 像素预算（防止解压炸弹 / 内存打爆）
  queue: {
    concurrency: Number(process.env.VARIANT_CONCURRENCY || 2),
    maxInputPixels: Number(process.env.MAX_INPUT_PIXELS || 100_000_000), // 1 亿像素上限
    maxInputBytes: Number(process.env.MAX_INPUT_BYTES || 60 * 1024 * 1024),
  },

  // 按需生成（预生成缺失时的回退）：全局限流，防止被刷
  onDemand: {
    enabled: true,
    maxPerMinute: Number(process.env.ON_DEMAND_PER_MINUTE || 30),
  },

  // 缓存策略（秒）
  cache: {
    variantMaxAge: 365 * 24 * 3600, // 版本化 URL，可 immutable
    htmlMaxAge: 0,                  // 页面始终 revalidate
  },
};
