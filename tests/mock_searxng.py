from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from urllib.parse import parse_qs, urlparse

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query).get("q", [""])[0]
        if urlparse(self.path).path != "/search":
            self.send_response(404)
            self.end_headers()
            return
        payload = {
            "results": [
                {
                    "title": f"Result for {query}",
                    "url": "https://example.org/docs?utm_source=test#section",
                    "content": "A deterministic fixture result.",
                },
                {
                    "title": "Second result",
                    "url": "https://example.net/guide",
                    "content": "Another fixture result.",
                },
            ]
        }
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 18080), Handler).serve_forever()
