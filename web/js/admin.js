// Admin console: upload originals, edit metadata, manage licenses/order.
const $ = id => document.getElementById(id);
let token = sessionStorage.getItem("admin_token") || "";
$("token").value = token;

const api = async (path, opts = {}) => {
  opts.headers = Object.assign({ Authorization: `Bearer ${token}` },
                               opts.headers || {});
  const res = await fetch(path, opts);
  if (res.status === 401) { $("msg").textContent = "令牌无效"; throw new Error("401"); }
  return res;
};

$("save-token").onclick = () => {
  token = $("token").value.trim();
  sessionStorage.setItem("admin_token", token);
  refresh();
};

$("upload-form").onsubmit = async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await api("/api/admin/photos", { method: "POST", body: fd });
  $("msg").textContent = res.ok ? `已上传 #${(await res.json()).id}`
                                : "上传失败：" + (await res.json()).error;
  e.target.reset();
  refresh();
};

async function refresh() {
  const res = await api("/api/admin/photos");
  if (!res.ok) return;
  const { items } = await res.json();
  const tbody = $("rows");
  tbody.innerHTML = "";
  for (const p of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${p.id}</td>
      <td><input value="${p.title.replace(/"/g, "&quot;")}" data-f="title"></td>
      <td><input value="${p.description.replace(/"/g, "&quot;")}" data-f="description"></td>
      <td>${p.license.name}</td><td>${p.status}</td><td class="ops"></td>`;
    const ops = tr.querySelector(".ops");
    const mk = (label, fn) => {
      const b = document.createElement("button");
      b.textContent = label; b.onclick = fn; ops.appendChild(b);
    };
    mk("保存", async () => {
      const body = {};
      tr.querySelectorAll("input").forEach(i => body[i.dataset.f] = i.value);
      await api(`/api/admin/photos/${p.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) });
      refresh();
    });
    mk(p.status === "active" ? "下架" : "重新上架", async () => {
      await api(`/api/admin/photos/${p.id}/${p.status === "active" ? "delist" : "relist"}`,
                { method: "POST" });
      refresh();
    });
    mk("EXIF", async () => {
      const r = await api(`/api/admin/photos/${p.id}/exif`);
      alert(JSON.stringify((await r.json()).exif, null, 2));
    });
    tbody.appendChild(tr);
  }
}

$("add-license").onclick = async () => {
  await api("/api/admin/licenses", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: $("lic-name").value,
      allow_download: $("lic-dl").checked,
      allow_public_view: true }) });
  refresh();
};
$("revoke-license").onclick = async () => {
  const id = $("lic-revoke-id").value;
  if (id && confirm(`确认撤销授权 #${id}？相关作品将立即不可见。`)) {
    await api(`/api/admin/licenses/${id}/revoke`, { method: "POST" });
    refresh();
  }
};
$("add-category").onclick = async () => {
  await api("/api/admin/categories", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: $("cat-name").value }) });
  refresh();
};
if (token) refresh();
