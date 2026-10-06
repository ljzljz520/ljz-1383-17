const $ = (s) => document.querySelector(s);
let token = sessionStorage.getItem('adminToken') || '';
let idemKey = crypto.randomUUID(); // 每个表单会话一个幂等键：网络中断重试不产生重复

const api = async (url, opts = {}) => {
  opts.headers = { ...(opts.headers || {}), Authorization: 'Bearer ' + token };
  if (opts.json) { opts.method = opts.method || 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(url, opts);
  if (!res.ok) { const e = new Error((await res.json().catch(() => ({}))).error || res.status); e.status = res.status; throw e; }
  return res.json();
};

/** 带重试的上传：同一幂等键，断网重试安全 */
async function uploadWithRetry(file, meta, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('meta', JSON.stringify(meta));
      return await api('/api/admin/photos', { method: 'POST', body: fd, headers: { 'Idempotency-Key': idemKey, Authorization: 'Bearer ' + token } });
    } catch (e) {
      if (attempt === retries || (e.status && e.status < 500)) throw e;
      $('#up-status').textContent = `网络中断，第 ${attempt} 次重试…`;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

function showApp() { $('#login-section').hidden = true; $('#admin-app').hidden = false; refreshAll(); }

$('#login-btn').onclick = () => {
  token = $('#token-input').value.trim();
  sessionStorage.setItem('adminToken', token);
  api('/api/admin/photos').then(showApp).catch(() => alert('令牌无效'));
};
if (token) api('/api/admin/photos').then(showApp).catch(() => {});

// ---------- 上传 ----------
const dz = $('#drop-zone'), fi = $('#file-input');
dz.onclick = () => fi.click();
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
dz.ondragleave = () => dz.classList.remove('drag');
dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); };
fi.onchange = () => fi.files[0] && pickFile(fi.files[0]);
let picked = null;
function pickFile(f) { picked = f; idemKey = crypto.randomUUID(); dz.textContent = '已选择：' + f.name; $('#upload-form').hidden = false; }

$('#up-submit').onclick = async () => {
  if (!picked) return;
  const cats = [...document.querySelectorAll('#up-categories input:checked')].map(c => c.value);
  $('#up-status').textContent = '上传中…';
  try {
    const r = await uploadWithRetry(picked, {
      title: $('#up-title').value, caption: $('#up-caption').value,
      hasPeople: $('#up-people').checked, categories: cats,
      license: { label: '上传授权', allowWeb: $('#up-web').checked, allowOriginal: $('#up-original').checked },
    });
    $('#up-status').textContent = r.deduped ? '同图已存在，已追加授权' : (r.idempotentReplay ? '重复请求已去重' : '上传成功，变体生成中');
    refreshPhotos();
  } catch (e) { $('#up-status').textContent = '失败：' + e.message; }
};

// ---------- 分类 ----------
async function refreshCategories() {
  const { items } = await api('/api/admin/categories');
  $('#cat-list').innerHTML = items.map(c => `<span class="chip">${c.name} (${c.slug})</span>`).join(' ');
  $('#up-categories').innerHTML = items.map(c => `<label><input type="checkbox" value="${c.slug}"> ${c.name}</label>`).join('');
}
$('#cat-add').onclick = async () => {
  await api('/api/admin/categories', { json: { slug: $('#cat-slug').value, name: $('#cat-name').value } });
  $('#cat-slug').value = $('#cat-name').value = '';
  refreshCategories();
};

