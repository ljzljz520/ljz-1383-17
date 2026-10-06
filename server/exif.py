"""Minimal, dependency-free EXIF parser (JPEG APP1 / TIFF) plus a fixture
writer used by tests to build JPEGs that really carry GPS EXIF.

Only what the gallery needs:
  IFD0: Make(0x010F) Model(0x0110) Orientation(0x0112)
  ExifIFD(0x8769): DateTimeOriginal(0x9003)
  GpsIFD(0x8825): lat/lon/alt
GPS is treated as PRIVATE metadata: it is stored in the DB but never
exposed by public endpoints and never copied into generated variants
(variants are produced with `convert -strip`).
"""
import struct

TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}


def _read_ifd(buf, off, endian):
    if off <= 0 or off + 2 > len(buf):
        return {}
    (count,) = struct.unpack_from(endian + "H", buf, off)
    tags = {}
    for i in range(count):
        e = off + 2 + i * 12
        if e + 12 > len(buf):
            break
        tag, typ, num = struct.unpack_from(endian + "HHI", buf, e)
        size = TYPE_SIZES.get(typ, 1) * num
        raw = buf[e + 8:e + 12] if size <= 4 else None
        if raw is None:
            (voff,) = struct.unpack_from(endian + "I", buf, e + 8)
            raw = buf[voff:voff + size] if 0 <= voff <= len(buf) else b""
        tags[tag] = (typ, num, raw)
    return tags


def _vals(typ, num, raw, endian):
    if typ == 2:
        return raw.rstrip(b"\x00").decode("ascii", "replace")
    if typ == 3:
        return struct.unpack_from(endian + "H" * num, raw, 0)
    if typ == 4:
        return struct.unpack_from(endian + "I" * num, raw, 0)
    if typ == 5:
        out = []
        for i in range(num):
            n, d = struct.unpack_from(endian + "II", raw, i * 8)
            out.append(n / d if d else 0.0)
        return tuple(out)
    return raw


def _dms_to_deg(v, ref):
    deg = v[0] + v[1] / 60.0 + v[2] / 3600.0
    return -deg if ref in ("S", "W") else deg


def parse_exif(jpeg_bytes):
    """Return dict of EXIF fields found in a JPEG byte string (may be empty)."""
    if len(jpeg_bytes) < 4 or jpeg_bytes[:2] != b"\xff\xd8":
        return {}
    pos, app1 = 2, None
    while pos + 4 <= len(jpeg_bytes):
        if jpeg_bytes[pos] != 0xFF:
            break
        marker = jpeg_bytes[pos + 1]
        if marker in (0xDA, 0xD9):  # SOS / EOI
            break
        (seglen,) = struct.unpack_from(">H", jpeg_bytes, pos + 2)
        if marker == 0xE1 and jpeg_bytes[pos + 4:pos + 10] == b"Exif\x00\x00":
            app1 = jpeg_bytes[pos + 10:pos + 2 + seglen]
            break
        pos += 2 + seglen
    if not app1 or len(app1) < 8:
        return {}
    endian = "<" if app1[:2] == b"II" else ">"
    ifd0_off = struct.unpack_from(endian + "I", app1, 4)[0]
    ifd0 = _read_ifd(app1, ifd0_off, endian)
    out = {}

    def take(tags, tag):
        t = tags.get(tag)
        return _vals(t[0], t[1], t[2], endian) if t else None

    for tag, name in ((0x010F, "make"), (0x0110, "model")):
        v = take(ifd0, tag)
        if v:
            out[name] = v
    v = take(ifd0, 0x0112)
    if v:
        out["orientation"] = v[0]
    exif_ptr = take(ifd0, 0x8769)
    if exif_ptr:
        exif_ifd = _read_ifd(app1, exif_ptr[0], endian)
        dto = take(exif_ifd, 0x9003)
        if dto:
            out["datetime_original"] = dto
    gps_ptr = take(ifd0, 0x8825)
    if gps_ptr:
        gps = _read_ifd(app1, gps_ptr[0], endian)
        lat, lat_ref = take(gps, 0x01), take(gps, 0x00)
        lon, lon_ref = take(gps, 0x03), take(gps, 0x02)
        if lat and lon:
            out["gps"] = {
                "lat": round(_dms_to_deg(lat, lat_ref or "N"), 6),
                "lon": round(_dms_to_deg(lon, lon_ref or "E"), 6),
            }
        alt = take(gps, 0x05)
        if alt and "gps" in out:
            out["gps"]["alt"] = round(alt[0], 1)
    return out


# ---------------------------------------------------------------- fixtures
def build_gps_exif_segment(lat=39.9042, lon=116.4074, make=b"TestCam"):
    """Build a real APP1 Exif segment carrying GPS (used by tests)."""
    e = "<"

    def rational(v):
        d = int(round(v * 10000)) or 1
        return struct.pack(e + "II", d, 10000)

    def dms(deg):
        deg = abs(deg)
        d, rem = int(deg), (deg - int(deg)) * 60
        m, s = int(rem), (rem - int(rem)) * 60
        return rational(d) + rational(m) + rational(s)

    lat_ref = b"N\x00" if lat >= 0 else b"S\x00"
    lon_ref = b"E\x00" if lon >= 0 else b"W\x00"
    # Layout: header(8) IFD0 GPS-IFD data-area
    ifd0_entries, gps_entries, data = [], [], b""
    data_base = 8 + 2 + 3 * 12 + 4 + 2 + 6 * 12 + 4

    def ext(blob):
        nonlocal data
        off = data_base + len(data)
        data += blob
        return off

    gps_off = 8 + 2 + 3 * 12 + 4
    ifd0_entries.append((0x010F, 2, len(make) + 1, ext(make + b"\x00")))
    ifd0_entries.append((0x0112, 3, 1, 1))
    ifd0_entries.append((0x8825, 4, 1, gps_off))
    gps_entries.append((0x00, 2, 2, None))  # placeholder, inline
    gps_entries.append((0x01, 5, 3, ext(dms(lat))))
    gps_entries.append((0x02, 2, 2, None))
    gps_entries.append((0x03, 5, 3, ext(dms(lon))))
    gps_entries.append((0x04, 1, 1, 0))
    gps_entries.append((0x05, 5, 1, ext(rational(50.0))))

    def pack_ifd(entries, inline_fix=None):
        out = struct.pack(e + "H", len(entries))
        for tag, typ, num, val in sorted(entries):
            if typ == 2 and isinstance(val, type(None)):
                blob = lat_ref if tag == 0x00 else lon_ref
                out += struct.pack(e + "HHI", tag, typ, num) + blob.ljust(4, b"\x00")
            elif typ in (1, 3) and isinstance(val, int):
                out += struct.pack(e + "HHI", tag, typ, num) + struct.pack(e + "H", val) + b"\x00\x00"
            else:
                out += struct.pack(e + "HHII", tag, typ, num, val)
        return out + struct.pack(e + "I", 0)

    tiff = b"II" + struct.pack(e + "HI", 42, 8)
    tiff += pack_ifd(ifd0_entries)
    tiff += pack_ifd(gps_entries)
    tiff += data
    seg = b"Exif\x00\x00" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(seg) + 2) + seg


def inject_exif(jpeg_bytes, app1_segment):
    """Insert an APP1 segment right after SOI."""
    assert jpeg_bytes[:2] == b"\xff\xd8"
    return jpeg_bytes[:2] + app1_segment + jpeg_bytes[2:]
