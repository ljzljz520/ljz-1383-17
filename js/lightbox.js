import { SequenceSnapshot, ImageLoader } from './lightbox-core.js';

/**
 * 灯箱 DOM 绑定。
 * 防串图：每次导航递增 navToken，图片与标题在 token 校验通过后才原子提交，
 * 晚到的旧响应无法覆盖当前标题。
 */
export class Lightbox {
  constructor({ root, sequence, fetchMeta, checkStatus, onClose }) {
    this.root = root;
    this.sequence = sequence;         // SequenceSnapshot
    this.fetchMeta = fetchMeta;       // (id) => Promise<publicPhoto>
    this.checkStatus = checkStatus;   // (ids) => Promise<{id: 'public'|'gone'}>
    this.onClose = onClose || (() => {});
    this.loader = new ImageLoader();
    this.navToken = 0;
    this.index = -1;
    this.metaCache = new Map();
    this.opener = null;

    this.img = root.querySelector('.lb-image');
    this.titleEl = root.querySelector('.lb-title');
    this.captionEl = root.querySelector('.lb-caption');
    this.counterEl = root.querySelector('.lb-counter');
    this.metaEl = root.querySelector('.lb-meta');
    this.dlBtn = root.querySelector('.lb-download');
    this.errEl = root.querySelector('.lb-error');

    root.querySelector('.lb-prev').addEventListener('click', () => this.move(-1));
    root.querySelector('.lb-next').addEventListener('click', () => this.move(1));
    root.querySelector('.lb-close').addEventListener('click', () => this.close());
    this._onKey = (e) => {
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowLeft') this.move(-1);
      else if (e.key === 'ArrowRight') this.move(1);
      else if (e.key === 'Tab') this._trapFocus(e);
    };
  }

  async open(photoId, openerEl) {
    this.opener = openerEl || document.activeElement;
    const idx = this.sequence.indexOf(photoId);
    this.root.classList.add('open');
    document.body.classList.add('lb-open');
    document.addEventListener('keydown', this._onKey);
    history.pushState({ lb: photoId, fh: this.sequence.filterHash }, '', '#p=' + photoId);
    this._popHandler = (e) => {
      const id = e.state && e.state.lb;
      if (id && this.sequence.indexOf(id) >= 0 && !this.sequence.tombstones.has(id)) {
        this._show(this.sequence.indexOf(id));
      } else this._teardown();
    };
    window.addEventListener('popstate', this._popHandler);
    await this._show(idx >= 0 ? idx : 0);
    this.root.querySelector('.lb-close').focus();
  }

  async move(dir) {
    // 先校验当前位置附近作品状态，下架作品标记墓碑后跳过
    try {
      const around = this.sequence.ids.slice(Math.max(0, this.index - 2), this.index + 5);
      const st = await this.checkStatus(around);
      this.sequence.applyStatus(st);
    } catch { /* 状态校验失败不阻塞导航 */ }
    let next;
    try { next = await this.sequence.nextAlive(this.index, dir); }
    catch (e) {
      if (e.code === 'SORT_VERSION_CHANGED') { this._fatal('排序已更新，请重新打开灯箱'); return; }
      throw e;
    }
    if (!next) { this._flash(dir > 0 ? '已经是最后一张' : '已经是第一张'); return; }
    history.pushState({ lb: next.id, fh: this.sequence.filterHash }, '', '#p=' + next.id);
    await this._show(next.index);
  }

  async _meta(id) {
    if (!this.metaCache.has(id)) this.metaCache.set(id, await this.fetchMeta(id));
    return this.metaCache.get(id);
  }

