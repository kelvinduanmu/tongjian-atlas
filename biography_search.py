"""Bounded public-reference lookups and query-bound, server-owned biographies."""
from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import secrets
import threading
import time
import unicodedata
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from place_search import Invalid

SOUYUN = 'https://sou-yun.cn/QueryAllusion.aspx'
TRUSTED_BOOKS = frozenset(('中国历代人名大辞典', '中國歷代人名大辭典', '全晋文', '全晉文',
                           '全宋文', '全唐文', '全后汉文', '全後漢文', '全三国文', '全三國文',
                           '全梁文', '全陈文', '全陳文', '全齐文', '全齊文', '全北齐文',
                           '全北齊文', '全后魏文', '全後魏文', '全隋文', '全后周文', '全後周文'))
SOURCE_FIELDS = {'provider', 'title', 'url', 'bookTitle', 'method', 'retrievedAt', 'lookupName', 'notice'}
NOTICE = '原文摘录，非AI撰写；生卒、事件纪年及史料细节未交叉核验。已省略开头生卒数字；〔纪年略〕表示省略句首纪年前言，…表示在未核纪年分句前截断，其余文字保留来源原文，不补写或改换年份。地图位置由用户摆放，不代表历史行踪。'
MAX_REMOTE = 2 * 1024 * 1024
TOKEN_TTL = 3600


def valid_name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 60:
        raise Invalid('人物姓名去除首尾空白后须为1至60字')
    value = value.strip()
    if any(unicodedata.category(char).startswith('C') or char in '<>\\/' for char in value):
        raise Invalid('人物姓名不能包含控制字符或路径符号')
    try:
        value.encode('utf-8')
    except UnicodeError as exc:
        raise Invalid('人物姓名必须为有效UTF-8文字') from exc
    return value


