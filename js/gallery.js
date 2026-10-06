import { Lightbox, SequenceSnapshot } from './lightbox.js';

const grid = document.getElementById('grid');
const filterBar = document.getElementById('filters');
const moreBtn = document.getElementById('load-more');
const ASSET_V = document.body.dataset.assetVersion || '1';

let activeCategory = null;
let snapshot = null;
let metaById = new Map();
let lightbox = null;

const fetchJSON = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('http-' + res.status);
  return res.json();
};

const fetchPage = (cursor) => {
  const q = new URLSearchParams({ limit: '12' });
  if (activeCategory) q.set('category', activeCategory);
  if (cursor) q.set('cursor', cursor);
  return fetchJSON('/api/public/feed?' + q);
};

function filterHash() { return 'cat=' + (activeCategory || '*'); }

async function resetFeed() {
  grid.innerHTML = '';
  metaById = new Map();
  snapshot = new SequenceSnapshot({ fetchPage, filterHash: filterHash(), sortVersion: null });
  const page = await fetchPage(null);
  snapshot.sortVersion = page.sortVersion;
  snapshot.appendPage(page.items, page.nextCursor);
  for (const it of page.items) metaById.set(it.id, it);
  renderNew(page.items);
  moreBtn.hidden = !page.nextCursor;
}

async function loadMore() {
  if (!snapshot || snapshot.done) return;
  const before = snapshot.ids.length;
  await snapshot.ensure(before); // 拉一页
  const page = await fetchPage(snapshot.cursor);
  snapshot.appendPage(page.items, page.nextCursor);
  const newItems = page.items.filter(it => !metaById.has(it.id));
  for (const it of newItems) metaById.set(it.id, it);
  renderNew(newItems);
  moreBtn.hidden = !page.nextCursor;
}

function renderNew(items) {
  for (const it of items) {
    const btn = document.createElement('button');
    btn.className = 'card photo-card';
    btn.dataset.photoId = it.id;
    const v = it.variants.thumb || it.variants.medium;
    btn.innerHTML = `
      <img loading="lazy" src="${v ? v.url : ''}" alt="${escapeHtml(it.title || '作品')}"
           onerror="this.src='/images/placeholder.svg'">
      <div class="photo-info">
        <strong>${escapeHtml(it.title || '未命名')}</strong>
        ${it.hasPeople ? '<span class="badge">人像</span>' : ''}
      </div>`;
    btn.addEventListener('click', () => openLightbox(it.id, btn));
    grid.appendChild(btn);
  }
}

function openLightbox(id, opener) {
  if (!lightbox) {
    lightbox = new Lightbox({
      root: document.getElementById('lightbox'),
      sequence: snapshot,
      fetchMeta: (pid) => metaById.has(pid) ? Promise.resolve(metaById.get(pid)) : fetchJSON('/api/public/photos/' + pid),
      checkStatus: (ids) => fetchJSON('/api/public/photos/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      }).then(r => r.status),
    });
  }
  lightbox.sequence = snapshot;
  lightbox.open(id, opener);
}

async function initFilters() {
  const { items } = await fetchJSON('/api/public/categories');
  const mk = (slug, name) => {
    const b = document.createElement('button');
    b.className = 'chip' + (slug === activeCategory ? ' active' : '');
    b.textContent = name;
    b.onclick = () => { activeCategory = slug; filterBar.querySelectorAll('.chip').forEach(c => c.classList.remove('active')); b.classList.add('active'); resetFeed(); };
    filterBar.appendChild(b);
  };
  mk(null, '全部');
  for (const c of items) mk(c.slug, c.name);
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

moreBtn.addEventListener('click', loadMore);
initFilters().then(resetFeed);

// 深链接 #p=<id>：历史状态只含公开信息（作品 id + 公开筛选）
window.addEventListener('load', async () => {
  const m = location.hash.match(/^#p=(.+)$/);
  if (m) {
    const id = m[1];
    try { await fetchJSON('/api/public/photos/' + id); openLightbox(id, null); }
    catch { /* 已下架：忽略 */ }
  }
});