  async _show(index) {
    const my = ++this.navToken;
    this.index = index;
    const id = this.sequence.ids[index];
    this.errEl.hidden = true;
    this.root.classList.add('lb-loading');

    let meta;
    try { meta = await this._meta(id); }
    catch { if (my === this.navToken) this._fatal('加载失败，请重试'); return; }

    const variant = meta.variants.large || meta.variants.medium || meta.variants.thumb;
    if (!variant) { if (my === this.navToken) this._fatal('图片暂不可用'); return; }

    // 预加载邻居（身份绑定 photoId+variant）
    this._preloadNeighbors(index);

    try {
      const rec = await this.loader.load({ photoId: id, variant: 'main', url: variant.url });
      if (my !== this.navToken) return; // 晚到的旧响应：直接丢弃，不碰图也不碰标题
      // 原子提交：图与标题同时切换
      this.img.src = rec.objectUrl;
      this.img.alt = meta.title || '作品';
      this.titleEl.textContent = meta.title || '未命名';
      this.captionEl.textContent = meta.caption || '';
      this.metaEl.textContent = this._formatExif(meta.exif);
      const alive = this.sequence.ids.length - this.sequence.tombstones.size;
      this.counterEl.textContent = `${index + 1} / ${alive}`;
      if (meta.original) { this.dlBtn.href = meta.original.url; this.dlBtn.hidden = false; }
      else this.dlBtn.hidden = true; // 无原图授权：隐藏按钮（服务端仍强制 403）
      this.root.classList.remove('lb-loading');
    } catch (e) {
      if (my !== this.navToken) return;
      this.root.classList.remove('lb-loading');
      this.errEl.hidden = false;
      this.errEl.querySelector('button').onclick = () => this._show(this.index);
    }
  }

  _preloadNeighbors(index) {
    const keep = [];
    for (const d of [0, -1, 1, -2, 2]) {
      const id = this.sequence.ids[index + d];
      if (!id || this.sequence.tombstones.has(id)) continue;
      keep.push(ImageLoader.key(id, 'main'));
      this._meta(id).then(m => {
        const v = m.variants.large || m.variants.medium || m.variants.thumb;
        if (v) this.loader.load({ photoId: id, variant: 'main', url: v.url }).catch(() => {});
      }).catch(() => {});
    }
    this.loader.abortExcept(keep); // 取消快速切换后不再需要的在途请求
  }

  _formatExif(exif) {
    if (!exif) return '';
    const parts = [];
    if (exif.Model) parts.push(exif.Model);
    if (exif.FNumber) parts.push('f/' + exif.FNumber);
    if (exif.ExposureTime) parts.push(exif.ExposureTime >= 1 ? exif.ExposureTime + 's' : `1/${Math.round(1 / exif.ExposureTime)}s`);
    if (exif.ISO) parts.push('ISO' + exif.ISO);
    if (exif.DateTimeOriginal) parts.push(String(exif.DateTimeOriginal).slice(0, 10));
    return parts.join(' · ');
  }

  _trapFocus(e) {
    const focusables = this.root.querySelectorAll('button:not([hidden]), a:not([hidden])');
    const list = [...focusables]; if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }

  _flash(msg) {
    this.counterEl.textContent = msg;
    setTimeout(() => { if (this.index >= 0) this.counterEl.textContent = `${this.index + 1} / ${this.sequence.ids.length - this.sequence.tombstones.size}`; }, 1200);
  }

  _fatal(msg) { this.errEl.hidden = false; this.errEl.querySelector('span').textContent = msg; }

  close() { if (history.state && history.state.lb) history.back(); else this._teardown(); }

  _teardown() {
    this.navToken++;                 // 使所有在途提交失效
    document.removeEventListener('keydown', this._onKey);
    window.removeEventListener('popstate', this._popHandler);
    this.loader.dispose();           // 中止在途 + 释放全部对象 URL
    this.img.removeAttribute('src');
    this.root.classList.remove('open');
    document.body.classList.remove('lb-open');
    if (this.opener && document.contains(this.opener)) this.opener.focus(); // 恢复焦点
    this.onClose();
  }
}

export { SequenceSnapshot };
