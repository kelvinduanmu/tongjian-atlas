"""Bounded, provenance-preserving place searches; never invent coordinates."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import json
import math
import re
import secrets
import threading
import time
import unicodedata
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class Invalid(ValueError):
    pass


KINDS = {'city', 'county', 'lake', 'river'}
CANDIDATE_FIELDS = {'name', 'kind', 'lon', 'lat', 'address', 'provider', 'providerId',
                    'matchedName', 'sourceUrl', 'license', 'temporalNote',
                    'coordinatePrecision', 'period'}
HISTORICAL = 'https://chgis.hudci.org/tgaz/placename'
PHOTON = 'https://photon.komoot.io/api/'


def in_bounds(lon, lat):
    return (type(lon) in (int, float) and type(lat) in (int, float)
            and math.isfinite(lon) and math.isfinite(lat)
            and 73 <= lon <= 136 and 15 <= lat <= 54)


def period_of(begin, end):
    try:
        begin, end = int(begin), int(end)
        if not begin or not end or not -3000 <= begin <= end <= 2100:
            return None
        return {'begin': begin, 'end': end}
    except (ValueError, TypeError, OverflowError):
        return None


def validate_candidate(candidate):
    if not isinstance(candidate, dict) or set(candidate) != CANDIDATE_FIELDS:
        raise Invalid('地点资料字段不正确；未重置数据')
    if candidate['kind'] not in KINDS or not in_bounds(candidate['lon'], candidate['lat']):
        raise Invalid('地点类型或坐标无效；未重置数据')
    for key in CANDIDATE_FIELDS - {'lon', 'lat', 'period'}:
        value = candidate[key]
        maximum = 80 if key == 'name' else 4000
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            raise Invalid('地点资料字段无效：' + key)
    if candidate['provider'] not in ('local', 'CHGIS', 'Photon / OpenStreetMap', '历史地名考证'):
        raise Invalid('地点来源无效')
    url = urlsplit(candidate['sourceUrl'])
    if url.scheme not in ('http', 'https') or not url.netloc or url.username or url.password:
        raise Invalid('地点来源链接无效')
    period = candidate['period']
    if period is not None and (not isinstance(period, dict) or set(period) != {'begin', 'end'}
                              or any(type(v) is not int for v in period.values())
                              or period_of(period['begin'], period['end']) != period):
        raise Invalid('地点年代无效')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Invalid('上游返回重定向，暂不使用该结果')


def remote_json(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc not in ('chgis.hudci.org', 'photon.komoot.io'):
        raise Invalid('不允许的上游地址')
    request = Request(url, headers={'User-Agent': 'EasternJinAtlas/1.0 (trusted-LAN historical map)',
                                    'Accept': 'application/json'})
    with build_opener(NoRedirect()).open(request, timeout=6) as response:
        body = response.read(2 * 1024 * 1024 + 1)
    if len(body) > 2 * 1024 * 1024:
        raise Invalid('上游结果过大')
    # Some CHGIS canonical source notes contain literal newlines inside strings.
    # Tolerate that upstream defect only here, never in client or stored JSON.
    canonical = (parsed.netloc == 'chgis.hudci.org'
                 and re.fullmatch(r'/tgaz/placename/json/hvd_[0-9]+', parsed.path) is not None)
    return json.loads(body.decode('utf-8'), strict=not canonical)


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value).casefold()
                   if not unicodedata.combining(c) and not c.isspace())


def historical_kind(feature, kind):
    if kind == 'city':
        return bool(re.search(r'县|縣|城|\bxian\b|\bcity\b|\btown\b|settlement', feature, re.I))
    if kind == 'county':
        return bool(re.search(r'县|縣|郡|州|府|尹|\bxian\b|\bjun\b|\bzhou\b|prefecture|county', feature, re.I))
    if kind == 'lake':
        return bool(re.search(r'湖|\blake\b', feature, re.I))
    return bool(re.search(r'河|江|水道|\briver\b|\bstream\b', feature, re.I))


def photon_kind(properties, kind):
    key, value = properties.get('osm_key'), properties.get('osm_value')
    if kind == 'lake':
        # natural=water alone does not distinguish a lake from a pond/reservoir.
        return (key, value) in (('water', 'lake'), ('natural', 'lake'))
    if kind == 'river':
        return (key, value) in (('waterway', 'river'), ('water', 'river'))
    if kind == 'city':
        return ((key == 'place' and value in ('city', 'town', 'village', 'hamlet'))
                or (key == 'historic' and value in ('city', 'town', 'settlement'))
                or (key == 'boundary' and value == 'administrative'
                    and properties.get('type') == 'city'))
    return ((key == 'boundary' and value == 'administrative'
             and properties.get('type') in ('county', 'district', 'city', 'state'))
            or (key == 'place' and value in ('county', 'district', 'state', 'province')))


class PlaceSearch:
    def __init__(self, geo, period_store=None):
        self.geo = geo
        self.period_store = period_store
        self.cache = OrderedDict()
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(4)

    def local(self, query, kind, year, scope):
        overrides = {}
        if self.period_store is not None:
            with self.period_store.lock:
                overrides = {entry['placeId']: entry for entry in self.period_store.state['overrides']}
        water = kind in ('lake', 'river')
        rows = [(row, kind) for row in (self.geo.get(kind + 'Labels', []) if water else self.geo['places'])]
        # Explicitly researched historical water names may be found under another
        # category, but retain their documented type rather than becoming cities.
        for native_kind in ('lake', 'river'):
            if native_kind != kind:
                rows.extend((row, native_kind) for row in self.geo.get(native_kind + 'Labels', [])
                            if row.get('historical') is True)
        matches = []
        for row, native_kind in rows:
            native_water = native_kind in ('lake', 'river')
            researched = row.get('historical') is True
            if scope == 'modern' and (researched or not native_water):
                continue
            if scope == 'historical' and native_water and not researched:
                continue
            feature = row.get('kind', '')
            if row.get('referenceSite') is True and not any(historical_kind(feature, settlement) for settlement in ('city', 'county')):
                feature = '郡治参照' if '郡' in row['name'] or '州' in row['name'] else '古城参照'
            names = [row['name'], *row.get('aliases', [])]
            matched = next((name for name in names if normalized(query) == normalized(name)), None)
            if matched is None and native_kind == kind:
                matched = next((name for name in names if normalized(query) in normalized(name)), None)
            if not native_water and not historical_kind(feature, kind):
                # Exact city/prefecture names remain discoverable across the two
                # settlement filters, without relabeling a city as a county.
                if matched is None or normalized(matched) != normalized(query) or kind not in ('city', 'county'):
                    continue
                other_kind = 'county' if kind == 'city' else 'city'
                if not historical_kind(feature, other_kind):
                    continue
                native_kind = other_kind
            if matched is None or not in_bounds(row['lon'], row['lat']):
                continue
            raw_period = row.get('period') or {}
            period = period_of(raw_period.get('begin'), raw_period.get('end'))
            reference_site = row.get('referenceSite') is True
            override = overrides.get(row['id']) if not native_water else None
            if override is not None:
                if not override['begin'] <= year <= override['end']:
                    continue
            elif not reference_site and period is not None and not period['begin'] <= year <= period['end']:
                continue
            source = row.get('source', '')
            if isinstance(source, list):
                source = source[0] if source else ''
            note = row.get('note') or ('现代自然地理参照，不代表古代河道或湖岸。' if native_water else '内置历史地点代表点，不推断各年实际统治。')
            if override is not None:
                note += (f" 原始来源年代：{raw_period.get('begin', '未载')}—{raw_period.get('end', '未载')}年；"
                         f"用户显示年代：{override['begin']}—{override['end']}年。"
                         '用户显示年代非史料修订，不是历史建置有效期证据；不证明所选年份的建置、都城身份或政治归属。')
                period = None
            elif reference_site:
                note += ' 固定古址参照，不按参考图年份筛除；不证明所选年份的建置、都城身份或政治归属。'
                period = None
            license_text = row.get('license') or (
                '依原始来源条款；考证位置不是原图测绘数据' if researched else
                'Natural Earth 公有领域' if native_water else
                'CC BY-NC 4.0（非商业）' if 'chgis.' in source else
                '依原始来源条款；未声明开放许可')
            candidate = dict(name=row['name'], kind=native_kind, lon=row['lon'], lat=row['lat'],
                             address=row.get('address') or row.get('modernName') or row['name'],
                             provider='历史地名考证' if researched else 'local',
                             providerId=row['id'], matchedName=matched, sourceUrl=source,
                             license=license_text, temporalNote=note,
                             coordinatePrecision=row.get('coordinatePrecision') or '内置资料代表点；非城墙、辖界、河道或湖面测绘',
                             period=period)
            validate_candidate(candidate)
            matches.append((normalized(matched) != normalized(query), not researched, candidate))
        matches.sort(key=lambda entry: entry[:2])
        return [candidate for _, _, candidate in matches[:20]]

    def historical(self, query, kind, year):
        data = remote_json(HISTORICAL + '?' + urlencode({'n': query, 'yr': year, 'fmt': 'json'}))
        candidates = []
        for row in data.get('placenames', [])[:100]:
            if not isinstance(row, dict) or not historical_kind(row.get('feature type', ''), kind):
                continue
            provider_id = row.get('sys_id', '')
            if not re.fullmatch(r'hvd_[0-9]+', provider_id) or row.get('object type') != 'POINT':
                continue
            years = re.fullmatch(r'\s*(-?\d+)\s*~\s*(-?\d+)\s*', row.get('years', ''))
            period = period_of(*years.groups()) if years else None
            if period is None or not period['begin'] <= year <= period['end']:
                continue
            try:
                lon, lat = [float(value.strip()) for value in row['xy coordinates'].split(',')]
            except (ValueError, TypeError, KeyError):
                continue
            if not in_bounds(lon, lat):
                continue
            name = row.get('name')
            if not isinstance(name, str) or not name.strip() or len(name) > 80:
                continue
            candidate = dict(name=name, kind=kind, lon=lon, lat=lat,
                             address=row.get('parent name') or name, provider='CHGIS',
                             providerId=provider_id, matchedName=name,
                             sourceUrl=HISTORICAL + '/' + provider_id,
                             license='CC BY-NC 4.0（确认保存时核实原记录许可）',
                             temporalNote=f"历史建置记录：{period['begin']}—{period['end']}年；不等同于该年实际统治。",
                             coordinatePrecision='历史资料代表点；保存时核对原记录，非精密城址或边界测绘', period=period)
            validate_candidate(candidate)
            candidates.append(candidate)
        return candidates[:20]

    def modern(self, query, kind, year):
        tags = {'lake': ['water:lake', 'natural:lake'], 'river': ['waterway:river', 'water:river'],
                'city': ['place:city', 'place:town', 'place:village', 'place:hamlet',
                         'historic:city', 'historic:town', 'historic:settlement', 'boundary:administrative'],
                'county': ['boundary:administrative', 'place:county', 'place:district', 'place:state', 'place:province']}[kind]
        params = [('q', query), ('limit', '20'), ('bbox', '73,15,136,54'), ('dedupe', '0')]
        params.extend(('osm_tag', tag) for tag in tags)
        data = remote_json(PHOTON + '?' + urlencode(params))
        candidates = []
        for row in data.get('features', [])[:100]:
            properties, geometry = row.get('properties', {}), row.get('geometry', {})
            if not photon_kind(properties, kind) or geometry.get('type') != 'Point':
                continue
            coords = geometry.get('coordinates', [])
            if len(coords) != 2 or not in_bounds(*coords):
                continue
            name = properties.get('name')
            osm_type, osm_id = properties.get('osm_type'), properties.get('osm_id')
            if (not isinstance(name, str) or not name.strip() or len(name) > 80
                    or osm_type not in ('N', 'W', 'R') or type(osm_id) is not int or osm_id <= 0):
                continue
            address = []
            for field in ('country', 'state', 'county', 'city', 'district', 'locality', 'street', 'housenumber', 'postcode'):
                value = properties.get(field)
                if isinstance(value, str) and value and value not in address:
                    address.append(value)
            source_type = {'N': 'node', 'W': 'way', 'R': 'relation'}[osm_type]
            candidate = dict(name=name, kind=kind, lon=coords[0], lat=coords[1],
                             address=' / '.join(address) or name, provider='Photon / OpenStreetMap',
                             providerId=f'{osm_type}/{osm_id}', matchedName=name,
                             sourceUrl=f'https://www.openstreetmap.org/{source_type}/{osm_id}',
                             license='© OpenStreetMap contributors · ODbL 1.0；Photon地名检索',
                             temporalNote=f'现代地理参照，不能证明{year}年古地名、古治所或归属。'
                                          + ('河湖仅标定位点，不表示古河道或湖面。' if kind in ('river', 'lake') else ''),
                             coordinatePrecision='OSM/Photon代表点或中心点；不是精密历史测绘', period=None)
            validate_candidate(candidate)
            candidates.append(candidate)
        return candidates[:20]

    def search(self, params):
        if set(params) - {'q', 'kind', 'year', 'scope'} or not {'q', 'kind', 'year'} <= set(params):
            raise Invalid('搜索参数应为q、kind、year及可选scope')
        query, kind, scope = params['q'].strip(), params['kind'], params.get('scope', 'auto')
        if not 1 <= len(query) <= 80 or any(ord(c) < 32 for c in query):
            raise Invalid('搜索名称须为1至80字')
        if kind not in KINDS or scope not in ('auto', 'historical', 'modern'):
            raise Invalid('搜索类别或来源范围不正确')
        if not re.fullmatch(r'\d{3}', params['year']) or not 304 <= int(params['year']) <= 439:
            raise Invalid('搜索年份须为304至439')
        year = int(params['year'])
        if not self.slots.acquire(blocking=False):
            raise Invalid('搜索繁忙，请稍后重试')
        try:
            candidates = self.local(query, kind, year, scope)
            warnings = ['搜索范围：东亚73°—136°E、15°—54°N；须自行核对同名异地与历史年代。']
            if any(candidate['kind'] != kind for candidate in candidates):
                warnings.append('发现名称完全匹配的其他类别本地地点，已按资料中的真实类别列出；不会把城邑、郡县、河湖互相改类。')
            jobs = []
            local_exact = scope == 'auto' and any(normalized(candidate['matchedName']) == normalized(query) for candidate in candidates)
            if local_exact:
                warnings.append('已优先返回本地精确名称候选，无需等待外部网站；如需更多同名结果，可选择历史或现代来源重新检索。')
            with ThreadPoolExecutor(max_workers=2) as pool:
                if not local_exact and scope in ('auto', 'historical'):
                    jobs.append(('CHGIS历史地名', pool.submit(self.historical, query, kind, year)))
                if not local_exact and scope in ('auto', 'modern'):
                    jobs.append(('Photon现代地名', pool.submit(self.modern, query, kind, year)))
                for label, future in jobs:
                    try:
                        candidates.extend(future.result())
                    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
                        warnings.append(label + '查询暂不可用；未用虚构坐标替代，请稍后重试。')
            result, seen = [], set()
            with self.lock:
                now = time.monotonic()
                self._expire(now)
                for candidate in candidates:
                    key = (candidate['sourceUrl'], candidate['kind'], candidate['lon'], candidate['lat'])
                    if key in seen:
                        continue
                    seen.add(key)
                    candidate_id = secrets.token_urlsafe(24)
                    self.cache[candidate_id] = (now + 900, candidate, year)
                    result.append(dict(candidate, candidateId=candidate_id))
                    if len(result) == 20:
                        break
                while len(self.cache) > 2000:
                    self.cache.popitem(last=False)
            if not result:
                warnings.append('没有找到符合类别与范围的地点；可核对拼写、使用历史名称或切换来源，不能据此断言古地名不存在。')
            return {'candidates': result, 'warnings': warnings}
        finally:
            self.slots.release()

    def _expire(self, now):
        while self.cache and next(iter(self.cache.values()))[0] <= now:
            self.cache.popitem(last=False)

    def resolve(self, candidate_id):
        if not isinstance(candidate_id, str) or len(candidate_id) > 100:
            raise Invalid('候选编号无效，请重新搜索')
        with self.lock:
            self._expire(time.monotonic())
            cached = self.cache.get(candidate_id)
            if cached is None:
                raise Invalid('候选已过期或服务器已重启，请重新搜索并确认位置')
            _, original, year = cached
            candidate = dict(original)
        if candidate['provider'] == 'CHGIS':
            try:
                canonical = remote_json(HISTORICAL + '/json/' + candidate['providerId'])
                temporal, spatial = canonical['temporal'], canonical['spatial']
                period = period_of(temporal['begin'], temporal['end'])
                lon, lat = float(spatial['longitude']), float(spatial['latitude'])
                if (canonical.get('sys_id') != candidate['providerId']
                        or spatial.get('object_type') != 'POINT' or not in_bounds(lon, lat)
                        or period is None or not period['begin'] <= year <= period['end']
                        or not historical_kind(' '.join(canonical['feature_type'].values()), candidate['kind'])
                        or abs(lon - candidate['lon']) > 0.00001 or abs(lat - candidate['lat']) > 0.00001
                        or period != candidate['period'] or canonical.get('license') != 'CC BY-NC 4.0'):
                    raise Invalid('CHGIS原记录年代、位置或许可与候选不符；未保存，请重新搜索或选择其他来源')
                candidate.update(lon=lon, lat=lat, license='CC BY-NC 4.0（非商业；已核对CHGIS原记录）',
                                 coordinatePrecision='CHGIS历史资料代表点（已核对原记录）；非精密城址或边界测绘')
                locations = spatial.get('present_location', [])
                address = ' / '.join(p['text'] for p in locations if isinstance(p.get('text'), str) and p['text'])
                if address:
                    candidate['address'] = candidate['address'] + '；' + address
            except Invalid:
                raise
            except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
                raise Invalid('无法核实CHGIS原记录，未保存；请稍后重试') from exc
        validate_candidate(candidate)
        return candidate
