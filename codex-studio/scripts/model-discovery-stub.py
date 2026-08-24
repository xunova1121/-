"""Tiny local OpenAI-compatible model catalog used by Windows UI smoke tests."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.rstrip("/") != "/v1/models":
            self.send_error(404)
            return
        payload = b'{"data":[{"id":"studio-ui-smoke-chat","name":"Studio UI Smoke Chat"}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 18999), Handler).serve_forever()
