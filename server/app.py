"""HTTP server for the photo gallery: public API, admin API, versioned
media URLs and static hosting. Standard library only."""
import hashlib
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .db import DB
from .exif import parse_exif
from .variants import (BudgetExceeded, Saturated, VariantPipeline, KINDS)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
TEST_HOOKS = os.environ.get("PHOTOS_TEST_HOOKS") == "1"
ADMIN_TOKEN = os.environ.get("PHOTOS_ADMIN_TOKEN", "dev-token")

IMMUTABLE = "public, max-age=31536000, immutable"
NO_STORE = "no-store"


def _json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


class App:
    """Holds shared state so tests can build isolated instances."""

    def __init__(self, data_dir):
        os.makedirs(data_dir, exist_ok=True)
        self.db = DB(os.path.join(data_dir, "photos.db"))
        self.originals = os.path.join(data_dir, "originals")
        os.makedirs(self.originals, exist_ok=True)
        self.pipeline = VariantPipeline(self.db, os.path.join(data_dir, "variants"))
        self.flaky = {}          # test hook: key -> remaining failures
        self.delay_ms = {}       # test hook: path -> extra latency

    # ------------------------------------------------------------ internals
    def original_path(self, pid):
        return os.path.join(self.originals, f"{pid}.jpg")

    def variant_url(self, photo_id, kind, version):
        return f"/media/{photo_id}/{kind}/v{version}.jpg"

    def public_variants(self, pid):
        out = {}
        for kind in KINDS:
            v = self.db.get_variant(pid, kind)
            if v and v["status"] == "ready":
                out[kind] = {
                    "url": self.variant_url(pid, kind, v["version"]),
                    "width": v["width"], "height": v["height"],
                }
        return out

    def public_photo(self, row):
        """Public metadata: never includes EXIF/GPS, only cleared fields."""
        lic = self.db.get_license(row["license_id"])
        return {
            "id": row["id"],
            "title": row["title"],
            "description": row["description"],
            "category_id": row["category_id"],
            "license": {"id": lic["id"], "name": lic["name"],
                        "allow_download": bool(lic["allow_download"])},
            "width": row["width"], "height": row["height"],
            "variants": self.public_variants(row["id"]),
        }

    def visibility_error(self, row):
        """None if publicly visible, else (status_code, reason)."""
        if row is None:
            return 404, "not_found"
        lic = self.db.get_license(row["license_id"])
        if row["status"] != "active":
            return 410, "delisted"
        if lic["revoked"]:
            return 410, "license_revoked"
        if not lic["allow_public_view"]:
            return 403, "not_public"
        return None

    def download_error(self, row):
        """Original-file download is permission-checked server-side; hiding
        the button in the UI is only a convenience."""
        err = self.visibility_error(row)
        if err:
            return err
        lic = self.db.get_license(row["license_id"])
        if not lic["allow_download"]:
            return 403, "download_not_allowed"
        return None


