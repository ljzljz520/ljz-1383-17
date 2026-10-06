'use strict';
const { createApp } = require('./app');
const { app, cfg } = createApp();
if (cfg.adminToken === 'dev-admin-token') {
  console.warn('[warn] 使用默认 ADMIN_TOKEN，生产环境请通过环境变量覆盖');
}
app.listen(cfg.port, () => console.log(`相册服务已启动: http://localhost:${cfg.port}`));
