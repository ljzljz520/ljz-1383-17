/**
 * 灯箱核心逻辑（纯逻辑，无 DOM，可在 Node 中单测）。
 *
 * 序列策略：游标快照（cursor snapshot）。
 *  - 打开灯箱时冻结当前筛选 + 排序版本 + 已加载 id 序列；
 *  - 翻页只按游标向后扩展，新增作品不会插入到快照中间；
 *  - 下架行为：状态校验返回 gone 的作品标记为墓碑，导航时永久跳过，
 *    左右键永远不会再跳回它；序列不会因外部变化而位移。
 */

export class SequenceSnapshot {
  constructor({ fetchPage, filterHash, sortVersion }) {
    this.fetchPage = fetchPage;     // async (cursor) => {items, nextCursor, sortVersion}
    this.filterHash = filterHash;   // 仅由公开筛选参数构成
    this.sortVersion = sortVersion;
    this.ids = [];
    this.known = new Set();
    this.cursor = null;
    this.done = false;
    this.tombstones = new Set();    // 已下架：永久跳过
  }

  /** 追加一页；按 id 去重，乱序/重叠的分页响应不会污染快照 */
  appendPage(items, nextCursor) {
    for (const it of items) {
      if (this.known.has(it.id)) continue;
      this.known.add(it.id);
      this.ids.push(it.id);
    }
    this.cursor = nextCursor || null;
    if (!nextCursor) this.done = true;
  }

  async ensure(index) {
    while (this.ids.length <= index && !this.done) {
      const page = await this.fetchPage(this.cursor);
      // 排序版本被管理员切换：快照作废，调用方需重建
      if (page.sortVersion !== this.sortVersion) {
        const e = new Error('sort-version-changed'); e.code = 'SORT_VERSION_CHANGED'; throw e;
      }
      this.appendPage(page.items, page.nextCursor);
    }
    return this.ids.length;
  }

  async getId(index) {
    if (index < 0) return null;
    await this.ensure(index);
    return this.ids[index] ?? null;
  }

  indexOf(id) { return this.ids.indexOf(id); }

  applyStatus(statusMap) {
    for (const [id, st] of Object.entries(statusMap)) {
      if (st !== 'public') this.tombstones.add(id);
    }
  }

  /** 从 from 沿 dir 找下一个仍公开的作品；墓碑永久跳过 */
  async nextAlive(from, dir) {
    let i = from;
    for (let guard = 0; guard < 10000; guard++) {
      i += dir;
      if (i < 0) return null;
      const id = await this.getId(i);
      if (id === null) return null;
      if (!this.tombstones.has(id)) return { index: i, id };
    }
    return null;
  }
}

/**
 * 图片加载器：任务绑定 (photoId, variant) 身份。
 *  - 同一身份去重并发；导航时取消不再需要的在途请求；
 *  - 晚到的旧响应由调用方用 token 比对丢弃（见 lightbox.js），
 *    本加载器保证返回对象始终携带身份，绝不串图。
 */
export class ImageLoader {
  constructor(deps = {}) {
    this.fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
    this.createObjectURL = deps.createObjectURL || ((b) => URL.createObjectURL(b));
    this.revokeObjectURL = deps.revokeObjectURL || ((u) => URL.revokeObjectURL(u));
    this.maxCache = deps.maxCache || 8;
    this.cache = new Map();    // key -> {objectUrl, photoId, variant, lastUsed}
    this.inflight = new Map(); // key -> {promise, controller}
  }

  static key(photoId, variant) { return `${photoId}::${variant}`; }

  load({ photoId, variant, url }) {
    const key = ImageLoader.key(photoId, variant);
    const hit = this.cache.get(key);
    if (hit) { hit.lastUsed = Date.now(); return Promise.resolve({ ...hit, key }); }
    if (this.inflight.has(key)) return this.inflight.get(key).promise;

    const controller = new AbortController();
    const promise = (async () => {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) { const e = new Error('image-http-' + res.status); e.status = res.status; throw e; }
      const blob = await res.blob();
      const objectUrl = this.createObjectURL(blob);
      const rec = { objectUrl, photoId, variant, lastUsed: Date.now() };
      this.cache.set(key, rec);
      this._evict();
      return { ...rec, key };
    })();
    this.inflight.set(key, { promise, controller });
    promise.finally(() => this.inflight.delete(key)).catch(() => {});
    return promise;
  }

  /** 取消不在保留集合中的在途请求（快速切换时释放带宽） */
  abortExcept(keepKeys) {
    for (const [key, t] of this.inflight) {
      if (!keepKeys.includes(key)) t.controller.abort();
    }
  }

  _evict() {
    while (this.cache.size > this.maxCache) {
      let oldestKey = null, oldest = Infinity;
      for (const [k, v] of this.cache) if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
      const rec = this.cache.get(oldestKey);
      this.revokeObjectURL(rec.objectUrl);
      this.cache.delete(oldestKey);
    }
  }

  /** 关闭灯箱：中止全部在途、释放全部对象 URL */
  dispose() {
    for (const t of this.inflight.values()) t.controller.abort();
    this.inflight.clear();
    for (const rec of this.cache.values()) this.revokeObjectURL(rec.objectUrl);
    this.cache.clear();
  }
}
