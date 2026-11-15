#!/usr/bin/env python3
"""Serve a directory on this computer for a look at the page, with caching off.

    python3 scripts/serve.py site 8791

A browser keeps script modules it has fetched; with caching off, a reload shows
what is on disk. localhost counts as a secure address, so Web Serial works.
"""
import functools
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    directory = sys.argv[1] if len(sys.argv) > 1 else "site"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8791
    handler = functools.partial(Handler, directory=directory)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print("http://localhost:%d/  (pretend boards: http://localhost:%d/?demo)" % (port, port), flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
