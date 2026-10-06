#!/usr/bin/env python3
"""Start the gallery server:  python3 run.py [--port 8080] [--data data]"""
import argparse
from server.app import make_server

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--data", default="data")
    a = p.parse_args()
    srv = make_server(a.data, a.host, a.port)
    print(f"gallery on http://{a.host}:{a.port}  (admin: /admin, "
          f"token env PHOTOS_ADMIN_TOKEN)")
    srv.serve_forever()
