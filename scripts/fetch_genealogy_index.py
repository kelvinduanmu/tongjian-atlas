#!/usr/bin/env python3
"""Explicit, bounded local-only acquisition of the optional genealogy name index."""
import argparse
from collections import deque
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import time
import unicodedata
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

HOST = 'famous.usatour.com.cn'
BASE = 'http://' + HOST
PAGE = re.compile(r'/celebrity/cd_(?:jinchao|nanbeichao|sanguo)\d*\.html')
PROFILE = re.compile(r'/history/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_()\-]+\.html')
MAX_BYTES = 2 * 1024 * 1024


def allowed_url(value, base, pattern):
    parts = urlsplit(urljoin(base, value))
    if parts.scheme != 'http' or parts.netloc != HOST or parts.query or parts.fragment or not pattern.fullmatch(parts.path):
        return None
    return BASE + parts.path


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Source redirected; no redirects followed. Existing index unchanged.')


class IndexHTML(HTMLParser):
    def __init__(self, url):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.pages = []
        self.people = []
        self.title_depth = 0
        self.anchor = None
        self.name = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'div':
            if self.title_depth:
                self.title_depth += 1
            elif attrs.get('id') == 'tctitle':
                self.title_depth = 1
        if tag == 'a':
            href = attrs.get('href', '')
            page = allowed_url(href, self.url, PAGE)
            if page and page not in self.pages:
                self.pages.append(page)
            if self.title_depth:
                self.anchor = allowed_url(href, self.url, PROFILE)
                self.name = []

    def handle_data(self, text):
        if self.anchor:
            self.name.append(text)

    def handle_endtag(self, tag):
        if tag == 'a' and self.anchor:
            name = ''.join(self.name).strip()
            if 1 <= len(name) <= 60 and not any(unicodedata.category(char).startswith('C') or char in '<>\\/' for char in name):
                self.people.append({'name': name, 'url': self.anchor, 'aliases': [], 'identity': name})
            self.anchor = None
            self.name = []
        if tag == 'div' and self.title_depth:
            self.title_depth -= 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--acknowledge-source-terms', action='store_true', help='Confirm you have checked source terms and may acquire the data locally.')
    parser.add_argument('--max-pages', type=int, default=60, help='1–60 pages, fetched sequentially')
    parser.add_argument('--delay', type=float, default=2.0, help='Seconds between requests; minimum 1')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'genealogy-search-index.json')
    args = parser.parse_args()
    if not args.acknowledge_source_terms:
        parser.error('Review the source terms first, then explicitly pass --acknowledge-source-terms. This is not a redistribution permission.')
    if not 1 <= args.max_pages <= 60 or not 1 <= args.delay <= 60:
        parser.error('--max-pages must be 1–60 and --delay must be 1–60 seconds')
    queue = deque(BASE + '/celebrity/cd_' + era + '.html' for era in ('jinchao', 'nanbeichao', 'sanguo'))
    queued = set(queue)
    visited, people = [], {}
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        while queue and len(visited) < args.max_pages:
            if visited:
                time.sleep(args.delay)
            url = queue.popleft()
            request = Request(url, headers={'User-Agent': 'TongjianAtlas-LocalIndex/1.0', 'Accept': 'text/html'})
            with opener.open(request, timeout=15) as response:
                if response.headers.get_content_type() != 'text/html':
                    raise ValueError('Source did not return HTML')
                body = response.read(MAX_BYTES + 1)
                charset = response.headers.get_content_charset()
            if len(body) > MAX_BYTES:
                raise ValueError('Source page exceeds 2 MiB')
            if not charset:
                match = re.search(br'charset\s*=\s*[\"\x27]?([A-Za-z0-9_-]+)', body[:8192], re.I)
                charset = match.group(1).decode('ascii') if match else 'gb18030'
            if charset.lower() in ('gb2312', 'gbk'):
                charset = 'gb18030'
            page = IndexHTML(url)
            page.feed(body.decode(charset))
            page.close()
            if not page.people:
                raise ValueError('Source markup has no validated div#tctitle profile entries')
            for person in page.people:
                people.setdefault(person['url'], person)
            visited.append(url)
            for target in page.pages:
                if target not in queued:
                    queue.append(target)
                    queued.add(target)
            print(f'{len(visited)}/{args.max_pages}: {len(page.people)} names from {url}', flush=True)
        document = {'schemaVersion': 1, 'retrievedAt': datetime.now(timezone.utc).isoformat(),
                    'source': {'title': '博雅人物 · 时代名录', 'url': BASE, 'pages': visited},
                    'notice': '个人本地索引；仅姓名与已发现来源链接，不含传记摘录。来源分类可能有误，不保证完整；不授予再分发许可。',
                    'truncated': bool(queue), 'people': list(people.values())}
        encoded = (json.dumps(document, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        if len(encoded) > 16 * 1024 * 1024:
            raise ValueError('Index exceeds provider size limit')
        destination = args.output.expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.genealogy-index-', delete=False) as handle:
                temporary = handle.name
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
        print(f'Saved {len(people)} real names to {destination}; incomplete coverage: {bool(queue)}. Do not publish this local file.')
    except (OSError, ValueError, LookupError) as exc:
        parser.exit(1, f'Acquisition failed; existing index unchanged: {exc}\n')


if __name__ == '__main__':
    main()
