#!/usr/bin/env python3
"""Build an allowlisted, subpath-safe Pages artifact using only the standard library."""
import hashlib
from html import escape, unescape
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import re
import shutil
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'
FILES = (
    'index.html', 'genealogy.html', 'sources.html',
    'atlas-config.js', 'atlas-api.js', 'personal-data.js', 'personal-data.css',
    'atlas.js', 'atlas.css', 'geo-data.js', 'history-data.js', 'map-data.js',
    'territory-edits.js', 'territory-editor.js', 'place-manager.js',
    'character-manager.js', 'formation-manager.js', 'place-periods.js',
    'review-data.js', 'genealogy-data.js', 'genealogy-client.js', 'genealogy.js', 'genealogy.css',
    'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/LEAFLET-LICENSE.txt',
    'vendor/polygon-clipping.umd.min.js', 'vendor/POLYGON-CLIPPING-LICENSE.txt',
    'vendor/images/layers.png', 'vendor/images/layers-2x.png',
    'vendor/images/marker-icon.png', 'vendor/images/marker-icon-2x.png',
    'vendor/images/marker-shadow.png',
)
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
ATTRIBUTES = re.compile(r'(?P<prefix>(?<![\w:-])(?:src|href)\s*=\s*)(?P<quote>[\"\x27])(?P<url>[^\"\x27]+)(?P=quote)')


def local_resource(url, owner):
    parts = urlsplit(unescape(url))
    if parts.scheme or parts.netloc or not parts.path:
        return None
    path = unquote(parts.path)
    if path.startswith('/') or '\\' in path or '\x00' in path:
        raise ValueError(f'Origin-root or invalid reference in {owner}: {url}')
    relative = PurePosixPath(owner).parent / path
    if '..' in relative.parts:
        raise ValueError(f'Parent-directory reference in {owner}: {url}')
    name = str(relative)
    if name not in FILES:
        raise ValueError(f'Non-allowlisted reference in {owner}: {url}')
    return name


class References(HTMLParser):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ('src', 'href') and value:
                local_resource(value, self.owner)


def version_html(text, owner, hashes):
    def replace(match):
        original = unescape(match.group('url'))
        name = local_resource(original, owner)
        if name is None or name.endswith('.html'):
            return match.group(0)
        parts = urlsplit(original)
        query = [(key, value) for key, value in parse_qsl(parts.query) if key != 'v']
        query.append(('v', hashes[name][:16]))
        url = urlunsplit(('', '', parts.path, urlencode(query), parts.fragment))
        return match.group('prefix') + match.group('quote') + escape(url, quote=True) + match.group('quote')
    return ATTRIBUTES.sub(replace, text)


def main():
    payloads = {}
    for name in FILES:
        source = ROOT / name
        if any(parent.is_symlink() for parent in (source, *source.parents)):
            raise ValueError(f'Symlinks cannot be published: {name}')
        content = source.read_bytes()
        if len(content) > MAX_FILE_BYTES:
            raise ValueError(f'Asset exceeds 16 MiB: {name}')
        payloads[name] = content
    config = payloads['atlas-config.js'].decode('utf-8')
    if not re.search(r"mode\s*:\s*['\"]personal['\"]", config) or re.search(r"mode\s*:\s*['\"]shared['\"]", config):
        raise ValueError('The static configuration must default to personal mode.')
    geo = json.loads(payloads['geo-data.js'].decode('utf-8').split('=', 1)[1].strip().rstrip(';'))
    if geo.get('terrain') or geo.get('historicalTileUrl'):
        raise ValueError('Run scripts/prepare_publication.py to remove undistributed optional imagery.')
    catalog = json.loads(payloads['map-data.js'].decode('utf-8').split('=', 1)[1].strip().rstrip(';'))
    if any('file' in item or 'image' in item for item in catalog):
        raise ValueError('The map catalog must contain source links, not scan references.')
    hashes = {name: hashlib.sha256(content).hexdigest() for name, content in payloads.items()}
    for name, content in list(payloads.items()):
        if name.endswith('.html'):
            text = content.decode('utf-8')
            References(name).feed(text)
            payloads[name] = version_html(text, name, hashes).encode('utf-8')
        elif name.endswith('.css'):
            for match in re.finditer(r'url\(\s*([\"\x27]?)(.*?)\1\s*\)', content.decode('utf-8')):
                local_resource(match.group(2), name)
    payloads['.nojekyll'] = b''
    total = sum(map(len, payloads.values()))
    if total > MAX_TOTAL_BYTES:
        raise ValueError('Artifact exceeds the 32 MiB publication budget.')
    report = {
        'format': 'tongjian-atlas-pages-build', 'version': 1,
        'totalBytesExcludingReport': total,
        'fileCountExcludingReport': len(payloads),
        'files': [{'path': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
                  for name, content in sorted(payloads.items())],
        'excluded': ['Python and source-only tools', 'private user saves and exports',
                     'original maps and OCR', 'biography extracts and genealogy index',
                     'original audit reports', 'terrain imagery and remote historical tiles'],
    }
    payloads['build-report.json'] = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if DIST.is_symlink():
        raise ValueError('Refusing to replace a symlinked dist directory.')
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    for name, content in payloads.items():
        destination = DIST / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    print(f'Pages: {len(payloads)} files, {sum(map(len, payloads.values())):,} bytes -> dist/')
    print('Resource hashes and exclusions: dist/build-report.json')


if __name__ == '__main__':
    main()
