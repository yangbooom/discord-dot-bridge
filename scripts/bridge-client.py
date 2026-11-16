#!/usr/bin/env python3
"""Single-consumer bridge client. Reads secrets from process environment only."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def configuration(environ):
    base = environ.get("BUM_BRIDGE_URL", "").rstrip("/")
    token = environ.get("BUM_BRIDGE_API_TOKEN", "")
    url = urllib.parse.urlsplit(base)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path or url.port not in (None, 443)):
        raise ValueError("BUM_BRIDGE_URL must be the approved HTTPS Worker origin, without credentials, path or query")
    if len(token) < 32 or token.startswith("REPLACE") or any(c.isspace() for c in token):
        raise ValueError("BUM_BRIDGE_API_TOKEN must come from the approved credential store")
    return base, token


def main():
    if sys.argv[1:] not in ([], ["inbox"], ["reply"]):
        raise ValueError("Usage: bridge-client.py [inbox|reply]; reply JSON is read from stdin")
    base, token = configuration(os.environ)
    operation = sys.argv[1] if len(sys.argv) > 1 else "inbox"
    data = None
    if operation == "reply":
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("reply body exceeds 16 KiB")
        payload = json.loads(raw)
        if not isinstance(payload, dict) or set(payload) != {"messageId", "text"}:
            raise ValueError("reply JSON must contain only messageId and text")
        data = json.dumps(payload, ensure_ascii=False).encode()
    request = urllib.request.Request(
        base + "/v1/" + operation, data=data,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json"},
        method="POST" if data is not None else "GET",
    )
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=90) as response:
            try:
                value = json.load(response)
            except (ValueError, UnicodeError):
                print('{"error":"invalid bridge response; reply delivery may be unknown"}', file=sys.stderr)
                return 1
    except urllib.error.HTTPError as error:
        # Never retry writes automatically and never print headers or credentials.
        print(json.dumps({"error": "bridge HTTP error; inspect channel before retrying a reply", "status": error.code}), file=sys.stderr)
        return 1
    except urllib.error.URLError:
        print('{"error":"network error; reply delivery may be unknown; do not retry blindly"}', file=sys.stderr)
        return 1
    print(json.dumps(value, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, json.JSONDecodeError):
        print('{"error":"invalid client configuration or input; no request sent"}', file=sys.stderr)
        sys.exit(2)