// ---------- 作品 ----------
async function refreshPhotos() {
  const { items } = await api('/api/admin/photos');
  const box = $('#photo-list');
  box.innerHTML = '';
  for (const p of items) {
    const div = document.createElement('div');
    div.className = 'admin-photo glass';
    const thumb = (p.variants.find(v => v.name === 'thumb' && v.status === 'ready'));
    div.innerHTML = `
      ${thumb ? `<img src="/media/${p.id}/thumb/v${thumb.version}/image.jpg" alt="">` : '<p class="muted">变体生成中/失败</p>'}
      <input type="text" value="${esc(p.title)}" data-f="title" placeholder="标题">
      <textarea rows="2" data-f="caption" placeholder="说明">${esc(p.caption)}</textarea>
      <label><input type="checkbox" data-f="hasPeople" ${p.has_people ? 'checked' : ''}> 含人物</label>
      <label><input type="checkbox" data-f="delisted" ${p.status === 'delisted' ? 'checked' : ''}> 下架</label>
      <div>${p.licenses.map(l => `
        <div class="lic-row ${l.status === 'revoked' ? 'lic-revoked' : ''}">
          <span>${esc(l.label)}｜网页:${l.allow_web ? '✓' : '✗'} 原图:${l.allow_original ? '✓' : '✗'}</span>
          ${l.status === 'active' ? `<button class="btn-small btn-danger" data-revoke="${l.id}">撤销</button>` : '<span class="muted">已撤销</span>'}
        </div>`).join('')}</div>
      <button class="btn-small" data-addlic="${p.id}">+授权</button>
      <button class="btn-small" data-save="${p.id}">保存</button>
      <button class="btn-small" data-reprocess="${p.id}">重新处理</button>
      <p class="muted">v${p.media_version} · ${p.variants.map(v => v.name + ':' + v.status).join(' ')}</p>`;
    box.appendChild(div);
  }
  box.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const card = b.closest('.admin-photo');
    const g = (f) => card.querySelector(`[data-f="${f}"]`);
    await api('/api/admin/photos/' + b.dataset.save, { method: 'PATCH', json: {
      title: g('title').value, caption: g('caption').value,
      hasPeople: g('hasPeople').checked, status: g('delisted').checked ? 'delisted' : 'active',
    }});
    refreshPhotos();
  });
  box.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
    if (confirm('撤销该授权？公开访问将立即失效。')) { await api('/api/admin/licenses/' + b.dataset.revoke + '/revoke', { json: {} }); refreshPhotos(); }
  });
  box.querySelectorAll('[data-addlic]').forEach(b => b.onclick = async () => {
    const label = prompt('授权名称：', '补充授权'); if (!label) return;
    const allowWeb = confirm('允许公开网页展示？');
    const allowOriginal = confirm('允许原图下载？');
    await api('/api/admin/photos/' + b.dataset.addlic + '/licenses', { json: { label, allowWeb, allowOriginal } });
    refreshPhotos();
  });
  box.querySelectorAll('[data-reprocess]').forEach(b => b.onclick = async () => {
    await api('/api/admin/photos/' + b.dataset.reprocess + '/reprocess', { json: {} }); refreshPhotos();
  });
}

// ---------- 排序版本 ----------
async function refreshSort() {
  const { items } = await api('/api/admin/photos');
  const list = $('#sort-list');
  list.innerHTML = '';
  items.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'sort-row';
    row.dataset.photoId = p.id;
    row.innerHTML = `<span>${i + 1}</span><span>${esc(p.title) || p.id}</span>
      <button class="btn-small" data-mv="-1">↑</button><button class="btn-small" data-mv="1">↓</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => {
    const row = b.closest('.sort-row');
    if (b.dataset.mv === '-1' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    if (b.dataset.mv === '1' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
  });
  const { items: versions } = await api('/api/admin/sort-versions');
  $('#sort-versions').innerHTML = versions.map(v =>
    `<div class="lic-row"><span>${esc(v.name)} ${v.active ? '· <b>当前生效</b>' : ''}</span>
     ${v.active ? '' : `<button class="btn-small" data-activate="${v.id}">激活</button>`}</div>`).join('');
  document.querySelectorAll('[data-activate]').forEach(b => b.onclick = async () => {
    await api('/api/admin/sort-versions/' + b.dataset.activate + '/activate', { json: {} }); refreshSort();
  });
}
$('#sort-save').onclick = async () => {
  const order = [...document.querySelectorAll('#sort-list .sort-row')].map(r => r.dataset.photoId);
  await api('/api/admin/sort-versions', { json: { name: $('#sort-name').value || '排序 ' + new Date().toLocaleString(), order } });
  $('#sort-name').value = ''; refreshSort();
};

function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function refreshAll() { refreshCategories(); refreshPhotos(); refreshSort(); }
