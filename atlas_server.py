#!/usr/bin/env python3
"""Trusted-LAN map server with validated, atomic shared territory edits."""
import argparse
import gzip
from functools import lru_cache
import hashlib
from html import escape, unescape
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit
from place_search import CANDIDATE_FIELDS, Invalid, PlaceSearch, history_year_bounds, validate_candidate
from biography_search import BiographySearch, valid_name, validate_source
from genealogy_search import GenealogyError, GenealogySearch
from genealogy_store import GenealogyStore
from place_period_store import PlacePeriodStore


@lru_cache(maxsize=4)
def compressed_static(path, modified_ns, size):
    # File identity/version are cache keys; retain only compressed output.
    return gzip.compress(Path(path).read_bytes(), compresslevel=5, mtime=0)


def accepts_gzip(header):
    for entry in header.split(','):
        fields = [part.strip() for part in entry.split(';')]
        if fields[0].lower() != 'gzip':
            continue
        for parameter in fields[1:]:
            if parameter.lower().startswith('q='):
                try:
                    return float(parameter[2:]) > 0
                except ValueError:
                    return False
        return True
    return False

MAX_EDITS = 500
MAX_VERTICES = 256
MAX_BODY = 131072
MAX_STORE = 8 * 1024 * 1024
EPS = 1e-10
API = '/api/territory-edits'
ANNOTATIONS_API = '/api/map-annotations'
SEARCH_API = '/api/place-search'
CHARACTERS_API = '/api/characters'
BIOGRAPHIES_API = '/api/character-biographies'
GENEALOGIES_API = '/api/genealogies'
GENEALOGY_SEARCH_API = '/api/genealogy-search'
PLACE_PERIODS_API = '/api/place-periods'
MAX_CHARACTERS = 500
CHARACTER_FIELDS = {'name', 'role', 'polityId', 'biography', 'biographySource', 'biographyOrigin', 'lon', 'lat'}
CHARACTER_INPUT_FIELDS = {'name', 'role', 'polityId', 'biographyMode', 'lon', 'lat'}
MAX_ANNOTATIONS = 1000
PUBLIC_FILES = {
    'index.html', 'atlas.js', 'atlas.css', 'geo-data.js', 'history-data.js',
    'territory-edits.js', 'territory-editor.js', 'map-data.js',
    'place-manager.js', 'character-manager.js', 'formation-manager.js',
    'review-data.js', 'genealogy.html', 'genealogy.js', 'genealogy.css',
    'genealogy-data.js', 'genealogy-client.js', 'place-periods.js',
    'atlas-config.js', 'atlas-api.js', 'personal-data.js', 'personal-data.css',
    'sources.html', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
}
PUBLIC_VENDOR_FILES = {
    'leaflet.js', 'leaflet.css', 'LEAFLET-LICENSE.txt',
    'polygon-clipping.umd.min.js', 'POLYGON-CLIPPING-LICENSE.txt',
    'OPENCC-LICENSE.txt',
    'polygon-clipping.LICENSE.txt', 'polygon-clipping-LICENSE.txt',
}


def version_html_resources(body, directory):
    """Keep cached pre-upgrade scripts from mixing with newly served HTML."""
    def replace(match):
        original = unescape(match.group('url'))
        url = urlsplit(original)
        if url.scheme or url.netloc or url.path.startswith('/'):
            return match.group(0)
        resource = directory / unquote(url.path)
        if resource.suffix not in ('.js', '.css') or not resource.is_file():
            return match.group(0)
        if resource.is_symlink() or not resource.resolve().is_relative_to(directory):
            return match.group(0)
        version = hashlib.sha256(resource.read_bytes()).hexdigest()[:16]
        query = [(key, value) for key, value in parse_qsl(url.query) if key != 'v']
        query.append(('v', version))
        updated = urlunsplit(('', '', url.path, urlencode(query), url.fragment))
        return match.group('prefix') + match.group('quote') + escape(updated, quote=True) + match.group('quote')

    pattern = r'(?P<prefix>\b(?:src|href)\s*=\s*)(?P<quote>[\"\x27])(?P<url>[^\"\x27]+)(?P=quote)'
    return re.sub(pattern, replace, body.decode('utf-8')).encode('utf-8')




def strict_json(text):
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise Invalid('JSON含重复字段')
            obj[key] = value
        return obj

    def invalid_number(_value):
        raise Invalid('JSON含无效数值')

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_number)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise Invalid('JSON格式不正确') from exc


def read_assignment(path, name):
    text = path.read_text(encoding='utf-8')
    match = re.fullmatch(r'\s*window\.' + name + r'\s*=\s*(.*?)\s*;?\s*', text, re.S)
    if not match:
        raise Invalid('历史数据文件格式不正确：' + path.name)
    return strict_json(match.group(1))


def number(value):
    return type(value) is int or type(value) is float and math.isfinite(value)


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def on_segment(point, a, b):
    return (abs(cross(a, b, point)) <= EPS
            and min(a[0], b[0]) - EPS <= point[0] <= max(a[0], b[0]) + EPS
            and min(a[1], b[1]) - EPS <= point[1] <= max(a[1], b[1]) + EPS)


def intersects(a, b, c, d):
    ab_c, ab_d, cd_a, cd_b = cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)
    if ((ab_c > EPS and ab_d < -EPS or ab_c < -EPS and ab_d > EPS)
            and (cd_a > EPS and cd_b < -EPS or cd_a < -EPS and cd_b > EPS)):
        return True
    return (on_segment(c, a, b) or on_segment(d, a, b)
            or on_segment(a, c, d) or on_segment(b, c, d))


