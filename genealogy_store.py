"""Validated, independent persistence for explicitly imported family graphs."""
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

from genealogy_search import GenealogyError


MAX_STORE = 8 * 1024 * 1024
MAX_REVISION = 9007199254740991
FAMILY_FIELDS = {'id', 'name', 'description', 'scopeNote', 'people', 'relationships',
                 'sources', 'rootPersonId', 'sourceKey', 'generatedAt', 'warnings'}
PERSON_FIELDS = {'id', 'name', 'aliases', 'identity', 'polity', 'note', 'sourceIds'}
RELATIONSHIP_FIELDS = {'parentId', 'childId', 'type', 'note', 'sourceIds'}
LINK_FIELDS = {'characterId', 'characterName', 'familyId', 'personId'}


def invalid(message):
    raise GenealogyError(message)


def text(value, label, maximum, minimum=0):
    if (not isinstance(value, str) or not minimum <= len(value) <= maximum
            or minimum and not value.strip()
            or any(ord(char) < 32 and char not in '\n\r\t' for char in value)):
        invalid(label + '格式无效')
    try:
        value.encode('utf-8')
    except UnicodeError:
        invalid(label + '编码无效')
    return value


def identifier(value, label):
    text(value, label, 160, 1)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]*', value):
        invalid(label + '格式无效')
    return value


def character_id(value):
    text(value, '人物编号', 60, 1)
    try:
        if not value.startswith('character-') or str(uuid.UUID(value[10:])) != value[10:]:
            raise ValueError()
    except ValueError:
        invalid('人物编号格式无效')


def fields(value, expected, label):
    if not isinstance(value, dict) or set(value) != expected:
        invalid(label + '字段无效；未重置保存数据')


def bounded_list(value, label, maximum, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        invalid(label + '数量无效')
    return value


def source_ids(value, known):
    bounded_list(value, '来源编号', 128, 1)
    seen = set()
    for item in value:
        identifier(item, '来源编号')
        if item not in known or item in seen:
            invalid('来源编号不存在或重复')
        seen.add(item)


def validate_family(family):
    fields(family, FAMILY_FIELDS, '家族')
    identifier(family['id'], '家族编号')
    if not family['id'].startswith('family-'):
        invalid('导入家族编号须使用family-前缀')
    text(family['name'], '家族名称', 240, 1)
    text(family['description'], '家族说明', 6000, 1)
    text(family['scopeNote'], '家族范围说明', 6000, 1)
    text(family['sourceKey'], '家族来源标识', 1024, 1)
    for warning in bounded_list(family['warnings'], '来源提示', 64):
        text(warning, '来源提示', 3000, 1)
    stamp = text(family['generatedAt'], '生成时间', 64, 1)
    try:
        if not stamp.endswith('Z') or datetime.fromisoformat(stamp[:-1] + '+00:00').tzinfo != timezone.utc:
            raise ValueError()
    except ValueError:
        invalid('家族生成时间无效')
    sources = set()
    for source in bounded_list(family['sources'], '来源', 128, 1):
        fields(source, {'id', 'title', 'url'}, '来源')
        sid = identifier(source['id'], '来源编号')
        if sid in sources:
            invalid('来源编号重复')
        sources.add(sid)
        text(source['title'], '来源标题', 1000, 1)
        url = text(source['url'], '来源网址', 4096, 1)
        try:
            parsed = urlsplit(url)
            # This historical directory has no valid HTTPS certificate. Permit
            # its documented public history pages, never arbitrary HTTP URLs.
            http_history = (parsed.scheme == 'http' and parsed.hostname == 'famous.usatour.com.cn'
                            and parsed.path.startswith('/history/') and parsed.port in (None, 80))
            if (not (parsed.scheme == 'https' and parsed.port in (None, 443) or http_history)
                    or not parsed.hostname or parsed.username is not None or parsed.password is not None
                    or any(char.isspace() for char in url) or '\\' in url):
                raise ValueError()
        except ValueError:
            invalid('来源须为HTTPS网址或已批准的历史目录网址')
    people = set()
    for person in bounded_list(family['people'], '家族人物', 24, 2):
        fields(person, PERSON_FIELDS, '家族人物')
        pid = identifier(person['id'], '家族人物编号')
        if pid in people:
            invalid('家族人物编号重复')
        people.add(pid)
        text(person['name'], '家族人物姓名', 240, 1)
        aliases = set()
        for alias in bounded_list(person['aliases'], '人物别名', 32):
            text(alias, '人物别名', 240, 1)
            if alias in aliases:
                invalid('人物别名重复')
            aliases.add(alias)
        text(person['identity'], '人物身份', 3000)
        text(person['polity'], '人物势力', 500)
        text(person['note'], '人物说明', 6000)
        source_ids(person['sourceIds'], sources)
    root = identifier(family['rootPersonId'], '选定人物编号')
    if root not in people:
        invalid('选定人物不在家族中')
    children = {pid: [] for pid in people}
    neighbours = {pid: [] for pid in people}
    indegree = {pid: 0 for pid in people}
    edges = set()
    for relation in bounded_list(family['relationships'], '亲子关系', 276, 1):
        fields(relation, RELATIONSHIP_FIELDS, '亲子关系')
        parent = identifier(relation['parentId'], '亲代编号')
        child = identifier(relation['childId'], '子代编号')
        if (relation['type'] != 'parent-child' or parent not in people or child not in people
                or parent == child or (parent, child) in edges):
            invalid('亲子关系类型、人物或重复关系无效')
        source_ids(relation['sourceIds'], sources)
        text(relation['note'], '亲子关系说明', 6000)
        edges.add((parent, child))
        children[parent].append(child)
        neighbours[parent].append(child)
        neighbours[child].append(parent)
        indegree[child] += 1
    pending = [pid for pid in people if not indegree[pid]]
    visited = 0
    while pending:
        parent = pending.pop()
        visited += 1
        for child in children[parent]:
            indegree[child] -= 1
            if not indegree[child]:
                pending.append(child)
    if visited != len(people):
        invalid('亲子关系存在循环，不能保存')
    connected = {root}
    pending = [root]
    while pending:
        for other in neighbours[pending.pop()]:
            if other not in connected:
                connected.add(other)
                pending.append(other)
    if connected != people:
        invalid('家族包含未与选定人物相连的人物，不能保存')
    return people


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                invalid('家族保存文件含重复字段；未重置数据')
            result[key] = value
        return result

    def constant(_value):
        invalid('家族保存文件含无效数值；未重置数据')

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, RecursionError, UnicodeError) as exc:
        raise GenealogyError('家族保存文件JSON无效；未重置数据') from exc


