"""Bounded, source-attributed family extraction; never infer kinship from prose."""
from collections import OrderedDict, deque
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import queue
import re
import secrets
import threading
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


NOTICE = '网络二手资料自动整理，未逐条核验'
HOST = 'famous.usatour.com.cn'
BASE = 'http://' + HOST
MAX_BODY = 2 * 1024 * 1024
MAX_PEOPLE = 24
TOKEN_TTL = 1800
CACHE_TTL = 21600
REQUEST_SECONDS = 65
RELATIONS = {'父亲': 'father', '母亲': 'mother', '儿子': 'child', '女儿': 'child'}
VOID = frozenset(('area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'))


class GenealogyError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _identifier(prefix, value):
    return prefix + hashlib.sha256(value.encode('utf-8')).hexdigest()[:24]


def _name(value):
    if not isinstance(value, str) or len(value) > 240 or not 1 <= len(value.strip()) <= 60:
        raise GenealogyError('人物姓名去除首尾空白后须为1至60字')
    value = value.strip()
    if any(unicodedata.category(c).startswith('C') or c in '<>\\/' for c in value):
        raise GenealogyError('人物姓名不能包含控制字符或路径符号')
    return value


def _url(value):
    """Only server-discovered HTTP profile paths, never arbitrary user URLs."""
    if not isinstance(value, str) or len(value) > 300:
        raise GenealogyError('资料链接不在许可范围内', 502)
    absolute = urljoin(BASE + '/', value)
    parts = urlsplit(absolute)
    if (parts.scheme != 'http' or parts.netloc != HOST or parts.query or parts.fragment
            or not re.fullmatch(r'/history/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_()\-]+\.html', parts.path)):
        raise GenealogyError('资料链接不在许可范围内', 502)
    return BASE + parts.path


class _Redirects(HTTPRedirectHandler):
    max_redirections = 3
    max_repeats = 1

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Even a trusted page cannot redirect into a different host or URL class.
        return super().redirect_request(req, fp, code, msg, headers, _url(newurl))


class _Node:
    def __init__(self, tag='', attrs=(), parent=None):
        self.tag = tag
        self.attrs = dict(attrs)
        self.parent = parent
        self.children = []

    def text(self):
        parts = []
        pending = list(reversed(self.children))
        while pending:
            item = pending.pop()
            if isinstance(item, str):
                parts.append(item)
            elif item.tag not in ('script', 'style'):
                pending.extend(reversed(item.children))
        return re.sub(r'\s+', ' ', ''.join(parts)).strip()


class _ProfileHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node()
        self.stack = [self.root]
        self.nodes = []

    def handle_starttag(self, tag, attrs):
        if len(self.nodes) >= 30000 or len(self.stack) > 256:
            raise GenealogyError('资料页面结构超出安全上限', 502)
        node = _Node(tag, attrs, self.stack[-1])
        self.nodes.append(node)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def extract(self, url):
        headings = [node.text() for node in self.nodes if node.tag == 'h1']
        if len(headings) != 1:
            raise GenealogyError('资料页缺少唯一人物标题，可能为空页或验证页', 502)
        try:
            name = _name(headings[0])
        except GenealogyError as exc:
            raise GenealogyError('资料页人物标题无效', 502) from exc
        descriptions = [node.attrs.get('content', '').strip() for node in self.nodes
                        if node.tag == 'meta' and node.attrs.get('name', '').lower() == 'description']
        intro = next((text for text in descriptions if text.startswith(name) and len(text) > len(name) + 10), '')
        if not intro:
            intro = next((node.text() for node in self.nodes if node.tag == 'p'
                          and node.text().startswith(name) and len(node.text()) > len(name) + 10), '')
        if not intro:
            raise GenealogyError('资料页没有与人物标题匹配的正文，未采用', 502)
        title = next((node.text() for node in self.nodes if node.tag == 'title'), name)
        markers = [node for node in self.nodes if node.tag == 'strong' and node.text() in ('人物关系：', '人物关系:')]
        warnings = []
        relations = []
        if len(markers) > 1:
            warnings.append('人物关系栏目不唯一，已跳过歧义栏目。')
        elif markers:
            marker = markers[0]
            if marker.parent.attrs.get('id') == 'rengx':
                marker = marker.parent
            siblings = marker.parent.children
            label = None
            nested = False
            for node in siblings[siblings.index(marker) + 1:]:
                if isinstance(node, str):
                    if node.strip():
                        break
                    continue
                if node.tag == 'br':
                    continue
                section_id = node.attrs.get('id', '')
                if node.tag != 'div' or not re.fullmatch(r'rengx(?:[2-9]|[1-9][0-9]+)?', section_id):
                    break
                if section_id == 'rengx':
                    label = node.text().rstrip('：:').strip()
                    continue
                if section_id != 'rengx2':
                    nested = True
                    continue
                if label not in RELATIONS:
                    continue
                # Person anchors must be immediate children; dates and nested relatives
                # have different containers and must never become person evidence.
                anchors = [child for child in node.children if isinstance(child, _Node) and child.tag == 'a']
                if len(anchors) != 1:
                    warnings.append('亲属条目链接不唯一，已跳过。')
                    continue
                anchor = anchors[0]
                try:
                    relative_url = _url(anchor.attrs.get('href', ''))
                    relative_name = _name(anchor.text())
                except GenealogyError:
                    warnings.append('亲属条目姓名或资料链接无效，已跳过。')
                    continue
                relations.append({'url': relative_url, 'name': relative_name, 'kind': RELATIONS[label], 'label': label})
                if len(relations) == 128:
                    warnings.append('单页关系条目超过处理上限，已截断。')
                    break
            if nested:
                warnings.append('嵌套孙辈、侄辈等栏目未直接归给本页人物；仅通过各人物自己的父母子女栏目扩展。')
        return {'url': url, 'name': name, 'title': title[:200], 'identity': intro[:300],
                'relations': relations, 'warnings': warnings, 'retrievedAt': _stamp()}


