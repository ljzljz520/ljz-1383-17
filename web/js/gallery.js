// Gallery page: filters, paginated grid, opens the lightbox on a pinned
// server-side sequence snapshot.
import { RequestSequencer, retryingFetch } from "./seq.js";
import { Lightbox } from "./lightbox.js";

const grid = document.getElementById("grid");
const statusEl = document.getElementById("status");
const catSel = document.getElementById("f-category");
const licSel = document.getElementById("f-license");
const prevPage = document.getElementById("prev-page");
const nextPage = document.getElementById("next-page");
const pageInfo = document.getElementById("page-info");

const PAGE_SIZE = 12;
let page = 1, total = 0;
const seq = new RequestSequencer();       // out-of-order response guard
const lightbox = new Lightbox(document.getElementById("lightbox"));

async function loadTaxonomy() {
  const res = await retryingFetch(fetch, "/api/taxonomy");
  const t = await res.json();
  for (const c of t.categories) catSel.append(new Option(c.name, c.id));
  for (const l of t.licenses) licSel.append(new Option(l.name, l.id));
}

async function loadPage() {
  const reqId = seq.next();
  const q = new URLSearchParams({ page, size: PAGE_SIZE, request_id: reqId });
  if (catSel.value) q.set("category", catSel.value);
  if (licSel.value) q.set("license", licSel.value);
  statusEl.textContent = "加载中…";
  let data;
  try {
    const res = await retryingFetch(fetch, `/api/photos?${q}`);
    if (!res.ok) throw new Error("http " + res.status);
    data = await res.json();
  } catch {
    statusEl.textContent = "网络异常，请重试";
    return;
  }
  // Two-layer stale guard: local counter + echoed request_id.
  if (!seq.isCurrent(reqId) || String(data.request_id) !== String(reqId)) return;
  total = data.total;
  render(data.items);
  pageInfo.textContent = `第 ${page} 页 / 共 ${total} 张`;
  prevPage.disabled = page <= 1;
  nextPage.disabled = page * PAGE_SIZE >= total;
  statusEl.textContent = "";
}

function render(items) {
  grid.innerHTML = "";
  for (const p of items) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = p.variants.thumb ? p.variants.thumb.url
                               : "/web/static/placeholder.svg";
    img.onerror = () => { img.onerror = null;
                          img.src = "/web/static/placeholder.svg"; };
    img.alt = p.title || "未命名作品";
    const cap = document.createElement("span");
    cap.textContent = p.title || "未命名作品";
    card.append(img, cap);
    card.addEventListener("click", () => openLightbox(p.id, card));
    grid.appendChild(card);
  }
}

async function openLightbox(photoId, cardEl) {
  // Pin the CURRENT filter order server-side; delists during browsing
  // cannot reshuffle the sequence the lightbox walks through.
  const body = {
    category: catSel.value ? Number(catSel.value) : null,
    license_id: licSel.value ? Number(licSel.value) : null,
  };
  const res = await retryingFetch(fetch, "/api/sequence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const snap = await res.json();
  const startIndex = Math.max(0, snap.ids.indexOf(photoId));
  lightbox.open({ seqId: snap.seq_id, ids: snap.ids, startIndex });
  cardEl.focus();  // becomes the element focus returns to on close
}

catSel.addEventListener("change", () => { page = 1; loadPage(); });
licSel.addEventListener("change", () => { page = 1; loadPage(); });
prevPage.addEventListener("click", () => { page--; loadPage(); });
nextPage.addEventListener("click", () => { page++; loadPage(); });

loadTaxonomy().then(loadPage);
