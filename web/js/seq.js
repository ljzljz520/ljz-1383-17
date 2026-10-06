// Pure client-side logic for the gallery. No DOM here, so the same module
// runs in the browser and under Node for unit tests.

/** Drops stale async responses: only the newest request may commit. */
export class RequestSequencer {
  constructor() { this.latest = 0; }
  next() { return ++this.latest; }
  isCurrent(id) { return id === this.latest; }
}

/** Retry wrapper for idempotent GETs: retries network failures and 5xx
 *  with exponential backoff; 4xx is returned immediately (never retried). */
export async function retryingFetch(fetchImpl, url, opts = {},
                                    { retries = 3, baseMs = 150 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, opts);
    } catch (err) {                      // network interrupted
      lastErr = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, baseMs * 2 ** attempt));
        continue;
      }
      throw err;
    }
    if (res.status >= 500 && attempt < retries) {
      await new Promise(r => setTimeout(r, baseMs * 2 ** attempt));
      continue;
    }
    return res;                          // 2xx/3xx/4xx: definitive answer
  }
  throw lastErr;
}

/** Navigates a PINNED snapshot of ids. Items delisted mid-session keep
 *  their slot (positions never shift) and are skipped, so the left/right
 *  keys can never loop back onto the same photo or reorder the sequence. */
export class SequenceNavigator {
  constructor(ids, startIndex = 0) {
    if (!ids.length) throw new Error("empty sequence");
    this.ids = ids.slice();              // frozen cursor snapshot
    this.gone = new Set();               // ids that returned 410
    this.index = Math.min(Math.max(0, startIndex), ids.length - 1);
  }
  currentId() { return this.ids[this.index]; }
  markGone(id) { this.gone.add(id); }
  isGone(id) { return this.gone.has(id); }
  /** step: +1 / -1. Returns target index or null when nothing available. */
  _seek(step) {
    let i = this.index;
    for (let n = 0; n < this.ids.length; n++) {
      i += step;
      if (i < 0 || i >= this.ids.length) return null;   // hard stop at ends
      if (!this.gone.has(this.ids[i])) return i;
    }
    return null;
  }
  move(step) {
    const t = this._seek(step);
    if (t === null) return null;
    this.index = t;
    return this.ids[t];
  }
  next() { return this.move(+1); }
  prev() { return this.move(-1); }
  hasNext() { return this._seek(+1) !== null; }
  hasPrev() { return this._seek(-1) !== null; }
}

/** Binds every preload to (photoId, variantId, token). A late-arriving
 *  image from an older task fails commit() and must be discarded by the
 *  caller, so it can never overwrite the current slide's image or title. */
export class PreloadGate {
  constructor() { this.token = 0; }
  begin(photoId, variantId) {
    return { token: ++this.token, photoId, variantId };
  }
  commit(task, apply) {
    if (task.token !== this.token) return false;   // stale task
    apply();
    return true;
  }
}
