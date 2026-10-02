#!/usr/bin/python3
"""Update one registered DuckDNS name without putting its account token in logs or argv."""

import json
import re
import stat
import sys
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        # Never forward the credential-bearing URL through a redirect.
        return None


def update():
    path = Path('/etc/wareongo-sales-bot/duckdns.json')
    metadata = path.stat()
    if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise ValueError('DNS credentials must be owned by root with mode 0600')
    settings = json.loads(path.read_text())
    domain = settings['domain']
    token = settings['token']
    if not isinstance(domain, str) or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', domain):
        raise ValueError('Configure one registered DuckDNS label, without the suffix')
    if not isinstance(token, str) or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', token):
        raise ValueError('Invalid DuckDNS token format')

    # An empty ip asks DuckDNS to use this instance's outbound public IPv4 address.
    query = urlencode({'domains': domain, 'token': token, 'ip': ''})
    request = Request('https://www.duckdns.org/update?' + query)
    with build_opener(NoRedirect).open(request, timeout=20) as response:
        if response.status != 200 or response.read(64).strip() != b'OK':
            raise RuntimeError('DuckDNS rejected the update')


if __name__ == '__main__':
    try:
        update()
    except Exception:
        # HTTP exceptions can contain the credential-bearing URL. Never print them.
        print('DuckDNS update failed; check DNS credentials, file permissions and network access.', file=sys.stderr)
        sys.exit(1)
    print('DuckDNS update succeeded.')
