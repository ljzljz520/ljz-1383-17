"""Acceptance tests: run a real server on an ephemeral port per test.

Covers: license revocation, EXIF location privacy, same-image/different-
license uploads, out-of-order pagination contract, network interruption
hooks, original-download permissions, variant URL expiry, sequence
snapshot stability, pixel budget, generation saturation and fallback.
"""
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error

os.environ["PHOTOS_TEST_HOOKS"] = "1"
os.environ.setdefault("PHOTOS_ADMIN_TOKEN", "test-token")

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server.app import make_server          # noqa: E402
from server.exif import build_gps_exif_segment, inject_exif, parse_exif  # noqa: E402
import server.variants as variants_mod      # noqa: E402

TOKEN = "test-token"


def jpeg_bytes(size="800x600", color="navy", with_gps=False):
    raw = subprocess.run(["convert", "-size", size, f"xc:{color}", "jpg:-"],
                         capture_output=True, check=True).stdout
    return inject_exif(raw, build_gps_exif_segment()) if with_gps else raw


def multipart(fields, file_field="file", blob=b"", filename="p.jpg"):
    boundary = "----testboundary1234"
    out = b""
    for k, v in fields.items():
        out += (f"--{boundary}\r\nContent-Disposition: form-data; "
                f'name="{k}"\r\n\r\n{v}\r\n').encode()
    if blob:
        out += (f"--{boundary}\r\nContent-Disposition: form-data; "
                f'name="{file_field}"; filename="{filename}"\r\n'
                f"Content-Type: image/jpeg\r\n\r\n").encode() + blob + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return out, f"multipart/form-data; boundary={boundary}"