def contains(point, ring):
    inside = False
    x, y = point
    for a, b in zip(ring, ring[1:]):
        if on_segment(point, a, b):
            return True
        if (a[1] > y) != (b[1] > y):
            if x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
    return inside


def validate_geometry(geometry, point):
    if not isinstance(geometry, dict) or set(geometry) != {'type', 'coordinates'} or geometry.get('type') != 'Polygon':
        raise Invalid('范围须为单环Polygon多边形')
    coordinates = geometry.get('coordinates')
    if not isinstance(coordinates, list) or len(coordinates) != 1 or not isinstance(coordinates[0], list):
        raise Invalid('范围只支持一个外环，不支持孔洞')
    ring = coordinates[0]
    if not 4 <= len(ring) <= MAX_VERTICES + 1:
        raise Invalid('范围需3至256个顶点并闭合')
    for p in ring:
        if (not isinstance(p, list) or len(p) != 2 or not all(number(v) for v in p)
                or not -180 <= p[0] <= 180 or not -90 <= p[1] <= 90):
            raise Invalid('范围坐标必须是有效经纬度[经度,纬度]')
    if ring[0] != ring[-1]:
        raise Invalid('范围必须闭合')
    n = len(ring) - 1
    if len({tuple(p) for p in ring[:-1]}) != n:
        raise Invalid('范围顶点不可重复')
    for i in range(n):
        a, b, c = ring[i - 1 if i else n - 1], ring[i], ring[i + 1]
        if abs(b[0] - c[0]) > 180:
            raise Invalid('范围不可跨越日期变更线')
        if abs(cross(a, b, c)) <= EPS and (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > EPS:
            raise Invalid('范围边线不可折返重叠')
        for j in range(i + 1, n):
            if j == i + 1 or i == 0 and j == n - 1:
                continue
            if intersects(ring[i], ring[i + 1], ring[j], ring[j + 1]):
                raise Invalid('范围不可自交或自相接触')
    origin = ring[0]
    area2 = sum(cross(origin, ring[i], ring[i + 1]) for i in range(1, n))
    if abs(area2) <= EPS:
        raise Invalid('范围面积过小或为零')
    if not contains(point, ring):
        raise Invalid('所绘范围必须包含选定的郡县或城邑')


class AnnotationStore:
    """Shares one transaction lock with territories: no cross-store lock ordering."""
    def __init__(self, data_dir, lock):
        self.lock = lock
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = data_dir / 'map-annotations.json'
        self.state = {'revision': 0, 'annotations': []}
        if self.path.is_symlink():
            raise Invalid('地点保存文件不可为符号链接')
        if self.path.exists():
            if self.path.stat().st_size > MAX_STORE:
                raise Invalid('地点保存文件过大；未重置数据')
            state = strict_json(self.path.read_text(encoding='utf-8'))
            self.validate_state(state)
            self.state = state

    @staticmethod
    def identity(annotation):
        return annotation['sourceUrl'], annotation['kind'], annotation['name'].strip().casefold()

    def validate_state(self, state):
        if (not isinstance(state, dict) or set(state) != {'revision', 'annotations'}
                or type(state['revision']) is not int or not 0 <= state['revision'] <= 9007199254740991
                or not isinstance(state['annotations'], list) or len(state['annotations']) > MAX_ANNOTATIONS):
            raise Invalid('地点保存文件格式无效；未重置数据')
        ids, identities = set(), set()
        for annotation in state['annotations']:
            if not isinstance(annotation, dict) or set(annotation) != CANDIDATE_FIELDS | {'id', 'note', 'createdAt'}:
                raise Invalid('地点记录字段无效；未重置数据')
            validate_candidate({key: annotation[key] for key in CANDIDATE_FIELDS})
            if not isinstance(annotation['note'], str) or len(annotation['note']) > 500:
                raise Invalid('地点备注无效；未重置数据')
            try:
                identifier = annotation['id']
                if not identifier.startswith('user-') or str(uuid.UUID(identifier[5:])) != identifier[5:]:
                    raise ValueError()
                stamp = annotation['createdAt']
                if not isinstance(stamp, str) or not stamp.endswith('Z'):
                    raise ValueError()
                datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            except (ValueError, TypeError, AttributeError) as exc:
                raise Invalid('地点记录元数据无效；未重置数据') from exc
            identity = self.identity(annotation)
            if identifier in ids or identity in identities:
                raise Invalid('地点记录重复；未重置数据')
            ids.add(identifier)
            identities.add(identity)

    def custom_places(self):
        return {a['id']: [a['lon'], a['lat']] for a in self.state['annotations'] if a['kind'] in ('city', 'county')}

    def commit(self, payload, search, territories):
        if (not isinstance(payload, dict) or type(payload.get('revision')) is not int
                or not 0 <= payload['revision'] <= 9007199254740991):
            raise Invalid('请求须包含有效非负整数revision')
        op = payload.get('op')
        if op == 'add':
            expected = {'revision', 'op', 'candidateId', 'name', 'note'}
        elif op == 'remove':
            expected = {'revision', 'op', 'id'}
        else:
            raise Invalid('地点操作必须为add或remove')
        if set(payload) != expected:
            raise Invalid('地点请求字段不正确；坐标与来源须来自搜索候选')
        if op == 'add':
            if not isinstance(payload['name'], str) or not 1 <= len(payload['name'].strip()) <= 80:
                raise Invalid('地点名称须为1至80字')
            if not isinstance(payload['note'], str) or len(payload['note']) > 500:
                raise Invalid('地点备注限500字')
        elif not isinstance(payload['id'], str):
            raise Invalid('地点编号不正确')
        with self.lock:
            if payload['revision'] != self.state['revision']:
                return None
        # Canonical network checks must never hold the shared transaction lock.
        candidate = search.resolve(payload['candidateId']) if op == 'add' else None
        with self.lock:
            if payload['revision'] != self.state['revision']:
                return None
            if self.state['revision'] >= 9007199254740991:
                raise Invalid('保存版本已达上限')
            annotations = self.state['annotations'][:]
            if op == 'add':
                if len(annotations) >= MAX_ANNOTATIONS:
                    raise Invalid('最多保存1000个自定义地点，请先删除不需要的标注')
                annotation = dict(candidate, id='user-' + str(uuid.uuid4()), name=payload['name'].strip(),
                                  note=payload['note'], createdAt=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'))
                if any(self.identity(a) == self.identity(annotation) for a in annotations):
                    raise Invalid('相同来源、类别和显示名称的地点已存在')
                annotations.append(annotation)
            else:
                if not any(a['id'] == payload['id'] for a in annotations):
                    raise Invalid('找不到该地点标注')
                if any(e['placeId'] == payload['id'] for e in territories.state['edits']):
                    raise Invalid('该地点被疆域编辑引用，请先撤销相关疆域编辑，再删除地点')
                annotations = [a for a in annotations if a['id'] != payload['id']]
            state = {'revision': self.state['revision'] + 1, 'annotations': annotations}
            encoded = json.dumps(state, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
            if len(encoded) > MAX_STORE:
                raise Invalid('地点保存总量已达上限')
            if self.path.is_symlink():
                raise Invalid('地点保存文件不可为符号链接')
            temporary = None
            try:
                fd, temporary = tempfile.mkstemp(prefix='.annotations-', suffix='.tmp', dir=self.path.parent)
                with os.fdopen(fd, 'wb') as output:
                    output.write(encoded)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, self.path)
                temporary = None
            finally:
                if temporary is not None:
                    os.unlink(temporary)
            self.state = state
            if op == 'add' and annotation['kind'] in ('city', 'county'):
                territories.places[annotation['id']] = [annotation['lon'], annotation['lat']]
            elif op == 'remove':
                territories.places.pop(payload['id'], None)
            return state


class CharacterStore:
    """Shared pieces and formations; positions do not imply historical allegiance."""
    def __init__(self, data_dir, polities, biography_search):
        self.polities = frozenset(polities)
        self.biography_search = biography_search
        self.lock = threading.RLock()
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = data_dir / 'characters.json'
        self.state = {'revision': 0, 'characters': [], 'formations': []}
        if self.path.is_symlink():
            raise Invalid('人物保存文件不可为符号链接')
        if self.path.exists():
            if self.path.stat().st_size > MAX_STORE:
                raise Invalid('人物保存文件过大；未重置数据')
            state = strict_json(self.path.read_text(encoding='utf-8'))
            migrated = False
            if isinstance(state, dict) and 'formations' not in state:
                state['formations'] = []
                migrated = True
            if isinstance(state, dict) and isinstance(state.get('characters'), list):
                for character in state['characters']:
                    if isinstance(character, dict) and 'biographyOrigin' not in character:
                        character.setdefault('biographySource', None)
                        character['biographyOrigin'] = 'online' if character['biographySource'] is not None else 'legacy'
                        migrated = True
                    if isinstance(character, dict) and 'hidden' not in character:
                        character['hidden'] = False
                        migrated = True
            self.validate_state(state)
            if migrated:
                # Schema-only migration preserves revision, identifiers, timestamps and original text.
                self._save(state)
            self.state = state

    @staticmethod
    def validate_position(lon, lat):
        if not number(lon) or not -180 <= lon <= 180:
            raise Invalid('人物经度须为-180至180之间的有限数值')
        if not number(lat) or not -85 <= lat <= 85:
            raise Invalid('人物纬度须为-85至85之间的有限数值')

    def validate_character(self, character):
        if not isinstance(character, dict) or set(character) != CHARACTER_FIELDS:
            raise Invalid('人物保存字段不完整；未重置保存数据')
        # Existing map labels predate online-name restrictions; do not reject or
        # rewrite those persisted labels during migration or non-name edits.
        if not isinstance(character['name'], str) or not 1 <= len(character['name'].strip()) <= 60:
            raise Invalid('人物姓名去除首尾空白后须为1至60字')
        name = character['name'].strip()
        origin = character['biographyOrigin']
        if origin not in ('online', 'custom', 'legacy'):
            raise Invalid('人物简介类型须为online、custom或legacy；未重置保存数据')
        minimum = 0 if origin == 'custom' else 1
        if not isinstance(character['biography'], str) or not minimum <= len(character['biography'].strip()) <= 3000:
            raise Invalid('自定义简介最多3000字，可留空' if origin == 'custom' else '人物简介必填，去除首尾空白后须为1至3000字')
        source = character['biographySource']
        if (origin == 'online') != (source is not None):
            raise Invalid('网上简介须有可信来源，自定义或旧版自填简介不得带网上来源；未重置保存数据')
        validate_source(source)
        if character['role'] not in ('monarch', 'minister'):
            raise Invalid('人物角色须为monarch（君主）或minister（大臣）')
        if not isinstance(character['polityId'], str) or character['polityId'] not in self.polities:
            raise Invalid('请选择已有势力；人物阵营不由所在国界推断')
        self.validate_position(character['lon'], character['lat'])
        normalized = dict(character, name=name, biography=character['biography'].strip())
        normalized['name'].encode('utf-8')
        normalized['biography'].encode('utf-8')
        return normalized

    def input_character(self, fields, previous=None):
        if not isinstance(fields, dict) or 'biographyMode' not in fields:
            raise Invalid('人物编辑接口已更新：请刷新页面后选择网上简介或自定义人物')
        mode = fields['biographyMode']
        if mode == 'online':
            expected = CHARACTER_INPUT_FIELDS | {'biographyId'}
        elif mode == 'custom':
            expected = CHARACTER_INPUT_FIELDS | {'biography'}
        elif mode == 'keep':
            expected = CHARACTER_INPUT_FIELDS
        else:
            raise Invalid('人物简介模式须为online（网上简介）、custom（自定义）或keep（保留原简介）')
        if set(fields) != expected:
            raise Invalid('人物简介字段与所选模式不符：不可混用简介与候选编号，也不可提交来源或来源类型')
        if mode == 'online':
            name = valid_name(fields['name'])
            candidate = self.biography_search.resolve(fields['biographyId'], name)
            biography = candidate['summary']
            source = candidate['source']
            origin = 'online'
        elif mode == 'custom':
            biography = fields['biography']
            source = None
            origin = 'custom'
        else:
            if previous is None:
                raise Invalid('新人物不能保留原简介，请选择网上简介或自定义人物')
            if not isinstance(fields['name'], str) or fields['name'].strip() != previous['name']:
                raise Invalid('改名后不能保留原网上简介，请选择自定义或重新获取该姓名的网上简介')
            biography = previous['biography']
            source = previous['biographySource']
            origin = previous['biographyOrigin']
        character = {key: fields[key] for key in ('name', 'role', 'polityId', 'lon', 'lat')}
        character.update(biography=biography, biographySource=source, biographyOrigin=origin)
        return self.validate_character(character)

    @staticmethod
    def validate_formation(formation, character_ids):
        if not isinstance(formation, dict) or set(formation) != {'name', 'commanderId', 'memberIds'}:
            raise Invalid('编队字段须为name、commanderId和memberIds')
        name = formation['name']
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
            raise Invalid('编队名称去除首尾空白后须为1至60字')
        name = name.strip()
        name.encode('utf-8')
        members = formation['memberIds']
        if not isinstance(members, list) or not 2 <= len(members) <= 50:
            raise Invalid('每个编队须有2至50名人物（含主将）')
        if any(not isinstance(member, str) or member not in character_ids for member in members):
            raise Invalid('编队成员须为已保存的人物')
        if len(set(members)) != len(members):
            raise Invalid('编队成员不可重复')
        commander = formation['commanderId']
        if not isinstance(commander, str) or commander not in members:
            raise Invalid('主将须从本编队成员中选择')
        return dict(formation, name=name, memberIds=members[:])

    def validate_state(self, state):
        if (not isinstance(state, dict) or set(state) != {'revision', 'characters', 'formations'}
                or type(state['revision']) is not int or not 0 <= state['revision'] <= 9007199254740991
                or not isinstance(state['characters'], list) or len(state['characters']) > MAX_CHARACTERS
                or not isinstance(state['formations'], list) or len(state['formations']) > 100):
            raise Invalid('人物保存文件格式无效；未重置数据')
        ids = set()
        for character in state['characters']:
            if not isinstance(character, dict) or set(character) != CHARACTER_FIELDS | {'id', 'createdAt', 'updatedAt', 'hidden'}:
                raise Invalid('人物保存字段无效；未重置数据')
            if type(character['hidden']) is not bool:
                raise Invalid('人物隐藏状态须为布尔值；未重置数据')
            fields = {key: character[key] for key in CHARACTER_FIELDS}
            if self.validate_character(fields) != fields:
                raise Invalid('人物姓名或简介含未规范化首尾空白；未重置数据')
            try:
                identifier = character['id']
                if not identifier.startswith('character-') or str(uuid.UUID(identifier[10:])) != identifier[10:]:
                    raise ValueError()
                for field in ('createdAt', 'updatedAt'):
                    stamp = character[field]
                    if not isinstance(stamp, str) or not stamp.endswith('Z'):
                        raise ValueError()
                    parsed = datetime.fromisoformat(stamp[:-1] + '+00:00')
                    if parsed.tzinfo != timezone.utc:
                        raise ValueError()
            except (ValueError, TypeError, AttributeError) as exc:
                raise Invalid('人物记录元数据无效；未重置数据') from exc
            if identifier in ids:
                raise Invalid('人物编号重复；未重置数据')
            ids.add(identifier)
        formation_ids = set()
        assigned = set()
        for formation in state['formations']:
            if (not isinstance(formation, dict)
                    or set(formation) != {'id', 'name', 'commanderId', 'memberIds', 'createdAt', 'updatedAt'}):
                raise Invalid('编队保存字段无效；未重置数据')
            fields = {key: formation[key] for key in ('name', 'commanderId', 'memberIds')}
            if self.validate_formation(fields, ids) != fields:
                raise Invalid('编队名称含未规范化首尾空白；未重置数据')
            try:
                identifier = formation['id']
                if not identifier.startswith('formation-') or str(uuid.UUID(identifier[10:])) != identifier[10:]:
                    raise ValueError()
                for field in ('createdAt', 'updatedAt'):
                    stamp = formation[field]
                    if not isinstance(stamp, str) or not stamp.endswith('Z'):
                        raise ValueError()
                    parsed = datetime.fromisoformat(stamp[:-1] + '+00:00')
                    if parsed.tzinfo != timezone.utc:
                        raise ValueError()
            except (ValueError, TypeError, AttributeError) as exc:
                raise Invalid('编队记录元数据无效；未重置数据') from exc
            if identifier in formation_ids:
                raise Invalid('编队编号重复；未重置数据')
            formation_ids.add(identifier)
            if assigned.intersection(formation['memberIds']):
                raise Invalid('每个人物最多加入一个编队；未重置数据')
            assigned.update(formation['memberIds'])

    def commit(self, payload):
        if (not isinstance(payload, dict) or type(payload.get('revision')) is not int
                or not 0 <= payload['revision'] <= 9007199254740991):
            raise Invalid('请求须包含有效非负整数revision')
        op = payload.get('op')
        if op == 'add':
            expected = {'revision', 'op', 'character'}
        elif op == 'update':
            expected = {'revision', 'op', 'id', 'character'}
        elif op == 'move':
            expected = {'revision', 'op', 'id', 'lon', 'lat'}
        elif op == 'set-hidden':
            expected = {'revision', 'op', 'id', 'hidden'}
        elif op in ('remove', 'formation-remove'):
            expected = {'revision', 'op', 'id'}
        elif op == 'formation-add':
            expected = {'revision', 'op', 'formation'}
        elif op == 'formation-update':
            expected = {'revision', 'op', 'id', 'formation'}
        else:
            raise Invalid('人物操作须为add、update、move、set-hidden、remove、formation-add、formation-update或formation-remove')
        if set(payload) != expected:
            raise Invalid('人物操作请求字段不正确')
        if 'id' in expected and not isinstance(payload['id'], str):
            raise Invalid('人物或编队编号不正确')
        if op == 'move':
            self.validate_position(payload['lon'], payload['lat'])
        if op == 'set-hidden' and type(payload['hidden']) is not bool:
            raise Invalid('人物隐藏状态须为布尔值')
        with self.lock:
            if payload['revision'] != self.state['revision']:
                return None
            if self.state['revision'] >= 9007199254740991:
                raise Invalid('人物保存版本已达上限')
            characters = self.state['characters'][:]
            formations = self.state['formations'][:]
            stamp = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            if op.startswith('formation-'):
                index = None
                if op != 'formation-add':
                    index = next((i for i, item in enumerate(formations) if item['id'] == payload['id']), None)
                    if index is None:
                        raise Invalid('找不到该编队')
                if op == 'formation-remove':
                    del formations[index]
                else:
                    if op == 'formation-add' and len(formations) >= 100:
                        raise Invalid('最多保存100个编队，请先解散不需要的编队')
                    formation = self.validate_formation(payload['formation'], {item['id'] for item in characters})
                    members = set(formation['memberIds'])
                    if any(members.intersection(item['memberIds']) for i, item in enumerate(formations) if i != index):
                        raise Invalid('每个人物最多加入一个编队，请先编辑或解散原编队')
                    if op == 'formation-add':
                        formations.append(dict(formation, id='formation-' + str(uuid.uuid4()), createdAt=stamp, updatedAt=stamp))
                    else:
                        previous = formations[index]
                        formations[index] = dict(formation, id=previous['id'], createdAt=previous['createdAt'], updatedAt=stamp)
            elif op == 'add':
                if len(characters) >= MAX_CHARACTERS:
                    raise Invalid('最多保存500个人物，请先删除不需要的人物')
                character = self.input_character(payload['character'])
                characters.append(dict(character, id='character-' + str(uuid.uuid4()), createdAt=stamp, updatedAt=stamp, hidden=False))
            else:
                index = next((i for i, item in enumerate(characters) if item['id'] == payload['id']), None)
                if index is None:
                    raise Invalid('找不到该人物')
                previous = characters[index]
                formation_index = next((i for i, item in enumerate(formations) if previous['id'] in item['memberIds']), None)
                if op == 'remove':
                    if formation_index is not None:
                        raise Invalid('该人物属于编队，请先编辑或解散编队')
                    del characters[index]
                elif op == 'set-hidden':
                    characters[index] = dict(previous, hidden=payload['hidden'], updatedAt=stamp)
                elif op == 'update':
                    character = self.input_character(payload['character'], previous)
                    if formation_index is not None and (character['lon'] != previous['lon'] or character['lat'] != previous['lat']):
                        raise Invalid('编队成员不可单独修改坐标，请拖动棋子整体移动，或先编辑或解散编队')
                    characters[index] = dict(character, id=previous['id'], createdAt=previous['createdAt'], updatedAt=stamp, hidden=previous['hidden'])
                elif formation_index is None:
                    characters[index] = dict(previous, lon=payload['lon'], lat=payload['lat'], updatedAt=stamp)
                else:
                    formation = formations[formation_index]
                    members = set(formation['memberIds'])
                    delta_lon = payload['lon'] - previous['lon']
                    # Dimensionless Web Mercator y; the Earth-radius factor cancels.
                    delta_y = (math.asinh(math.tan(math.radians(payload['lat'])))
                               - math.asinh(math.tan(math.radians(previous['lat']))))
                    max_y = math.asinh(math.tan(math.radians(85)))
                    for i, member in enumerate(characters):
                        if member['id'] not in members:
                            continue
                        lon = member['lon'] + delta_lon
                        lat = member['lat']
                        if delta_y:
                            y = math.asinh(math.tan(math.radians(lat))) + delta_y
                            if not -max_y <= y <= max_y:
                                raise Invalid('编队整体移动后有成员超出纬度-85至85的地图范围；未移动任何成员')
                            lat = math.degrees(math.atan(math.sinh(y)))
                        if i == index:
                            lon, lat = payload['lon'], payload['lat']
                        self.validate_position(lon, lat)
                        characters[i] = dict(member, lon=lon, lat=lat, updatedAt=stamp)
                    formations[formation_index] = dict(formation, updatedAt=stamp)
            state = {'revision': self.state['revision'] + 1, 'characters': characters, 'formations': formations}
            self.validate_state(state)
            self._save(state)
            self.state = state
            return state

    def _save(self, state):
        encoded = json.dumps(state, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        if len(encoded) > MAX_STORE:
            raise Invalid('人物保存总量已达8MiB上限')
        if self.path.is_symlink():
            raise Invalid('人物保存文件不可为符号链接')
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(prefix='.characters-', suffix='.tmp', dir=self.path.parent)
            with os.fdopen(fd, 'wb') as output:
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
        finally:
            if temporary is not None:
                os.unlink(temporary)


class Store:
    def __init__(self, directory, data_dir, custom_places=None, lock=None):
        geo = read_assignment(directory / 'geo-data.js', 'GEO_DATA')
        history = read_assignment(directory / 'history-data.js', 'HISTORY_DATA')
        self.min_year, self.max_year = history_year_bounds(history)
        self.places = {p['id']: [p['lon'], p['lat']] for p in geo['places']}
        self.places.update(custom_places or {})
        self.polities = {p['id'] for p in history['polities']}
        self.lock = lock if lock is not None else threading.RLock()
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = data_dir / 'territory-edits.json'
        if self.path.is_symlink():
            raise Invalid('保存文件不可为符号链接')
        self.state = {'revision': 0, 'edits': []}
        if self.path.exists():
            if self.path.stat().st_size > MAX_STORE:
                raise Invalid('保存文件过大；请检查，未重置数据')
            state = strict_json(self.path.read_text(encoding='utf-8'))
            self.validate_state(state)
            self.state = state

    def validate_edit(self, edit, stored=False):
        keys = {'placeId', 'startYear', 'polityId', 'geometry', 'note'}
        if stored:
            keys |= {'id', 'sequence', 'createdAt'}
        if not isinstance(edit, dict) or set(edit) != keys:
            raise Invalid('编辑字段不正确')
        if not isinstance(edit['placeId'], str) or edit['placeId'] not in self.places:
            raise Invalid('请选择已知郡县或城邑')
        if not isinstance(edit['polityId'], str) or edit['polityId'] not in self.polities:
            raise Invalid('请选择已知目标势力')
        if type(edit['startYear']) is not int or not self.min_year <= edit['startYear'] <= self.max_year:
            raise Invalid(f'生效年须为{self.min_year}至{self.max_year}之间的整数')
        if not isinstance(edit['note'], str) or len(edit['note']) > 500:
            raise Invalid('备注限500字')
        validate_geometry(edit['geometry'], self.places[edit['placeId']])
        if stored:
            try:
                if str(uuid.UUID(edit['id'])) != edit['id']:
                    raise ValueError()
                if type(edit['sequence']) is not int or edit['sequence'] < 1:
                    raise ValueError()
                if not isinstance(edit['createdAt'], str) or not edit['createdAt'].endswith('Z'):
                    raise ValueError()
                datetime.fromisoformat(edit['createdAt'].replace('Z', '+00:00'))
            except (ValueError, TypeError, AttributeError) as exc:
                raise Invalid('保存文件编辑元数据无效') from exc

    def validate_state(self, state):
        if (not isinstance(state, dict) or set(state) != {'revision', 'edits'}
                or type(state['revision']) is not int or not 0 <= state['revision'] <= 9007199254740991
                or not isinstance(state['edits'], list) or len(state['edits']) > MAX_EDITS):
            raise Invalid('保存文件格式无效；未重置数据')
        ids, sequences = set(), set()
        for edit in state['edits']:
            self.validate_edit(edit, stored=True)
            if edit['id'] in ids or edit['sequence'] in sequences or edit['sequence'] > state['revision']:
                raise Invalid('保存文件序号重复或无效；未重置数据')
            ids.add(edit['id'])
            sequences.add(edit['sequence'])

    def commit(self, payload):
        if (not isinstance(payload, dict) or type(payload.get('revision')) is not int
                or not 0 <= payload['revision'] <= 9007199254740991):
            raise Invalid('请求须包含有效非负整数revision')
        op = payload.get('op')
        expected = {'revision', 'op'} | ({'edit'} if op == 'add' else {'id'} if op == 'remove' else set())
        if op not in ('add', 'remove', 'clear') or set(payload) != expected:
            raise Invalid('操作或请求字段不正确')
        if op == 'remove' and not isinstance(payload['id'], str):
            raise Invalid('编辑编号不正确')
        with self.lock:
            if payload['revision'] != self.state['revision']:
                return None
            if self.state['revision'] >= 9007199254740991:
                raise Invalid('保存版本已达上限')
            revision = self.state['revision'] + 1
            edits = self.state['edits'][:]
            if op == 'add':
                self.validate_edit(payload['edit'])
                if len(edits) >= MAX_EDITS:
                    raise Invalid('最多保存500条编辑，请先撤销不需要的记录')
                edit = dict(payload['edit'])
                edit.update(id=str(uuid.uuid4()), sequence=revision,
                            createdAt=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'))
                edits.append(edit)
            elif op == 'remove':
                if not any(e['id'] == payload['id'] for e in edits):
                    raise Invalid('找不到该编辑记录')
                edits = [e for e in edits if e['id'] != payload['id']]
            else:
                edits = []
            state = {'revision': revision, 'edits': edits}
            encoded = json.dumps(state, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
            if len(encoded) > MAX_STORE:
                raise Invalid('编辑保存总量已达上限')
            temporary = None
            try:
                fd, temporary = tempfile.mkstemp(prefix='.territory-', suffix='.tmp', dir=self.path.parent)
                with os.fdopen(fd, 'wb') as output:
                    output.write(encoded)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, self.path)
                temporary = None
            finally:
                if temporary is not None:
                    os.unlink(temporary)
            self.state = state
            return state


class Handler(BaseHTTPRequestHandler):
    server_version = 'AtlasLAN/1.0'

    def json_response(self, status, value):
        body = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def error(self, status, message):
        self.json_response(status, {'error': message})

    def check_host(self):
        hosts = self.headers.get_all('Host', [])
        if len(hosts) != 1 or hosts[0].lower() not in self.server.allowed_hosts:
            self.error(403, 'Host不受信任，请使用指定局域网地址')
            return False
        return True

    def do_GET(self):
        if not self.check_host():
            return
        try:
            request = urlsplit(self.path)
        except ValueError:
            self.error(400, '请求路径格式不正确')
            return
        if request.scheme or request.netloc:
            self.error(403, '不允许代理请求')
            return
        if request.path == '/atlas-config.js':
            body = b'window.ATLAS_CONFIG = Object.freeze({mode: "shared"});\n'
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
            return
        if request.path == API:
            with self.server.store.lock:
                state = self.server.store.state
            self.json_response(200, state)
            return
        if request.path == ANNOTATIONS_API:
            with self.server.annotations.lock:
                state = self.server.annotations.state
            self.json_response(200, state)
            return
        if request.path == CHARACTERS_API:
            with self.server.characters.lock:
                state = self.server.characters.state
            self.json_response(200, state)
            return
        if request.path == GENEALOGIES_API:
            with self.server.genealogies.lock:
                state = self.server.genealogies.state
            self.json_response(200, state)
            return
        if request.path == PLACE_PERIODS_API:
            with self.server.place_periods.lock:
                state = self.server.place_periods.state
            self.json_response(200, state)
            return
        if request.path == GENEALOGY_SEARCH_API:
            try:
                if len(request.query) > 2048:
                    raise GenealogyError('家族搜索参数过长')
                pairs = parse_qsl(request.query, keep_blank_values=True, strict_parsing=True,
                                  encoding='utf-8', errors='strict', max_num_fields=1)
                if len(pairs) != 1 or pairs[0][0] != 'name':
                    raise GenealogyError('家族搜索仅接受一个name参数')
                self.json_response(200, self.server.genealogy_search.search(pairs[0][1]))
            except GenealogyError as exc:
                self.error(exc.status, str(exc))
            except (ValueError, UnicodeError):
                self.error(400, '家族搜索参数格式不正确')
            except OSError:
                self.error(502, '家族来源暂时无法访问，请稍后重试')
            return
        if request.path == BIOGRAPHIES_API:
            try:
                if len(request.query) > 2048:
                    raise Invalid('人物搜索参数过长')
                pairs = parse_qsl(request.query, keep_blank_values=True, strict_parsing=True,
                                  encoding='utf-8', errors='strict', max_num_fields=2)
                if len({key for key, _ in pairs}) != len(pairs):
                    raise Invalid('人物搜索参数不可重复')
                self.json_response(200, self.server.biography_search.search(dict(pairs)))
            except (Invalid, ValueError, UnicodeError) as exc:
                self.error(400, str(exc) if isinstance(exc, Invalid) else '人物搜索参数格式不正确')
            return
        if request.path == SEARCH_API:
            try:
                if len(request.query) > 2048:
                    raise Invalid('搜索参数过长')
                pairs = parse_qsl(request.query, keep_blank_values=True, strict_parsing=True,
                                  encoding='utf-8', errors='strict', max_num_fields=4)
                if len({key for key, _ in pairs}) != len(pairs):
                    raise Invalid('搜索参数不可重复')
                self.json_response(200, self.server.place_search.search(dict(pairs)))
            except (Invalid, ValueError, UnicodeError) as exc:
                self.error(400, str(exc) if isinstance(exc, Invalid) else '搜索参数格式不正确')
            return
        try:
            path = unquote(request.path, errors='strict')
            if not path.startswith('/') or '\\' in path or '\x00' in path:
                raise Invalid('无效路径')
            parts = path.lstrip('/').split('/')
            if any(p in ('.', '..') or p.startswith('.') for p in parts if p):
                raise Invalid('不允许访问该路径')
            if path == '/':
                parts = ['index.html']
            relative = '/'.join(parts)
            public = relative in PUBLIC_FILES
            if parts[0] == 'vendor':
                public = (len(parts) == 2 and parts[1] in PUBLIC_VENDOR_FILES
                          or len(parts) == 3 and parts[1] == 'images' and Path(parts[2]).suffix.lower() in ('.png', '.svg'))
            candidate = self.server.directory.joinpath(*parts)
            if not public or not candidate.resolve().is_relative_to(self.server.directory):
                raise Invalid('此资源不对外开放')
            current = self.server.directory
            for part in parts:
                current = current / part
                if current.is_symlink():
                    raise Invalid('不允许通过符号链接访问文件')
            if not candidate.is_file():
                self.error(404, '地图资源不存在')
                return
            metadata = candidate.stat()
            compressible = candidate.suffix == '.json' and metadata.st_size > 262144
            compressed = compressible and accepts_gzip(self.headers.get('Accept-Encoding', ''))
            body = compressed_static(str(candidate), metadata.st_mtime_ns, metadata.st_size) if compressed else candidate.read_bytes()
            if candidate.suffix == '.html':
                body = version_html_resources(body, self.server.directory)
            content_type = mimetypes.guess_type(str(candidate))[0] or 'application/octet-stream'
            self.send_response(200)
            self.send_header('Content-Type', content_type + ('; charset=utf-8' if content_type.startswith('text/') or content_type in ('application/javascript', 'application/json') else ''))
            self.send_header('Content-Length', str(len(body)))
            if compressible:
                self.send_header('Vary', 'Accept-Encoding')
            if compressed:
                self.send_header('Content-Encoding', 'gzip')
            self.send_header('Cache-Control', 'no-store' if candidate.suffix == '.html' else 'no-cache')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
        except (Invalid, ValueError, UnicodeError):
            self.error(403, '不允许访问该路径')
        except OSError:
            self.error(400, '地图资源读取失败')

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if not self.check_host():
            return
        if self.path not in (API, ANNOTATIONS_API, CHARACTERS_API, GENEALOGIES_API, PLACE_PERIODS_API):
            self.error(403, '不允许向此路径写入')
            return
        origins = self.headers.get_all('Origin', [])
        if len(origins) != 1 or origins[0] != 'http://' + self.headers['Host']:
            self.error(403, '编辑仅允许可信局域网内的同源网页提交')
            return
        if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
            self.error(400, '提交格式必须为application/json')
            return
        lengths = self.headers.get_all('Content-Length', [])
        if (self.headers.get('Transfer-Encoding') is not None or len(lengths) != 1
                or not re.fullmatch(r'[0-9]{1,6}', lengths[0])):
            self.error(400, '请求长度不正确')
            return
        length = int(lengths[0])
        if not 1 <= length <= MAX_BODY:
            self.error(400, '请求过大或正文为空')
            return
        try:
            self.connection.settimeout(15)
            body = self.rfile.read(length)
            if len(body) != length:
                raise Invalid('请求正文不完整')
            payload = strict_json(body.decode('utf-8'))
            if self.path == ANNOTATIONS_API:
                state = self.server.annotations.commit(payload, self.server.place_search, self.server.store)
            elif self.path == CHARACTERS_API:
                state = self.server.characters.commit(payload)
            elif self.path == GENEALOGIES_API:
                state = self.server.genealogies.commit(payload)
            elif self.path == PLACE_PERIODS_API:
                state = self.server.place_periods.commit(payload)
            else:
                state = self.server.store.commit(payload)
            if state is None:
                self.error(409, '其他浏览器已更改保存数据，请刷新后重试')
            else:
                self.json_response(200, state)
        except GenealogyError as exc:
            self.error(exc.status, str(exc))
        except (Invalid, UnicodeError) as exc:
            self.error(400, str(exc) if isinstance(exc, Invalid) else '请求必须使用UTF-8编码')
        except (OSError, OverflowError, RecursionError):
            self.error(400, '保存失败，请检查服务器存储空间与权限；编辑未提交')

    def do_OPTIONS(self):
        self.error(403, '不开放跨站请求')

    def send_error(self, code, message=None, explain=None):
        self.error(400, '请求格式或方法不受支持')


def main():
    parser = argparse.ArgumentParser(description='可信局域网地图与共享疆域编辑服务（无登录，请勿暴露公网）')
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--data-dir', type=Path, default=Path.home() / '.local/share/tongjian-atlas')
    args = parser.parse_args()
    directory = args.directory.expanduser().resolve()
    data_dir = args.data_dir.expanduser().resolve()
    if data_dir.is_relative_to(directory):
        parser.exit(1, '保存目录必须位于地图公开目录之外。\n')
    try:
        lock = threading.RLock()
        annotations = AnnotationStore(data_dir, lock)
        store = Store(directory, data_dir, custom_places=annotations.custom_places(), lock=lock)
        biography_search = BiographySearch(directory)
        characters = CharacterStore(data_dir, store.polities, biography_search)
        genealogy_search = GenealogySearch(directory)
        genealogies = GenealogyStore(data_dir, characters, genealogy_search)
        geo = read_assignment(directory / 'geo-data.js', 'GEO_DATA')
        place_periods = PlacePeriodStore(data_dir, geo)
        place_search = PlaceSearch(geo, period_store=place_periods, year_bounds=(store.min_year, store.max_year))
        server = ThreadingHTTPServer((args.bind, args.port), Handler)
    except (OSError, Invalid, GenealogyError, KeyError, TypeError, UnicodeError) as exc:
        parser.exit(1, '启动失败（未重置保存数据）：' + str(exc) + '\n')
    server.directory = directory
    server.store = store
    server.annotations = annotations
    server.characters = characters
    server.place_search = place_search
    server.place_periods = place_periods
    server.biography_search = biography_search
    server.genealogy_search = genealogy_search
    server.genealogies = genealogies
    actual_port = server.server_address[1]
    server.allowed_hosts = {f'{host}:{actual_port}'.lower() for host in (args.bind, 'localhost', '127.0.0.1')}
    print(f'地图：http://{args.bind}:{actual_port}/  保存：{store.path}、{annotations.path}、{characters.path}、{genealogies.path} 与 {place_periods.path}\n无登录，仅供可信局域网；请勿开放公网。', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