class GenealogySearch:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.RLock()
        self.network = threading.Lock()
        self.tokens = OrderedDict()
        self.cache = OrderedDict()
        self.cooldown_until = 0.0
        self.next_request = 0.0
        characters = self._load('biography-normalization.json').get('characters', {})
        self.translation = str.maketrans({key: value for key, value in characters.items()
                                        if isinstance(key, str) and len(key) == 1
                                        and isinstance(value, str) and len(value) == 1}) if isinstance(characters, dict) else {}
        self.opener = build_opener(ProxyHandler({}), _Redirects())

    def _load(self, filename):
        try:
            path = self.directory / filename
            if path.stat().st_size > 16 * 1024 * 1024:
                return {}
            data = json.loads(path.read_text(encoding='utf-8'))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError, UnicodeError):
            return {}

    def normalize(self, value):
        return ''.join(unicodedata.normalize('NFKC', value).translate(self.translation).split()).casefold()

    def search(self, name):
        name = _name(name)
        query = self.normalize(name)
        index = self._load('genealogy-search-index.json')
        people = index.get('people', [])
        if not isinstance(people, list) or not people:
            raise GenealogyError('共享服务器未安装可合法使用的人物检索索引 genealogy-search-index.json；在线谱系检索暂不可用。人工选录与已保存谱系仍可阅读。', 503)
        matches = []
        seen = set()
        for item in people:
            if not isinstance(item, dict) or not isinstance(item.get('name'), str):
                continue
            explicit_aliases = item.get('aliases', [])
            alias_match = isinstance(explicit_aliases, list) and any(
                isinstance(alias, str) and 1 <= len(alias) <= 60 and self.normalize(alias) == query
                for alias in explicit_aliases)
            if self.normalize(item['name']) != query and not alias_match:
                continue
            try:
                source_url = _url(item.get('url'))
                source_name = _name(item['name'])
            except GenealogyError:
                continue
            if source_url in seen:
                continue
            seen.add(source_url)
            identity = item.get('identity')
            matches.append({'name': source_name, 'identity': identity[:500] if isinstance(identity, str) and identity.strip() else source_name,
                            'source': {'title': source_name + ' · 博雅人物资料', 'url': source_url}})
        now = time.monotonic()
        warnings = [NOTICE, '索引中的时代分类和身份介绍来自资料站，不保证历史准确性；请选择所需人物。',
                    '检索仅覆盖已缓存的真实人物索引快照，不是完整历史人物库；只匹配姓名及明确收录的别名。']
        if not matches:
            warnings.append('当前已收录的真实资料索引中没有精确同名条目；未猜测拼音或编造来源。')
        if len(matches) > 64:
            raise GenealogyError('精确同名候选过多，暂无法安全列出', 422)
        with self.lock:
            for token in list(self.tokens):
                if self.tokens[token]['expires'] <= now:
                    del self.tokens[token]
            for candidate in matches:
                token = secrets.token_urlsafe(32)
                self.tokens[token] = {'expires': now + TOKEN_TTL, 'query': query,
                                      'url': candidate['source']['url'], 'name': candidate['name']}
                candidate['candidateId'] = token
            while len(self.tokens) > 1024:
                self.tokens.popitem(last=False)
        return {'name': name, 'candidates': matches, 'warnings': warnings}

    def _cooldown(self, headers):
        delay = 60.0
        value = headers.get('Retry-After', '') if headers else ''
        try:
            delay = max(delay, float(value))
        except (ValueError, OverflowError):
            try:
                date = parsedate_to_datetime(value)
                delay = max(delay, date.timestamp() - time.time())
            except (ValueError, TypeError, OverflowError):
                pass
        with self.lock:
            self.cooldown_until = max(self.cooldown_until, time.monotonic() + delay)

    def _fetch(self, url, deadline):
        url = _url(url)
        now = time.monotonic()
        with self.lock:
            cached = self.cache.get(url)
            if cached and cached[0] > now:
                self.cache.move_to_end(url)
                return cached[1]
            if now < self.cooldown_until:
                raise GenealogyError('资料站请求过多，正在遵守 Retry-After 冷却时间，请稍后重试', 429)
        delay = max(0.0, self.next_request - now)
        if now + delay + 1 >= deadline:
            raise GenealogyError('资料检索达到时间上限', 504)
        if delay:
            time.sleep(delay)
        self.next_request = time.monotonic() + 0.3
        fetch_deadline = min(deadline, time.monotonic() + 8)
        request = Request(url, headers={'User-Agent': 'EasternJinAtlas/1.0 (historical genealogy source reader)', 'Accept': 'text/html', 'Accept-Encoding': 'identity'})
        try:
            with self.opener.open(request, timeout=min(5, max(0.1, fetch_deadline - time.monotonic()))) as response:
                final_url = _url(response.geturl())
                content_type = response.headers.get_content_type()
                if content_type not in ('text/html', 'application/xhtml+xml'):
                    raise GenealogyError('资料源返回的不是人物网页', 502)
                chunks = []
                size = 0
                while True:
                    if time.monotonic() >= fetch_deadline:
                        raise GenealogyError('资料读取超时', 504)
                    chunk = response.read1(min(65536, MAX_BODY + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > MAX_BODY:
                        raise GenealogyError('资料页面超过大小上限', 502)
                body = b''.join(chunks)
                charset = response.headers.get_content_charset()
            declared = re.search(br'charset\s*=\s*["\']?\s*([a-zA-Z0-9_-]+)', body[:8192], re.I)
            encoding = (charset or (declared.group(1).decode('ascii') if declared else 'gb18030')).lower()
            if encoding in ('gb2312', 'gbk', 'gb_2312-80'):
                encoding = 'gb18030'
            if encoding not in ('gb18030', 'utf-8', 'utf8', 'big5'):
                raise GenealogyError('资料页面字符编码不受支持', 502)
            parser = _ProfileHTML()
            parser.feed(body.decode(encoding, errors='strict'))
            parser.close()
            profile = parser.extract(final_url)
        except HTTPError as exc:
            if exc.code == 429:
                self._cooldown(exc.headers)
                raise GenealogyError('资料站返回429，已暂停请求并遵守冷却时间', 429) from exc
            raise GenealogyError('资料站返回HTTP ' + str(exc.code) + '，未采用该页面', 502) from exc
        except (URLError, OSError, UnicodeError, ValueError) as exc:
            raise GenealogyError('资料页读取失败或内容无效，未采用该页面', 502) from exc
        with self.lock:
            self.cache[url] = (time.monotonic() + CACHE_TTL, profile)
            self.cache[final_url] = (time.monotonic() + CACHE_TTL, profile)
            while len(self.cache) > 256:
                self.cache.popitem(last=False)
        return profile

    def generate(self, candidate_id, name):
        name = _name(name)
        if not isinstance(candidate_id, str) or not 20 <= len(candidate_id) <= 100:
            raise GenealogyError('候选凭证无效，请重新检索', 400)
        with self.lock:
            candidate = self.tokens.get(candidate_id)
            if (not candidate or candidate['expires'] <= time.monotonic()
                    or candidate['query'] != self.normalize(name)):
                raise GenealogyError('候选凭证已失效或与检索姓名不符，请重新检索', 400)
        if not self.network.acquire(blocking=False):
            raise GenealogyError('正在检索其他家族，请稍后重试', 429)
        result = queue.Queue(maxsize=1)
        deadline = time.monotonic() + REQUEST_SECONDS - 2

        def work():
            try:
                result.put((True, self._generate(candidate, deadline)))
            except GenealogyError as exc:
                result.put((False, exc))
            except Exception:
                result.put((False, GenealogyError('家族资料处理失败，未保存不完整结果', 502)))
            finally:
                self.network.release()

        # A daemon plus a single occupied network slot bounds even platform DNS
        # stalls without spawning an unbounded pool or blocking the HTTP handler.
        worker = threading.Thread(target=work, name='genealogy-source', daemon=True)
        try:
            worker.start()
        except Exception:
            self.network.release()
            raise
        try:
            success, value = result.get(timeout=REQUEST_SECONDS)
        except queue.Empty as exc:
            raise GenealogyError('资料检索超过65秒上限，请稍后重试', 504) from exc
        if not success:
            raise value
        return value

    def _generate(self, candidate, deadline):
        root = self._fetch(candidate['url'], deadline)
        if self.normalize(root['name']) != self.normalize(candidate['name']):
            raise GenealogyError('资料页人物标题与所选候选不符，未生成家族', 422)
        if not root['relations']:
            raise GenealogyError('该人物资料页没有可确认的直接父母子女链接；未从传记正文猜测亲属', 422)
        profiles = {root['url']: root}
        aliases = {candidate['url']: root['url'], root['url']: root['url']}
        names = {self.normalize(root['name']): root['url']}
        blocked = set()
        attempted = {candidate['url']}
        pending = deque([(root, 0)])
        evidence = []
        warnings = [NOTICE, '来源使用HTTP传输，无法保证传输真实性；本结果不替代谱牒或正史核验。']
        warnings.extend(root['warnings'])
        while pending:
            current, depth = pending.popleft()
            if depth >= 2:
                continue
            for relation in current['relations']:
                if time.monotonic() >= deadline - 1:
                    warnings.append('达到检索时间上限，仅保留已取得来源支持的关系。')
                    pending.clear()
                    break
                target_url = relation['url']
                canonical = aliases.get(target_url, target_url)
                if canonical in blocked:
                    continue
                if canonical not in profiles:
                    if target_url in attempted:
                        continue
                    if len(attempted) >= MAX_PEOPLE or len(profiles) >= MAX_PEOPLE:
                        warnings.append('达到24个人物页面上限，部分亲属未展开。')
                        continue
                    attempted.add(target_url)
                    try:
                        profile = self._fetch(target_url, deadline)
                    except GenealogyError as exc:
                        warnings.append(relation['name'] + '：' + str(exc))
                        if exc.status == 429:
                            pending.clear()
                            break
                        continue
                    canonical = profile['url']
                    aliases[target_url] = canonical
                    if self.normalize(profile['name']) != self.normalize(relation['name']):
                        warnings.append('链接名“' + relation['name'] + '”与页面标题“' + profile['name'] + '”不符，未合并身份或采用关系。')
                        continue
                    normalized = self.normalize(profile['name'])
                    other = names.get(normalized)
                    if other and other != canonical:
                        warnings.append('同名“' + profile['name'] + '”对应多个资料路径，身份可能重复或混淆，相关分支已省略。')
                        blocked.add(canonical)
                        if other != root['url']:
                            blocked.add(other)
                        continue
                    if canonical not in profiles:
                        profiles[canonical] = profile
                        names[normalized] = canonical
                        warnings.extend(profile['warnings'])
                        pending.append((profile, depth + 1))
                relative = profiles.get(canonical)
                if not relative or self.normalize(relative['name']) != self.normalize(relation['name']):
                    warnings.append('同一资料路径出现不同姓名，已省略歧义关系。')
                    continue
                if canonical == current['url']:
                    warnings.append('来源列出自指亲属，已省略。')
                    continue
                parent, child = ((current['url'], canonical) if relation['kind'] == 'child' else (canonical, current['url']))
                evidence.append({'parent': parent, 'child': child, 'role': relation['kind'],
                                 'source': current['url'], 'note': current['name'] + '页面「人物关系 / ' + relation['label'] + '」列出' + relative['name']})
        # Reject conflicting role assignments instead of selecting a preferred source.
        by_child = {}
        for edge in evidence:
            by_child.setdefault(edge['child'], []).append(edge)
        conflicts = set()
        for child, edges in by_child.items():
            parents = {edge['parent'] for edge in edges}
            fathers = {edge['parent'] for edge in edges if edge['role'] == 'father'}
            mothers = {edge['parent'] for edge in edges if edge['role'] == 'mother'}
            if len(parents) > 2 or len(fathers) > 1 or len(mothers) > 1 or fathers & mothers:
                conflicts.add(child)
                warnings.append(profiles[child]['name'] + '的父母关系存在冲突，已省略其全部争议父母边。')
        edges = {}
        for item in evidence:
            parent, child = item['parent'], item['child']
            if parent in blocked or child in blocked or child in conflicts:
                continue
            edge = edges.setdefault((parent, child), {'notes': [], 'sources': set()})
            if item['note'] not in edge['notes']:
                edge['notes'].append(item['note'])
            edge['sources'].add(item['source'])
        adjacency = {}
        for parent, child in edges:
            adjacency.setdefault(parent, set()).add(child)

        def reachable(start, target):
            todo = [start]
            visited = set()
            while todo:
                node = todo.pop()
                if node == target:
                    return True
                if node not in visited:
                    visited.add(node)
                    todo.extend(adjacency.get(node, ()))
            return False

        cyclic = [(parent, child) for parent, child in edges if reachable(child, parent)]
        if cyclic:
            warnings.append('来源关系形成世代环路，已省略环路中的全部关系。')
            for edge in cyclic:
                del edges[edge]
        connected = {root['url']}
        changed = True
        while changed:
            changed = False
            for parent, child in edges:
                if parent in connected or child in connected:
                    before = len(connected)
                    connected.update((parent, child))
                    changed = changed or len(connected) != before
        edges = {pair: detail for pair, detail in edges.items() if set(pair) <= connected}
        if len(connected) < 2 or not edges:
            raise GenealogyError('没有取得可连到所选人物的可靠父母子女关系；失败、冲突或身份不明的条目均未采用', 422)
        person_id = lambda url: _identifier('person-', urlsplit(url).path)
        source_id = lambda url: _identifier('source-', urlsplit(url).path)
        source_urls = set(connected)
        for detail in edges.values():
            source_urls.update(detail['sources'])
        source_key = 'usatour:' + urlsplit(root['url']).path
        return {
            'id': _identifier('family-', source_key), 'name': root['name'] + '家族',
            'description': NOTICE + '。从人物关系栏目摘取有明确链接的父母子女关系，不从正文、姓氏或时代分类推定血缘。',
            'scopeNote': '以' + root['name'] + '为中心，最多两步父母子女关系、24人；不是完整族谱。嵌套亲属栏目不直接归属于根人物；未收录不表示无此亲属。',
            'rootPersonId': person_id(root['url']), 'sourceKey': source_key, 'generatedAt': _stamp(),
            'warnings': list(dict.fromkeys(warnings)),
            'people': [{'id': person_id(url), 'name': profiles[url]['name'], 'aliases': [],
                        'identity': profiles[url]['identity'], 'polity': '',
                        'note': NOTICE + '；人物标题与链接名核对一致。来源读取时间：' + profiles[url]['retrievedAt'],
                        'sourceIds': [source_id(url)]} for url in profiles if url in connected],
            'relationships': [{'parentId': person_id(parent), 'childId': person_id(child), 'type': 'parent-child',
                               'note': '；'.join(detail['notes']) + '。' + NOTICE,
                               'sourceIds': [source_id(url) for url in sorted(detail['sources'])]}
                              for (parent, child), detail in edges.items()],
            'sources': [{'id': source_id(url), 'title': profiles[url]['title'] + '（人物关系栏目；读取于' + profiles[url]['retrievedAt'] + '）',
                         'url': url} for url in sorted(source_urls)]}