class Gallery:
    """Context manager: fresh server + data dir on an ephemeral port."""

    def __enter__(self):
        self.dir = tempfile.mkdtemp(prefix="gallery-test-")
        self.srv = make_server(self.dir, port=0)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever,
                                       daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *a):
        self.srv.shutdown()
        self.srv.server_close()

    # ------------------------------------------------------------ requests
    def req(self, method, path, body=None, headers=None, raw=False):
        url = f"http://127.0.0.1:{self.port}{path}"
        h = dict(headers or {})
        data = None
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        elif isinstance(body, bytes):
            data = body
        r = urllib.request.Request(url, data=data, headers=h, method=method)

        def unpack(resp, payload):
            if raw:
                return payload
            ctype = resp.headers.get("Content-Type", "")
            if "json" not in ctype:
                return {"raw_bytes": payload}
            return json.loads(payload or b"{}")

        try:
            with urllib.request.urlopen(r, timeout=15) as resp:
                payload = resp.read()
                return resp.status, dict(resp.headers), unpack(resp, payload)
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), unpack(e, e.read())

    def admin(self, method, path, body=None, raw=False, headers=None):
        h = {"Authorization": f"Bearer {TOKEN}"}
        h.update(headers or {})
        return self.req(method, path, body, h, raw)

    # ------------------------------------------------------------ fixtures
    def add_license(self, name, allow_download=0, allow_public_view=1):
        s, _, d = self.admin("POST", "/api/admin/licenses",
                             {"name": name, "allow_download": allow_download,
                              "allow_public_view": allow_public_view})
        assert s == 201, d
        return d["id"]

    def upload(self, blob, license_id, title="t", desc="d", category_id=""):
        body, ctype = multipart(
            {"title": title, "description": desc,
             "license_id": str(license_id), "category_id": category_id},
            blob=blob)
        s, _, d = self.admin("POST", "/api/admin/photos", body,
                             headers={"Content-Type": ctype})
        assert s in (201, 400, 413), d
        return s, d

    def wait_variant(self, pid, kind="thumb", timeout=10):
        """Wait until async pregeneration finishes for a kind."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            s, _, d = self.req("GET", f"/api/photos/{pid}/public")
            if s == 200 and kind in d["variants"]:
                return d["variants"][kind]
            time.sleep(0.1)
        self.fail(f"variant {kind} for photo {pid} never became ready")


class TestAcceptance(unittest.TestCase):
    # -------------------------------------------------- 1. license revoke
    def test_revoked_license_hides_and_blocks_everything(self):
        with Gallery() as g:
            lic = g.add_license("肖像授权", allow_download=1)
            s, d = g.upload(jpeg_bytes(), lic, title="人像")
            pid = d["id"]
            v = g.wait_variant(pid)
            s, _, _ = g.req("GET", v["url"])
            self.assertEqual(s, 200)

            s, _, _ = g.admin("POST", f"/api/admin/licenses/{lic}/revoke")
            self.assertEqual(s, 200)

            s, _, d = g.req("GET", f"/api/photos/{pid}/public")
            self.assertEqual((s, d["error"]), (410, "license_revoked"))
            s, _, d = g.req("GET", f"/api/photos/{pid}/original")
            self.assertEqual(s, 410)                    # not just hidden
            s, _, d = g.req("GET", v["url"])            # old variant URL dies
            self.assertEqual((s, d["error"]), (410, "variant_revoked"))
            s, _, d = g.req("GET", "/api/photos")
            self.assertEqual(d["total"], 0)             # gone from listing

    # ---------------------------------------------------- 2. EXIF privacy
    def test_exif_location_never_leaks_publicly(self):
        with Gallery() as g:
            lic = g.add_license("公开", allow_download=1)
            s, d = g.upload(jpeg_bytes(with_gps=True), lic)
            pid = d["id"]
            # admin CAN see private EXIF (incl. GPS)
            s, _, d = g.admin("GET", f"/api/admin/photos/{pid}/exif")
            self.assertEqual(s, 200)
            self.assertAlmostEqual(d["exif"]["gps"]["lat"], 39.9042, places=3)
            # public metadata has no EXIF at all
            s, _, d = g.req("GET", f"/api/photos/{pid}/public")
            blob = json.dumps(d).lower()
            for word in ("gps", "exif", "lat", "lon", "39.9", "116.4"):
                self.assertNotIn(word, blob)
            # generated variants carry no EXIF bytes
            v = g.wait_variant(pid)
            s, _, data = g.req("GET", v["url"], raw=True)
            self.assertEqual(s, 200)
            self.assertEqual(parse_exif(data), {})
            self.assertNotIn(b"GPS", data)

    # ------------------------------------- 3. same image, two licenses
    def test_same_image_under_different_licenses_is_independent(self):
        with Gallery() as g:
            open_lic = g.add_license("开放", allow_download=1)
            restricted = g.add_license("受限", allow_download=0)
            blob = jpeg_bytes()
            _, d1 = g.upload(blob, open_lic, title="开放版")
            _, d2 = g.upload(blob, restricted, title="受限版")
            s, _, items = g.admin("GET", "/api/admin/photos")
            hashes = {p["id"]: p["content_hash"] for p in items["items"]}
            self.assertEqual(hashes[d1["id"]], hashes[d2["id"]])  # dedup key
            s, _, _ = g.req("GET", f"/api/photos/{d1['id']}/original")
            self.assertEqual(s, 200)                    # open: downloadable
            s, _, _ = g.req("GET", f"/api/photos/{d2['id']}/original")
            self.assertEqual(s, 403)                    # restricted: blocked

    # --------------------------- 4. original download obeys permission
    def test_original_download_enforced_server_side(self):
        with Gallery() as g:
            lic = g.add_license("禁下载", allow_download=0)
            _, d = g.upload(jpeg_bytes(), lic)
            pid = d["id"]
            # direct URL access (button hidden in UI is irrelevant)
            s, _, d2 = g.req("GET", f"/api/photos/{pid}/original")
            self.assertEqual((s, d2["error"]), (403, "download_not_allowed"))
            # /media must not leak the original either
            s, _, _ = g.req("GET", f"/media/{pid}/original/v1.jpg")
            self.assertEqual(s, 404)
            # after delist, even an allowed license cannot download
            lic2 = g.add_license("可下载", allow_download=1)
            _, d3 = g.upload(jpeg_bytes(color="red"), lic2)
            pid2 = d3["id"]
            s, _, _ = g.req("GET", f"/api/photos/{pid2}/original")
            self.assertEqual(s, 200)
            g.admin("POST", f"/api/admin/photos/{pid2}/delist")
            s, _, _ = g.req("GET", f"/api/photos/{pid2}/original")
            self.assertEqual(s, 410)

    # ------------------------------------ 5. variant URL expiry & renewal
    def test_expired_variant_urls_never_revive(self):
        with Gallery() as g:
            lic = g.add_license("公开")
            _, d = g.upload(jpeg_bytes(), lic)
            pid = d["id"]
            old = g.wait_variant(pid)
            s, _, _ = g.req("GET", old["url"])
            self.assertEqual(s, 200)
            self.assertIn("immutable",
                          g.req("GET", old["url"])[1].get("Cache-Control", ""))
            g.admin("POST", f"/api/admin/photos/{pid}/delist")
            s, _, d2 = g.req("GET", old["url"])
            self.assertEqual((s, d2["error"]), (410, "variant_revoked"))
            g.admin("POST", f"/api/admin/photos/{pid}/relist")
            new = g.wait_variant(pid)
            self.assertNotEqual(old["url"], new["url"])   # new version
            s, _, _ = g.req("GET", new["url"])
            self.assertEqual(s, 200)
            s, _, _ = g.req("GET", old["url"])              # old stays dead
            self.assertEqual(s, 410)

    # ------------------------------------ 6. sequence snapshot stability
    def test_sequence_snapshot_is_stable_under_delist(self):
        with Gallery() as g:
            lic = g.add_license("公开")
            ids = [g.upload(jpeg_bytes(color=c), lic, title=c)[1]["id"]
                   for c in ("red", "green", "blue", "yellow", "gray")]
            s, _, snap = g.req("POST", "/api/sequence", {})
            self.assertEqual(snap["ids"], ids)
            ver = snap["seq_version"]
            # delist the middle one AFTER the snapshot was taken
            g.admin("POST", f"/api/admin/photos/{ids[2]}/delist")
            s, _, again = g.req("GET", f"/api/sequence/{snap['seq_id']}")
            self.assertEqual(again["ids"], ids)             # positions frozen
            self.assertEqual(again["seq_version"], ver)     # snapshot version
            s, _, d = g.req("GET", f"/api/photos/{ids[2]}/public")
            self.assertEqual(s, 410)                        # tombstone slide
            s, _, _ = g.req("GET", f"/api/photos/{ids[1]}/public")
            self.assertEqual(s, 200)                        # neighbours fine
            # a NEW snapshot no longer contains the delisted id
            s, _, snap2 = g.req("POST", "/api/sequence", {})
            self.assertNotIn(ids[2], snap2["ids"])
            self.assertGreater(snap2["seq_version"], ver)

    # ----------------------- 7. pagination: order, version, stale guard
    def test_pagination_order_version_and_out_of_order_contract(self):
        with Gallery() as g:
            lic = g.add_license("公开")
            for i in range(5):
                g.upload(jpeg_bytes(color="red"), lic, title=f"p{i}")
            s, h, p1 = g.req("GET", "/api/photos?page=1&size=2&request_id=a")
            s2, _, p2 = g.req("GET", "/api/photos?page=2&size=2&request_id=b")
            self.assertEqual(p1["request_id"], "a")     # echo for stale-drop
            self.assertEqual(p2["request_id"], "b")
            self.assertEqual(p1["seq_version"], p2["seq_version"])
            self.assertIn("ETag", h)
            ids1 = [p["id"] for p in p1["items"]]
            ids2 = [p["id"] for p in p2["items"]]
            self.assertFalse(set(ids1) & set(ids2))     # no overlap
            # reorder bumps the global version -> old pages are stale
            g.admin("POST", "/api/admin/reorder",
                    {"ids": list(reversed(ids1 + ids2))})
            s, _, p3 = g.req("GET", "/api/photos?page=1&size=2")
            self.assertGreater(p3["seq_version"], p1["seq_version"])

    def test_delayed_responses_arrive_out_of_order(self):
        """Server test hook delays request A so B lands first; the echoed
        request_id lets the client drop the late, stale A."""
        with Gallery() as g:
            lic = g.add_license("公开")
            g.upload(jpeg_bytes(), lic)
            g.srv.app.delay_ms["/api/photos"] = 400
            results = {}

            def call(name, delay_first):
                path = ("/api/photos?request_id=" + name +
                        ("&__slow=1" if delay_first else ""))
                if not delay_first:
                    g.srv.app.delay_ms["/api/photos"] = 0
                results[name] = g.req("GET", path)[2]

            t1 = threading.Thread(target=call, args=("slow", True))
            t1.start()
            time.sleep(0.05)
            call("fast", False)
            t1.join()
            self.assertEqual(results["fast"]["request_id"], "fast")
            self.assertEqual(results["slow"]["request_id"], "slow")
            # client-side dropping of the late response is covered by
            # tests/test_frontend_logic.mjs (RequestSequencer)

    # ------------------------------------ 8. network interruption hook
    def test_flaky_endpoint_recovers_after_retries(self):
        with Gallery() as g:
            g.req("GET", "/__flaky_reset?key=net&fail=2")
            codes = [g.req("GET", "/__flaky?key=net")[0] for _ in range(3)]
            self.assertEqual(codes, [500, 500, 200])
            # the JS retryingFetch wrapper is verified in the node tests

    # -------------------------------------------- 9. pixel budget guard
    def test_oversized_source_rejected_by_budget(self):
        with Gallery() as g:
            lic = g.add_license("公开")
            old = variants_mod.MAX_SRC_PIXELS
            variants_mod.MAX_SRC_PIXELS = 100_000      # 800x600 = 480k > budget
            try:
                s, d = g.upload(jpeg_bytes(), lic)
            finally:
                variants_mod.MAX_SRC_PIXELS = old
            self.assertEqual(s, 413)
            self.assertIn("budget", d["error"])

    # ------------------------------ 10. generation saturation -> 503
    def test_ondemand_generation_saturated_returns_retry_after(self):
        with Gallery() as g:
            lic = g.add_license("公开")
            _, d = g.upload(jpeg_bytes(), lic)
            pid = d["id"]
            g.wait_variant(pid)                        # pregen done
            # simulate a missing variant + a fully busy generator
            g.srv.app.db._x("DELETE FROM variants WHERE photo_id=? AND kind='large'",
                            (pid,))
            g.srv.app.pipeline._sem.acquire()          # 1 of 2 slots
            g.srv.app.pipeline._sem.acquire()          # 2 of 2 -> saturated
            try:
                s, h, d2 = g.req("GET", f"/api/variant/{pid}/large")
                self.assertEqual(s, 503)
                self.assertEqual(d2["error"], "generator_busy")
                self.assertIn("Retry-After", h)
            finally:
                g.srv.app.pipeline._sem.release()
                g.srv.app.pipeline._sem.release()

    # ------------------------------ 11. generation failure -> fallback
    def test_failed_generation_marks_variant_and_client_has_placeholder(self):
        with Gallery() as g:
            lic = g.add_license("公开")
            _, d = g.upload(jpeg_bytes(), lic)
            pid = d["id"]
            g.wait_variant(pid)
            g.srv.app.db._x("DELETE FROM variants WHERE photo_id=? AND kind='large'",
                            (pid,))

            def boom(*a, **k):
                raise RuntimeError("convert exploded")
            g.srv.app.pipeline._convert = boom
            s, h, d2 = g.req("GET", f"/api/variant/{pid}/large")
            self.assertEqual((s, d2["error"]), (503, "generation_failed"))
            self.assertIn("Retry-After", h)
            row = g.srv.app.db.get_variant(pid, "large")
            self.assertEqual(row["status"], "failed")
            # the client-side fallback asset exists
            s, h, _ = g.req("GET", "/web/static/placeholder.svg", raw=True)
            self.assertEqual(s, 200)
            self.assertIn("image/svg", h["Content-Type"])

    # -------------------------------------------- 12. cache discipline
    def test_cache_headers_and_history_safe_fields(self):
        with Gallery() as g:
            lic = g.add_license("公开")
            _, d = g.upload(jpeg_bytes(), lic)
            pid = d["id"]
            v = g.wait_variant(pid)
            _, h, _ = g.req("GET", v["url"])
            self.assertEqual(h["Cache-Control"],
                             "public, max-age=31536000, immutable")
            _, h, _ = g.req("GET", "/api/photos")
            self.assertEqual(h["Cache-Control"], "no-cache")
            _, h, body = g.req("GET", f"/api/photos/{pid}/public")
            # public payload carries only public-safe fields
            self.assertEqual(
                set(body), {"id", "title", "description", "category_id",
                            "license", "width", "height", "variants",
                            "seq_version"})

    # ------------------------------------------------- 13. auth guard
    def test_admin_endpoints_require_token(self):
        with Gallery() as g:
            s, _, _ = g.req("GET", "/api/admin/photos")
            self.assertEqual(s, 401)
            s, _, _ = g.req("POST", "/api/admin/licenses/1/revoke")
            self.assertEqual(s, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