class GenealogyStore:
    def __init__(self, data_dir, characters, search):
        self.characters = characters
        self.search = search
        # Character changes and the final family commit share the same lock.
        # Retrieval never holds it, so unrelated piece edits remain available.
        self.lock = characters.lock
        self.generation_lock = threading.Lock()
        data_dir = Path(data_dir)
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = data_dir / 'genealogies.json'
        self.state = {'revision': 0, 'families': [], 'links': []}
        if self.path.is_symlink():
            invalid('家族保存文件不可为符号链接')
        if self.path.exists():
            if self.path.stat().st_size > MAX_STORE:
                invalid('家族保存文件过大；未重置数据')
            state = strict_json(self.path.read_text(encoding='utf-8'))
            self.validate_state(state)
            self.state = state

    @staticmethod
    def validate_state(state):
        fields(state, {'revision', 'families', 'links'}, '家族保存文件')
        if type(state['revision']) is not int or not 0 <= state['revision'] <= MAX_REVISION:
            invalid('家族保存版本无效；未重置数据')
        families = {}
        source_keys = set()
        for family in bounded_list(state['families'], '已保存家族', 500):
            people = validate_family(family)
            if family['id'] in families or family['sourceKey'] in source_keys:
                invalid('家族编号或来源标识重复；未重置数据')
            families[family['id']] = people
            source_keys.add(family['sourceKey'])
        links = set()
        for link in bounded_list(state['links'], '人物家族关联', 5000):
            fields(link, LINK_FIELDS, '人物家族关联')
            character_id(link['characterId'])
            text(link['characterName'], '关联人物姓名', 60, 1)
            fid = identifier(link['familyId'], '关联家族编号')
            pid = identifier(link['personId'], '关联人物编号')
            key = (link['characterId'], link['characterName'], fid, pid)
            if fid not in families or pid not in families[fid] or key in links:
                invalid('人物家族关联无效或重复；未重置数据')
            links.add(key)
        # Deleted/renamed pieces deliberately leave historical links untouched.
        # Consumers only apply links when both current ID and name still match.

    def _check_current(self, payload):
        if payload['revision'] != self.state['revision']:
            raise GenealogyError('其他浏览器已更改家族数据，请刷新后重试', status=409)
        character = next((item for item in self.characters.state['characters']
                          if item['id'] == payload['characterId']), None)
        if character is None or character['name'] != payload['characterName']:
            raise GenealogyError('该人物已删除或改名，请刷新后重新搜索', status=409)

    def commit(self, payload):
        fields(payload, {'op', 'revision', 'characterId', 'characterName', 'candidateId'}, '家族生成请求')
        if payload['op'] != 'generate':
            invalid('家族操作须为generate')
        if type(payload['revision']) is not int or not 0 <= payload['revision'] <= MAX_REVISION:
            invalid('请求须包含有效非负整数revision')
        character_id(payload['characterId'])
        text(payload['characterName'], '人物姓名', 60, 1)
        text(payload['candidateId'], '搜索候选编号', 512, 1)
        with self.lock:
            self._check_current(payload)
        if not self.generation_lock.acquire(blocking=False):
            raise GenealogyError('已有家族正在生成，请稍后重试', status=429)
        try:
            family = self.search.generate(payload['candidateId'], payload['characterName'])
            validate_family(family)
            with self.lock:
                self._check_current(payload)
                if self.state['revision'] >= MAX_REVISION:
                    invalid('家族保存版本已达上限')
                existing = next((item for item in self.state['families']
                                 if item['sourceKey'] == family['sourceKey']), None)
                families = self.state['families']
                if existing is not None:
                    family = existing
                else:
                    families = families + [family]
                link = {'characterId': payload['characterId'], 'characterName': payload['characterName'],
                        'familyId': family['id'], 'personId': family['rootPersonId']}
                links = self.state['links']
                if link not in links:
                    links = links + [link]
                if existing is not None and links is self.state['links']:
                    return dict(self.state, familyId=family['id'], personId=family['rootPersonId'])
                state = {'revision': self.state['revision'] + 1, 'families': families, 'links': links}
                self.validate_state(state)
                self._save(state)
                self.state = state
                return dict(state, familyId=family['id'], personId=family['rootPersonId'])
        finally:
            self.generation_lock.release()

    def _save(self, state):
        encoded = json.dumps(state, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        if len(encoded) > MAX_STORE:
            invalid('家族保存总量已达8MiB上限')
        if self.path.is_symlink():
            invalid('家族保存文件不可为符号链接')
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(prefix='.genealogies-', suffix='.tmp', dir=self.path.parent)
            with os.fdopen(fd, 'wb') as output:
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
        finally:
            if temporary is not None:
                os.unlink(temporary)
