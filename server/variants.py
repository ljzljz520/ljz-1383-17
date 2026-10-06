"""Variant pipeline. Two delivery strategies share one generator:

* pre-generated  : variants are produced asynchronously at upload time
* on-demand      : GET /api/variant/<photo>/<kind> generates when missing

Both go through generate_variant(), which enforces:
  * a global concurrency limit (semaphore) so ImageMagick cannot exhaust CPU
  * a pixel budget for source and output (decompression-bomb guard)
  * failure bookkeeping -> API 503 + client-side placeholder fallback
"""
import os
import subprocess
import threading

KINDS = {
    "thumb": 320,
    "medium": 1024,
    "large": 2048,
}
MAX_SRC_PIXELS = 60_000_000          # refuse to open anything larger
MAX_VARIANT_PIXELS = 2048 * 2048     # per-output pixel budget
CONCURRENCY = 2                      # simultaneous ImageMagick jobs
GENERATE_TIMEOUT = 30                # seconds per convert run


class BudgetExceeded(Exception):
    pass


class Saturated(Exception):
    """Server is at its generation concurrency limit."""


class VariantPipeline:
    def __init__(self, db, variant_dir, concurrency=CONCURRENCY):
        self.db = db
        self.variant_dir = variant_dir
        os.makedirs(variant_dir, exist_ok=True)
        self._sem = threading.BoundedSemaphore(concurrency)

    # ------------------------------------------------------------ helpers
    @staticmethod
    def identify(path):
        out = subprocess.run(
            ["identify", "-format", "%w %h %m", path + "[0]"],
            capture_output=True, text=True, timeout=15)
        if out.returncode != 0:
            raise RuntimeError("identify failed: " + out.stderr.strip())
        w, h, _fmt = out.stdout.split()[:3]
        return int(w), int(h)

    def _convert(self, src, dst, max_dim):
        subprocess.run(
            ["convert", src + "[0]",
             "-auto-orient",
             "-resize", f"{max_dim}x{max_dim}>",
             "-strip",                      # EXIF (incl. GPS) never leaves origin
             "-interlace", "Plane",
             "-quality", "85", dst],
            check=True, capture_output=True, timeout=GENERATE_TIMEOUT)

    # ------------------------------------------------------------ main API
    def generate_variant(self, photo, kind, src_path, wait=True):
        """Generate (or fetch) variant `kind` for `photo`.

        Returns the variant row dict. Raises BudgetExceeded / Saturated /
        RuntimeError. Marks the variant row failed on error so callers can
        fall back to a placeholder instead of retry-storming."""
        if kind not in KINDS:
            raise ValueError("unknown kind")
        existing = self.db.get_variant(photo["id"], kind)
        if existing and existing["status"] == "ready" \
                and os.path.exists(existing["path"]):
            return existing

        if not self._sem.acquire(blocking=wait):
            raise Saturated()
        try:
            sw, sh = self.identify(src_path)
            if sw * sh > MAX_SRC_PIXELS:
                raise BudgetExceeded(
                    f"source {sw}x{sh} exceeds {MAX_SRC_PIXELS} px budget")
            max_dim = KINDS[kind]
            if max_dim * max_dim > MAX_VARIANT_PIXELS:
                raise BudgetExceeded("variant exceeds pixel budget")

            version = (existing["version"] if existing else 0) + 1
            dst = os.path.join(
                self.variant_dir, f"{photo['id']}_{kind}_v{version}.jpg")
            vid = self.db.add_variant(photo["id"], kind, version,
                                      status="pending", path=dst)
            try:
                self._convert(src_path, dst, max_dim)
                w, h = self.identify(dst)
                self.db.update_variant(vid, width=w, height=h, status="ready")
            except Exception as exc:
                self.db.update_variant(vid, status="failed")
                try:
                    os.unlink(dst)
                except OSError:
                    pass
                raise RuntimeError(f"variant generation failed: {exc}")
            return self.db.get_variant(photo["id"], kind)
        finally:
            self._sem.release()

    def pregenerate(self, photo, src_path, kinds=("thumb", "medium", "large"),
                    on_error=None):
        """Best-effort pre-generation at upload time (async caller)."""
        for kind in kinds:
            try:
                self.generate_variant(photo, kind, src_path)
            except Exception as exc:        # recorded as failed in DB
                if on_error:
                    on_error(kind, exc)
