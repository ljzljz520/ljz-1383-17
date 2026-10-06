// Lightbox: pinned-sequence browsing, identity-bound preloading, focus
// management and deterministic resource cleanup.
import { SequenceNavigator, PreloadGate, retryingFetch } from "./seq.js";

const PLACEHOLDER = "/web/static/placeholder.svg";

export class Lightbox {
  constructor(root) {
    this.root = root;
    this.nav = null;
    this.gate = new PreloadGate();
    this.cache = new Map();        // `${photoId}:${variantId}` -> objectURL
    this.abort = null;             // AbortController for in-flight loads
    this.opener = null;            // element to restore focus to
    this.seqId = null;
    this._onKey = this._handleKey.bind(this);
  }

  /** Open on `ids` (pinned server-side as seqId) at startIndex. */
  open({ seqId, ids, startIndex = 0 }) {
    this.seqId = seqId;
    this.nav = new SequenceNavigator(ids, startIndex);
    this.opener = document.activeElement;
    this._build();
    document.addEventListener("keydown", this._onKey);
    this._loadCurrent();
    this._pushHistory();
    this.closeBtn.focus();
  }

  // ------------------------------------------------------------ dom
  _build() {
    this.root.innerHTML = "";
    this.root.className = "lb-overlay";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "图片灯箱");
    const fig = document.createElement("figure");
    fig.className = "lb-stage";
    this.img = document.createElement("img");
    this.img.alt = "";
    this.cap = document.createElement("figcaption");
    this.titleEl = document.createElement("h2");
    this.descEl = document.createElement("p");
    this.metaEl = document.createElement("p");
    this.metaEl.className = "lb-meta";
    this.dl = document.createElement("a");
    this.dl.textContent = "下载原图";
    this.dl.className = "lb-download";
    this.cap.append(this.titleEl, this.descEl, this.metaEl, this.dl);
    fig.append(this.img, this.cap);
    this.prevBtn = this._btn("‹ 上一张", () => this._go(-1), "lb-prev");
    this.nextBtn = this._btn("下一张 ›", () => this._go(+1), "lb-next");
    this.closeBtn = this._btn("关闭 (Esc)", () => this.close(), "lb-close");
    this.root.append(fig, this.prevBtn, this.nextBtn, this.closeBtn);
    this.root.style.display = "flex";
  }

  _btn(label, fn, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.className = cls;
    b.addEventListener("click", fn);
    return b;
  }

  // --------------------------------------------------------- loading
  async _loadCurrent() {
    const id = this.nav.currentId();
    if (this.abort) this.abort.abort();       // cancel previous slide's loads
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let meta;
    try {
      const res = await retryingFetch(fetch, `/api/photos/${id}/public`,
                                      { signal });
      if (res.status === 410 || res.status === 403) {
        // Delisted mid-session: keep the slot, show a tombstone slide.
        this.nav.markGone(id);
        return this._showGone(id);
      }
      if (!res.ok) throw new Error("http " + res.status);
      meta = await res.json();
    } catch (err) {
      if (err.name === "AbortError") return;
      return this._showError(id);              // network down: keep state
    }
    const variant = meta.variants.large || meta.variants.medium ||
                    meta.variants.thumb;
    const variantId = variant ? variant.url : "none";
    const task = this.gate.begin(id, variantId);
    try {
      const url = variant ? await this._imageUrl(id, variant, signal) : PLACEHOLDER;
      // Commit only if this task is still the current one — a late image
      // from rapid keying must not overwrite the current slide/title.
      this.gate.commit(task, () => {
        this.img.src = url;
        this.img.alt = meta.title || "未命名作品";
        this.titleEl.textContent = meta.title || "未命名作品";
        this.descEl.textContent = meta.description || "";
        this.metaEl.textContent =
          `${this.nav.index + 1} / ${this.nav.ids.length} · ${meta.license.name}`;
        if (meta.license.allow_download) {     // UX hint only; server enforces
          this.dl.href = `/api/photos/${id}/original`;
          this.dl.style.display = "";
        } else {
          this.dl.removeAttribute("href");
          this.dl.style.display = "none";
        }
        this._updateArrows();
      });
    } catch (err) {
      if (err.name !== "AbortError") this._showError(id);
    }
    this._preloadNeighbors();
  }

  async _imageUrl(photoId, variant, signal) {
    const key = `${photoId}:${variant.url}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const res = await retryingFetch(fetch, variant.url, { signal });
    if (!res.ok) throw new Error("variant " + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    this.cache.set(key, url);
    return url;
  }

  _preloadNeighbors() {
    for (const step of [+1, -1, +2]) {
      const idx = this.nav.index + step;
      if (idx < 0 || idx >= this.nav.ids.length) continue;
      const nid = this.nav.ids[idx];
      if (this.nav.isGone(nid)) continue;
      // Fire-and-forget warm-up; each task carries its own identity and
      // its objectURL lands in the cache, never directly on the stage.
      retryingFetch(fetch, `/api/photos/${nid}/public`)
        .then(r => (r.status === 410 || r.status === 403)
          ? (this.nav.markGone(nid), null) : r.json())
        .then(meta => {
          if (!meta) return;
          const v = meta.variants.large || meta.variants.medium;
          if (!v) return;
          const key = `${nid}:${v.url}`;
          if (this.cache.has(key)) return;
          return fetch(v.url).then(r => r.ok ? r.blob() : null)
            .then(b => { if (b) this.cache.set(key, URL.createObjectURL(b)); });
        })
        .catch(() => { /* preload is best-effort */ });
    }
  }

  // ------------------------------------------------------------ states
  _showGone(id) {
    const task = this.gate.begin(id, "gone");
    this.gate.commit(task, () => {
      this.img.src = PLACEHOLDER;
      this.img.alt = "作品已下架";
      this.titleEl.textContent = "该作品已下架";
      this.descEl.textContent = "作者撤下了这张作品，它仍保留在本次浏览序列中的位置。";
      this.metaEl.textContent = `${this.nav.index + 1} / ${this.nav.ids.length}`;
      this.dl.removeAttribute("href");
      this.dl.style.display = "none";
      this._updateArrows();
    });
  }

  _showError(id) {
    this.titleEl.textContent = "网络异常，加载失败";
    this.descEl.textContent = "";
    const retry = this._btn("重试", () => { retry.remove(); this._loadCurrent(); },
                            "lb-retry");
    this.descEl.appendChild(retry);
    this.metaEl.textContent = `${this.nav.index + 1} / ${this.nav.ids.length}`;
  }

  _updateArrows() {
    this.prevBtn.disabled = !this.nav.hasPrev();
    this.nextBtn.disabled = !this.nav.hasNext();
  }

  // --------------------------------------------------------- navigation
  _go(step) {
    const moved = this.nav.move(step);
    if (moved === null) return;               // hard stop, no wrap-around
    this._loadCurrent();
    this._pushHistory();
  }

  _pushHistory() {
    // History keeps ONLY public-safe state: sequence id + index.
    // No titles, no image URLs, nothing private.
    history.replaceState({ seqId: this.seqId, index: this.nav.index }, "");
  }

  _handleKey(e) {
    if (e.key === "Escape") return this.close();
    if (e.key === "ArrowRight") return this._go(+1);
    if (e.key === "ArrowLeft") return this._go(-1);
    if (e.key === "Tab") {                    // simple focus trap
      const items = [this.closeBtn, this.prevBtn, this.nextBtn]
        .filter(b => !b.disabled);
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      const n = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1)
                           : (i + 1) % items.length;
      items[n].focus();
    }
  }

  // ------------------------------------------------------------- close
  close() {
    document.removeEventListener("keydown", this._onKey);
    if (this.abort) this.abort.abort();
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
    this.root.style.display = "none";
    this.root.innerHTML = "";
    if (this.opener && this.opener.focus) this.opener.focus();  // restore
    this.nav = null;
  }
}