def allowed_source_url(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
            return False
        if parsed.hostname == 'sou-yun.cn':
            return parsed.path == '/QueryAllusion.aspx'
        if parsed.hostname in ('dict.revised.moe.edu.tw', 'dict.concised.moe.edu.tw'):
            return True
        if parsed.hostname == 'github.com':
            return parsed.path == '/g0v/moedict-data' or parsed.path.startswith('/g0v/moedict-data/')
        if parsed.hostname == 'raw.githubusercontent.com':
            return parsed.path.startswith('/g0v/moedict-data/')
    except ValueError:
        return False
    return False


def validate_source(source):
    if source is None:
        return
    if (not isinstance(source, dict) or set(source) != SOURCE_FIELDS
            or any(not isinstance(value, str) or not value or len(value) > 2048 for value in source.values())
            or source['method'] not in ('extractive', 'extractive-cache')
            or not allowed_source_url(source['url'])):
        raise Invalid('人物简介来源字段无效；未重置保存数据')
    try:
        stamp = datetime.fromisoformat(source['retrievedAt'].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError()
        valid_name(source['lookupName'])
    except (ValueError, TypeError) as exc:
        raise Invalid('人物简介来源时间或姓名无效') from exc


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag = tag
        self.attrs = dict(attrs)
        self.children = []

    def text(self):
        return ''.join(child.text() if isinstance(child, Node) else child for child in self.children)

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def has_class(self, name):
        return name in self.attrs.get('class', '').split()


class PeopleHTML(HTMLParser):
    """Small bounded HTML tree; only ResultArea/au_ author blocks are considered."""
    VOID = frozenset(('area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'))

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            if len(self.stack) >= 100:
                raise Invalid('资料页面嵌套异常')
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if not any(node.tag in ('script', 'style') for node in self.stack):
            self.stack[-1].children.append(data)

    def entries(self):
        results = [node for node in self.root.walk() if node.attrs.get('id') == 'ResultArea']
        author_aliases = {}
        alias_labels = {'庙号', '廟號', '谥号', '謚號', '諡號', '世称', '世稱', '字', '一字',
                        '初字', '名', '本名', '原名', '初名', '号', '號', '别号', '別號'}
        for panel in (node for node in self.root.walk() if node.attrs.get('id') == 'SummaryPanel'):
            for link in panel.walk():
                match = re.fullmatch(r'javascript:\s*DisplayAuthorOnly\((\d+)\);?', link.attrs.get('href', ''))
                if link.tag != 'a' or match is None:
                    continue
                # These names explicitly point at one author block. Never collect
                # names from search snippets, dynasty labels, or other biographies.
                names = re.split(r'[\s、，,（）()：:；;]+', link.text().strip())
                author_aliases['au_' + match.group(1)] = [name for name in names
                                                        if 1 <= len(name) <= 60 and name not in alias_labels]
        entries = []
        for result in results:
            for block in result.walk():
                if block.tag != 'div' or not block.attrs.get('id', '').startswith('au_'):
                    continue
                header = next((node for node in block.walk() if node.has_class('authorHeader')), None)
                if header is None:
                    continue
                author = next((node for node in header.walk() if node.tag == 'a'
                               and re.search(r'(?:^|/)People/', node.attrs.get('href', ''))), None)
                if author is None:
                    continue
                title = author.text().strip()
                if not title or len(title) > 60:
                    continue
                # Resource-count links are not part of a person's identity.
                identity = ''.join(child.text() if isinstance(child, Node) else child
                                   for child in header.children
                                   if not isinstance(child, Node) or not child.has_class('resourceSummary')).strip()[:300]
                aliases = [name for name in author_aliases.get(block.attrs['id'], []) if name != title]
                if aliases:
                    identity = (identity + ' / 别名：' + '、'.join(aliases))[:300]
                book = ''
                for node in block.walk():
                    if node.tag == 'span' and node.has_class('label'):
                        book = node.text().strip()
                    elif node.tag == 'blockquote' and node.has_class('quote1') and book in TRUSTED_BOOKS:
                        text = node.text().strip()
                        if text:
                            entries.append({'title': title, 'identity': identity, 'bookTitle': book,
                                            'text': text, 'personId': block.attrs['id'], 'aliases': aliases})
        return entries


def short_extract(text):
    """Select complete source sentences, removing only categorical/date prefixes."""
    text = text.strip()
    text = re.sub(r'^人名[。．：:]\s*', '', text)
    text = re.sub(r'^【生卒】[：:]?[^\n]*\n\s*', '', text)
    text = re.sub(r'^【介绍】[：:]?\s*', '', text)
    # Do not silently repair suspect source dates (e.g. the MOE's early-Jin dates).
    text = re.sub(r'^[（(]\s*(?:西元|公元|西元前|公元前)?\s*[?？\d][?？\d年\s—－–\-~～至前]*[）)]\s*', '', text)
    text = re.sub(r'^(?:西元|公元)?\s*[?？\d]+\s*[—－–\-~～至]\s*[?？\d]+(?:年)?\s*[，,。．]?\s*', '', text)
    pieces = re.findall(r'[^。！？!?]+[。！？!?]|[^。！？!?]+$', text)
    selected = []
    length = 0
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        # Prefer identity and activities over unverified family genealogy.
        if re.search(r'第[一二三四五六七八九十百\d]+[子女]|之[子女][。！？!?]$', piece):
            continue
        # Keep the original event when its date is only an introductory clause.
        # A date inside a later clause ends the excerpt at the preceding complete
        # clause, visibly marked rather than silently splicing historical claims.
        clauses = re.split(r'(?<=[，,；;])', piece)
        excerpt = []
        for index, clause in enumerate(clauses):
            dated = re.search(r'(?:元|[一二三四五六七八九十百千〇零○两兩\d]+)年|(?:公元|西元)前?\s*\d+', clause)
            if dated is None:
                excerpt.append(clause)
            elif index == 0 and clause[-1:] in ('，', ',', '；', ';') and not clause[dated.end():].strip('，,；; \t\n'):
                excerpt.append('〔纪年略〕')
            else:
                preserved = ''.join(excerpt).rstrip('，,；; \t\n')
                excerpt = [preserved + '…'] if preserved and preserved != '〔纪年略〕' else []
                break
        piece = ''.join(excerpt)
        if not piece or piece == '〔纪年略〕':
            continue
        if selected and length + len(piece) > 300:
            break
        if length + len(piece) > 500:
            break
        selected.append(piece)
        length += len(piece)
        if length >= 220:
            break
    return ''.join(selected)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Invalid('资料源返回重定向；未跟随到登录页或其他站点')


class BiographySearch:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.RLock()
        self.network = threading.Lock()
        self.tokens = OrderedDict()
        self.queries = OrderedDict()
        self.cooldown_until = 0.0
        self.next_request = 0.0
        self.characters = self._load('biography-normalization.json').get('characters', {})
        if not isinstance(self.characters, dict):
            self.characters = {}
        self.translation = str.maketrans({key: value for key, value in self.characters.items()
                                         if isinstance(key, str) and len(key) == 1 and isinstance(value, str)})
        self.reference = self._load('biography-reference.json')
        self.reference_index = {}
        for entry in self.reference.get('entries', []):
            if isinstance(entry, dict) and isinstance(entry.get('title'), str):
                self.reference_index.setdefault(self.normalize(entry['title']), []).append(entry)
        self.seeds = {}
        for item in self._load('biography-seed.json').get('queries', []):
            if not isinstance(item, dict) or not isinstance(item.get('name'), str):
                continue
            names = {self.normalize(item['name'])}
            for entry in item.get('entries', []):
                if not isinstance(entry, dict) or not isinstance(entry.get('title'), str):
                    continue
                names.add(self.normalize(entry['title']))
                aliases = entry.get('aliases', [])
                if isinstance(aliases, list):
                    names.update(self.normalize(alias) for alias in aliases if isinstance(alias, str) and alias.strip())
            for name in names:
                self.seeds.setdefault(name, []).append(item)

    def _load(self, filename):
        try:
            path = self.directory / filename
            if path.stat().st_size > 16 * 1024 * 1024:
                return {}
            data = json.loads(path.read_text(encoding='utf-8'))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError, UnicodeError):
            return {}

    def normalize(self, text):
        return ''.join(unicodedata.normalize('NFKC', text).translate(self.translation).split()).casefold()

    def _matches(self, query, entry):
        if self.normalize(entry['title']) == query:
            return True
        # Only explicitly attributed author aliases qualify; an era, date, or
        # another person's name mentioned in the prose is not an alias.
        aliases = entry.get('aliases', [])
        if isinstance(aliases, list) and any(isinstance(alias, str) and self.normalize(alias) == query
                                            for alias in aliases):
            return True
        # A dictionary's opening “即某某。” is an identity assertion, not an
        # incidental name appearing later in the historical narrative.
        opening = re.sub(r'^【生卒】[：:]?[^\n]*\n\s*', '', entry['text'].strip())
        opening = re.sub(r'^【介绍】[：:]?\s*', '', opening)
        identity = re.match(r'^即([\u3400-\u9fff]{2,20})[。．]', opening)
        return identity is not None and self.normalize(identity.group(1)) == query

    def _candidates(self, entries, name, source_url, retrieved_at, cached, provider='搜韵', source_title='搜韵人物资料'):
        if not allowed_source_url(source_url):
            return []
        result = []
        seen = set()
        for entry in entries:
            if (not isinstance(entry, dict) or not all(isinstance(entry.get(key), str)
                    for key in ('title', 'text', 'bookTitle')) or not self._matches(self.normalize(name), entry)):
                continue
            if provider == '搜韵' and entry['bookTitle'] not in TRUSTED_BOOKS:
                continue
            summary = short_extract(entry['text'])
            if not summary:
                continue
            person = entry.get('personId') or (entry['title'], entry.get('identity', ''))
            if person in seen:
                continue
            source = {'provider': provider, 'title': source_title, 'url': source_url,
                      'bookTitle': entry['bookTitle'], 'method': 'extractive-cache' if cached else 'extractive',
                      'retrievedAt': retrieved_at, 'lookupName': name, 'notice': NOTICE}
            try:
                validate_source(source)
            except Invalid:
                continue
            result.append({'title': entry['title'], 'identity': entry.get('identity') or entry['title'],
                           'summary': summary, 'source': source})
            seen.add(person)
            if len(result) == 20:
                break
        return result

    def _dictionary(self, name):
        source = self.reference.get('source', {})
        if not isinstance(source, dict):
            return []
        rows = []
        for entry in self.reference_index.get(self.normalize(name), []):
            for index, definition in enumerate(entry.get('definitions', [])):
                if not isinstance(definition, str) or not re.match(r'^\s*人名[。．：:]', definition):
                    continue
                identity = short_extract(definition).split('。', 1)[0]
                rows.append({'title': entry['title'], 'identity': entry['title'] + ' / ' + identity,
                             'personId': entry['title'] + ':' + str(index),
                             'text': definition, 'bookTitle': source.get('title', '教育部重編國語辭典修訂本')})
        candidates = self._candidates(rows, name, source.get('url', ''), source.get('retrievedAt', ''), True,
                                      provider=source.get('provider', '教育部辞典'), source_title=source.get('title', '教育部辞典'))
        license_text = source.get('license')
        if isinstance(license_text, str):
            for candidate in candidates:
                candidate['source']['notice'] += ' ' + license_text[:1000]
        return candidates

    def _retry_delay(self, value):
        try:
            delay = float(value)
        except (TypeError, ValueError):
            try:
                delay = parsedate_to_datetime(value).timestamp() - time.time()
            except (TypeError, ValueError, OverflowError):
                delay = 900
        return max(900, delay) if delay < float('inf') else 86400

    def _online(self, name):
        # A single process-wide gate protects the only upstream; no queued retries.
        if not self.network.acquire(blocking=False):
            return [], ['人物资料源正在查询其他姓名，请稍后重试。']
        try:
            now = time.monotonic()
            if now < self.cooldown_until:
                seconds = max(1, int(self.cooldown_until - now))
                return [], [f'搜韵请求受限，冷却尚余约{seconds}秒；未继续请求上游，可稍后重试。']
            if now < self.next_request:
                return [], ['人物资料查询间隔至少5秒，请稍后重试。']
            self.next_request = now + 5
            url = SOUYUN + '?' + urlencode({'key': name, 'type': 'Others'})
            request = Request(url, headers={'User-Agent': 'EasternJinAtlas/1.0 (public biographical excerpts)',
                                            'Accept': 'text/html', 'Accept-Encoding': 'identity'})
            try:
                with build_opener(NoRedirect()).open(request, timeout=7) as response:
                    body = response.read(MAX_REMOTE + 1)
                    if len(body) > MAX_REMOTE:
                        raise Invalid('人物资料页面过大，未采用')
                    html = body.decode(response.headers.get_content_charset() or 'utf-8', errors='strict')
                parser = PeopleHTML()
                parser.feed(html)
                parser.close()
                stamp = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
                result = self._candidates(parser.entries(), name, url, stamp, False)
                return result, [] if result else ['搜韵未返回可确认身份且含可靠短传的匹配人物。']
            except HTTPError as exc:
                if exc.code == 429:
                    self.cooldown_until = time.monotonic() + self._retry_delay(exc.headers.get('Retry-After'))
                    return [], ['搜韵返回429（请求过多），已停止请求并进入至少15分钟冷却；请稍后重试。']
                if exc.code in (403, 503):
                    self.cooldown_until = time.monotonic() + 900
                return [], [f'搜韵暂不可用（HTTP {exc.code}）；未生成无来源简介，请稍后重试。']
            except (OSError, ValueError, LookupError, RecursionError):
                return [], ['搜韵查询失败、超时或页面格式不适用；未生成无来源简介，请稍后重试。']
        finally:
            self.network.release()

    def search(self, params):
        if not isinstance(params, dict) or set(params) != {'name'}:
            raise Invalid('人物简介查询仅接受name参数')
        name = valid_name(params['name'])
        key = self.normalize(name)
        warnings = []
        with self.lock:
            now = time.monotonic()
            cached = self.queries.get(key)
            if cached and cached[0] > now:
                candidates = deepcopy(cached[1])
                warnings = list(cached[2])
                for candidate in candidates:
                    candidate['source']['method'] = 'extractive-cache'
                warnings.append('采用最近查询缓存；出处时间为实际资料获取时间。')
            else:
                candidates = None
        if candidates is None:
            seeds = sorted(self.seeds.get(key, []), key=lambda item: self.normalize(item['name']) != key)
            candidates, seen = [], set()
            for seed in seeds:
                rows = self._candidates(seed.get('entries', []), name, seed.get('sourceUrl', ''),
                                        seed.get('retrievedAt', ''), True)
                for candidate in rows:
                    identity = (candidate['title'], candidate['identity'], candidate['summary'])
                    if identity not in seen:
                        candidates.append(candidate)
                        seen.add(identity)
                if len(candidates) >= 20:
                    candidates = candidates[:20]
                    break
            if candidates:
                warnings.append('采用已联网获取的搜韵资料缓存，并非刚刚联网；请查看来源获取时间。')
            else:
                candidates, warnings = self._online(name)
                if not candidates:
                    candidates = self._dictionary(name)
                    if candidates:
                        warnings.append('搜韵未提供可用结果，改用公开教育部辞典资料缓存；保留繁体原文，非本次实时联网。')
            with self.lock:
                self.queries[key] = (time.monotonic() + (3600 if candidates else 5), deepcopy(candidates), tuple(warnings))
                self.queries.move_to_end(key)
                while len(self.queries) > 256:
                    self.queries.popitem(last=False)
        if not candidates:
            warnings.append('没有找到可确认身份的可靠人物简介；不会编造人物。请核对姓名后重试。')
        result = []
        with self.lock:
            now = time.monotonic()
            self._expire(now)
            # Do not evict unexpired tokens: returned candidates remain valid for a full hour.
            if len(self.tokens) + len(candidates) > 4000:
                raise Invalid('人物候选缓存已满，请稍后重试；已发出的候选仍可保存')
            for candidate in candidates:
                candidate['source']['lookupName'] = name
                identifier = secrets.token_urlsafe(24)
                self.tokens[identifier] = (now + TOKEN_TTL, key, deepcopy(candidate))
                result.append(dict(candidate, candidateId=identifier))
        return {'query': name, 'candidates': result, 'warnings': list(dict.fromkeys(warnings))}

    def _expire(self, now):
        while self.tokens and next(iter(self.tokens.values()))[0] <= now:
            self.tokens.popitem(last=False)

    def resolve(self, identifier, name):
        if not isinstance(identifier, str) or not 1 <= len(identifier) <= 100:
            raise Invalid('请先获取并确认人物简介，再保存')
        with self.lock:
            self._expire(time.monotonic())
            cached = self.tokens.get(identifier)
            if cached is None:
                raise Invalid('人物简介候选已过期或服务器已重启，请重新获取并确认')
            if cached[1] != self.normalize(valid_name(name)):
                raise Invalid('人物姓名已改变，请重新获取并确认该姓名的简介')
            candidate = deepcopy(cached[2])
        validate_source(candidate['source'])
        return candidate