APP = None  # set by make_server


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PhotoGallery/1.0"

    # ------------------------------------------------------------ plumbing
    def log_message(self, *a):  # quiet in tests
        if os.environ.get("PHOTOS_VERBOSE"):
            super().log_message(*a)

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8",
              cache=NO_STORE, extra=None):
        if isinstance(body, (dict, list)):
            body = _json_bytes(body)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _err(self, code, reason, extra=None):
        self._send(code, {"error": reason}, extra=extra)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json_body(self):
        try:
            return json.loads(self._body() or b"{}")
        except json.JSONDecodeError:
            return {}

    def _is_admin(self):
        return self.headers.get("Authorization") == f"Bearer {ADMIN_TOKEN}"

    def _require_admin(self):
        if not self._is_admin():
            self._err(401, "admin_required")
            return False
        return True

    # ------------------------------------------------------------- routing
    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def _dispatch(self, method):
        path, _, qs = self.path.partition("?")
        query = dict(p.split("=", 1) if "=" in p else (p, "")
                     for p in qs.split("&") if p)
        app = APP

        # ---- test hooks (only when PHOTOS_TEST_HOOKS=1)
        if TEST_HOOKS:
            if path == "/__flaky":
                key = query.get("key", "k")
                if app.flaky.get(key, 0) > 0:
                    app.flaky[key] -= 1
                    return self._err(500, "flaky_failure")
                return self._send(200, {"ok": True, "key": key})
            if path == "/__flaky_reset":
                app.flaky[query.get("key", "k")] = int(query.get("fail", "1"))
                return self._send(200, {"armed": app.flaky[query.get("key", "k")]})
            d = app.delay_ms.get(path)
            if d:
                time.sleep(d / 1000)

        routes = [
            ("GET",  r"/api/photos$", self.h_list_photos),
            ("GET",  r"/api/photos/(\d+)/public$", self.h_public_photo),
            ("GET",  r"/api/photos/(\d+)/original$", self.h_original),
            ("GET",  r"/api/variant/(\d+)/(\w+)$", self.h_variant_ondemand),
            ("POST", r"/api/sequence$", self.h_make_sequence),
            ("GET",  r"/api/sequence/([0-9a-f]+)$", self.h_get_sequence),
            ("GET",  r"/api/taxonomy$", self.h_taxonomy),
            ("GET",  r"/api/admin/photos$", self.h_admin_list),
            ("GET",  r"/api/admin/photos/(\d+)/exif$", self.h_admin_exif),
            ("POST", r"/api/admin/photos$", self.h_admin_upload),
            ("PATCH", r"/api/admin/photos/(\d+)$", self.h_admin_update),
            ("POST", r"/api/admin/photos/(\d+)/delist$", self.h_admin_delist),
            ("POST", r"/api/admin/photos/(\d+)/relist$", self.h_admin_relist),
            ("POST", r"/api/admin/reorder$", self.h_admin_reorder),
            ("POST", r"/api/admin/categories$", self.h_admin_add_category),
            ("POST", r"/api/admin/licenses$", self.h_admin_add_license),
            ("POST", r"/api/admin/licenses/(\d+)/revoke$", self.h_admin_revoke_license),
            ("GET",  r"/media/(\d+)/(\w+)/v(\d+)\.jpg$", self.h_media),
        ]
        for m, pat, fn in routes:
            if m == method:
                match = re.fullmatch(pat, path)
                if match:
                    try:
                        return fn(query, *match.groups())
                    except BrokenPipeError:
                        return
                    except Exception as exc:  # never leak stack to client
                        return self._err(500, f"internal: {type(exc).__name__}")
        return self.h_static(path)

    # -------------------------------------------------------- public API
    def h_list_photos(self, q):
        page = max(1, int(q.get("page", 1)))
        size = min(100, max(1, int(q.get("size", 20))))
        cat = int(q["category"]) if q.get("category") else None
        lic = int(q["license"]) if q.get("license") else None
        rows, total = APP.db.search_photos(cat, lic, page=page, size=size)
        self._send(200, {
            "items": [APP.public_photo(r) for r in rows],
            "total": total, "page": page, "size": size,
            "seq_version": APP.db.seq_version(),
            "request_id": q.get("request_id", ""),   # echo for stale-drop
        }, cache="no-cache",
            extra={"ETag": f'"{APP.db.seq_version()}"'})

    def h_public_photo(self, q, pid):
        row = APP.db.get_photo(int(pid))
        err = APP.visibility_error(row)
        if err:
            return self._err(*err)
        body = APP.public_photo(row)
        body["seq_version"] = APP.db.seq_version()
        self._send(200, body, cache="no-cache")

    def h_original(self, q, pid):
        row = APP.db.get_photo(int(pid))
        err = APP.download_error(row)
        if err:
            return self._err(*err)
        with open(APP.original_path(row["id"]), "rb") as fh:
            data = fh.read()
        self._send(200, data, ctype="image/jpeg", cache="private, no-store",
                   extra={"Content-Disposition":
                          f'attachment; filename="photo-{pid}.jpg"'})

    def h_variant_ondemand(self, q, pid, kind):
        """On-demand generation with the same budget/limits as pregen.
        Failure -> 503 + Retry-After; the client falls back to placeholder."""
        row = APP.db.get_photo(int(pid))
        err = APP.visibility_error(row)
        if err:
            return self._err(*err)
        if kind not in KINDS:
            return self._err(404, "unknown_kind")
        try:
            v = APP.pipeline.generate_variant(
                row, kind, APP.original_path(row["id"]), wait=False)
        except Saturated:
            return self._err(503, "generator_busy",
                             extra={"Retry-After": "2"})
        except BudgetExceeded as exc:
            return self._err(413, str(exc))
        except Exception:
            return self._err(503, "generation_failed",
                             extra={"Retry-After": "5"})
        self._send(200, {"kind": kind, "version": v["version"],
                         "url": APP.variant_url(row["id"], kind, v["version"]),
                         "width": v["width"], "height": v["height"]},
                   cache="no-cache")

    def h_make_sequence(self, q):
        """Pin the current filtered order as a lightbox cursor snapshot."""
        filt = self._json_body()
        cat = filt.get("category") or None
        lic = filt.get("license_id") or None
        ids = []
        page = 1
        while True:
            rows, total = APP.db.search_photos(cat, lic, page=page, size=500)
            ids.extend(r["id"] for r in rows)
            if page * 500 >= total:
                break
            page += 1
        sid = APP.db.save_sequence({"category": cat, "license_id": lic}, ids)
        self._send(200, {"seq_id": sid, "ids": ids,
                         "seq_version": APP.db.seq_version()})

    def h_get_sequence(self, q, sid):
        seq = APP.db.get_sequence(sid)
        if not seq:
            return self._err(404, "unknown_sequence")
        self._send(200, {"seq_id": sid, "ids": seq["ids"],
                         "seq_version": seq["seq_version"]},
                   cache="no-cache")

    def h_taxonomy(self, q):
        self._send(200, {
            "categories": APP.db.list_categories(),
            "licenses": [l for l in APP.db.list_licenses()
                         if l["allow_public_view"]],
            "seq_version": APP.db.seq_version(),
        }, cache="no-cache")

    # --------------------------------------------------------- admin API
    def h_admin_list(self, q):
        if not self._require_admin():
            return
        rows, total = APP.db.search_photos(include_delisted=True,
                                           page=1, size=1000)
        out = []
        for r in rows:
            d = APP.public_photo(r)
            d["status"] = r["status"]
            d["content_hash"] = r["content_hash"]
            out.append(d)
        self._send(200, {"items": out, "total": total,
                         "seq_version": APP.db.seq_version()})

    def h_admin_exif(self, q, pid):
        if not self._require_admin():
            return
        row = APP.db.get_photo(int(pid))
        if not row:
            return self._err(404, "not_found")
        self._send(200, {"id": row["id"],
                         "exif": json.loads(row["exif_json"])})

    def h_admin_upload(self, q):
        if not self._require_admin():
            return
        parts = self._multipart()
        blob = parts.get("file", {}).get("data")
        if not blob:
            return self._err(400, "file_required")
        fields = {k: v.get("data", b"").decode("utf-8", "replace")
                  for k, v in parts.items() if k != "file"}
        content_hash = hashlib.sha256(blob).hexdigest()
        exif = parse_exif(blob)
        try:
            w, h = APP.pipeline.identify_bytes(blob)
        except Exception:
            return self._err(400, "unreadable_image")
        from .variants import MAX_SRC_PIXELS
        if w * h > MAX_SRC_PIXELS:
            return self._err(413, f"source exceeds {MAX_SRC_PIXELS} px budget")
        lic_id = int(fields.get("license_id") or 0)
        if not APP.db.get_license(lic_id):
            return self._err(400, "unknown_license")
        cat = fields.get("category_id")
        pid = APP.db.create_photo(
            content_hash=content_hash,
            title=fields.get("title", ""),
            description=fields.get("description", ""),
            category_id=int(cat) if cat else None,
            license_id=lic_id, width=w, height=h, exif=exif)
        with open(APP.original_path(pid), "wb") as fh:
            fh.write(blob)
        APP.db.add_variant(pid, "original", 1, w, h,
                           APP.original_path(pid), "ready")
        photo = APP.db.get_photo(pid)

        def pregen():           # async pre-generation (strategy A)
            APP.pipeline.pregenerate(photo, APP.original_path(pid))
        threading.Thread(target=pregen, daemon=True).start()
        self._send(201, {"id": pid, "seq_version": APP.db.seq_version()})

    def h_admin_update(self, q, pid):
        if not self._require_admin():
            return
        row = APP.db.get_photo(int(pid))
        if not row:
            return self._err(404, "not_found")
        body = self._json_body()
        fields = {k: body[k] for k in
                  ("title", "description", "category_id", "license_id")
                  if k in body}
        if fields:
            APP.db.update_photo(int(pid), fields)
        self._send(200, {"ok": True, "seq_version": APP.db.seq_version()})

    def h_admin_delist(self, q, pid):
        if not self._require_admin():
            return
        row = APP.db.get_photo(int(pid))
        if not row:
            return self._err(404, "not_found")
        APP.db.set_status(int(pid), "delisted")
        APP.db.revoke_variants(int(pid))     # every issued URL now dies
        self._send(200, {"ok": True, "seq_version": APP.db.seq_version()})

    def h_admin_relist(self, q, pid):
        if not self._require_admin():
            return
        row = APP.db.get_photo(int(pid))
        if not row:
            return self._err(404, "not_found")
        APP.db.set_status(int(pid), "active")
        photo = APP.db.get_photo(int(pid))

        def regen():            # revoked variants come back as NEW versions
            APP.pipeline.pregenerate(photo, APP.original_path(int(pid)))
        threading.Thread(target=regen, daemon=True).start()
        self._send(200, {"ok": True, "seq_version": APP.db.seq_version()})

    def h_admin_reorder(self, q):
        if not self._require_admin():
            return
        ids = self._json_body().get("ids", [])
        APP.db.reorder([int(i) for i in ids])
        self._send(200, {"ok": True, "seq_version": APP.db.seq_version()})

    def h_admin_add_category(self, q):
        if not self._require_admin():
            return
        body = self._json_body()
        cid = APP.db.add_category(body.get("name", ""), body.get("position", 0))
        APP.db.bump_seq_version()
        self._send(201, {"id": cid})

    def h_admin_add_license(self, q):
        if not self._require_admin():
            return
        body = self._json_body()
        lid = APP.db.add_license(body.get("name", ""),
                                 int(bool(body.get("allow_download"))),
                                 int(bool(body.get("allow_public_view", True))))
        self._send(201, {"id": lid})

    def h_admin_revoke_license(self, q, lid):
        if not self._require_admin():
            return
        APP.db.revoke_license(int(lid))
        for r in APP.db.search_photos(license_id=int(lid),
                                      include_delisted=True)[0]:
            APP.db.revoke_variants(r["id"])
        self._send(200, {"ok": True, "seq_version": APP.db.seq_version()})

    # ------------------------------------------------------------- media
    def h_media(self, q, pid, kind, version):
        """Versioned, immutable variant URLs. A revoked/delisted variant is
        410 Gone forever — an expired link can never re-fetch it, even after
        the photo is relisted (relisted photos get NEW version numbers)."""
        if kind not in KINDS:            # 'original' is never served here;
            return self._err(404, "unknown_variant")  # use .../original instead
        v = APP.db.get_variant(int(pid), kind, int(version))
        if v is None:
            return self._err(404, "unknown_variant")
        if v["status"] == "revoked":
            return self._err(410, "variant_revoked")
        row = APP.db.get_photo(int(pid))
        err = APP.visibility_error(row)
        if err:
            return self._err(*err)
        if v["status"] != "ready" or not os.path.exists(v["path"]):
            return self._err(404, "variant_not_ready")
        with open(v["path"], "rb") as fh:
            data = fh.read()
        self._send(200, data, ctype="image/jpeg", cache=IMMUTABLE)

    # ------------------------------------------------------------ static
    def h_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        elif path == "/gallery":
            path = "/web/gallery.html"
        elif path == "/admin":
            path = "/web/admin.html"
        full = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not (full.startswith(ROOT) and os.path.isfile(full)):
            return self._err(404, "not_found")
        ctype = {".html": "text/html; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8",
                 ".mjs": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".svg": "image/svg+xml",
                 ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".png": "image/png", ".webp": "image/webp",
                 ".txt": "text/plain; charset=utf-8"}.get(
            os.path.splitext(full)[1].lower(), "application/octet-stream")
        with open(full, "rb") as fh:
            data = fh.read()
        cache = "no-cache" if ctype.startswith(("text/", "image/svg")) \
            else "public, max-age=3600"
        self._send(200, data, ctype=ctype, cache=cache)

    # ---------------------------------------------------------- multipart
    def _multipart(self):
        ctype = self.headers.get("Content-Type", "")
        m = re.search(r"boundary=(.+)", ctype)
        if not m:
            return {}
        boundary = m.group(1).strip().strip('"').encode()
        body = self._body()
        parts = {}
        for chunk in body.split(b"--" + boundary):
            chunk = chunk.strip(b"\r\n")
            if not chunk or chunk == b"--":
                continue
            head, _, data = chunk.partition(b"\r\n\r\n")
            headers = {}
            for line in head.split(b"\r\n"):
                k, _, v = line.partition(b": ")
                headers[k.lower().decode()] = v.decode()
            disp = headers.get("content-disposition", "")
            name = re.search(r'name="([^"]+)"', disp)
            if name:
                parts[name.group(1)] = {"data": data, "headers": headers}
        return parts


def make_server(data_dir, host="127.0.0.1", port=8080):
    global APP
    APP = App(data_dir)
    # identify needs a bytes variant for uploads; attach here to keep
    # variants.py subprocess-only.
    import subprocess, tempfile

    def identify_bytes(blob):
        with tempfile.NamedTemporaryFile(suffix=".img", delete=False) as t:
            t.write(blob)
            tmp = t.name
        try:
            return APP.pipeline.identify(tmp)
        finally:
            os.unlink(tmp)
    APP.pipeline.identify_bytes = identify_bytes
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.app = APP
    return srv
