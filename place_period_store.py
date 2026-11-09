"""Independent user display dates; original historical source data stays untouched."""
import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone

from place_search import Invalid


MAX_STORE = 8 * 1024 * 1024
MAX_REVISION = 9007199254740991


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Invalid('显示年代保存文件含重复字段；未重置数据')
            result[key] = value
        return result

    def invalid_number(_value):
        raise Invalid('显示年代保存文件含无效数值；未重置数据')

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_number)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise Invalid('显示年代保存文件JSON无效；未重置数据') from exc


class PlacePeriodStore:
    def __init__(self, data_dir, geo):
        self.places = frozenset(row['id'] for row in geo['places'])
        self.lock = threading.RLock()
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = data_dir / 'place-periods.json'
        if self.path.is_symlink():
            raise Invalid('显示年代保存文件不可为符号链接')
        self.state = {'revision': 0, 'overrides': []}
        if self.path.exists():
            if self.path.stat().st_size > MAX_STORE:
                raise Invalid('显示年代保存文件过大；未重置数据')
            state = strict_json(self.path.read_text(encoding='utf-8'))
            self.validate_state(state)
            self.state = state

    def validate_place(self, place_id):
        if not isinstance(place_id, str) or place_id not in self.places:
            raise Invalid('请选择原始地图中的已知地点')

    def validate_period(self, begin, end):
        if (type(begin) is not int or type(end) is not int
                or not -5000 <= begin <= end <= 9999):
            raise Invalid('显示年代须为-5000至9999之间的整数，且起年不得晚于止年')

    def validate_state(self, state):
        if (not isinstance(state, dict) or set(state) != {'revision', 'overrides'}
                or type(state['revision']) is not int
                or not 0 <= state['revision'] <= MAX_REVISION
                or not isinstance(state['overrides'], list)
                or len(state['overrides']) > len(self.places)):
            raise Invalid('显示年代保存文件格式无效；未重置数据')
        seen = set()
        for entry in state['overrides']:
            if not isinstance(entry, dict) or set(entry) != {'placeId', 'begin', 'end', 'updatedAt'}:
                raise Invalid('显示年代保存记录字段无效；未重置数据')
            self.validate_place(entry['placeId'])
            self.validate_period(entry['begin'], entry['end'])
            if entry['placeId'] in seen:
                raise Invalid('显示年代保存记录地点重复；未重置数据')
            seen.add(entry['placeId'])
            timestamp = entry['updatedAt']
            try:
                if (not isinstance(timestamp, str)
                        or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', timestamp)):
                    raise ValueError()
                datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            except ValueError as exc:
                raise Invalid('显示年代保存记录时间无效；未重置数据') from exc

    def commit(self, payload):
        if (not isinstance(payload, dict) or type(payload.get('revision')) is not int
                or not 0 <= payload['revision'] <= MAX_REVISION):
            raise Invalid('请求须包含有效非负整数revision')
        op = payload.get('op')
        expected = {'op', 'revision', 'placeId'} | ({'begin', 'end'} if op == 'set' else set())
        if op not in ('set', 'reset') or set(payload) != expected:
            raise Invalid('显示年代操作或请求字段不正确')
        self.validate_place(payload['placeId'])
        if op == 'set':
            self.validate_period(payload['begin'], payload['end'])
        with self.lock:
            if payload['revision'] != self.state['revision']:
                return None
            if self.state['revision'] >= MAX_REVISION:
                raise Invalid('保存版本已达上限')
            overrides = [entry for entry in self.state['overrides']
                         if entry['placeId'] != payload['placeId']]
            if op == 'set':
                overrides.append({'placeId': payload['placeId'], 'begin': payload['begin'],
                                  'end': payload['end'],
                                  'updatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')})
            state = {'revision': self.state['revision'] + 1, 'overrides': overrides}
            encoded = json.dumps(state, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
            if len(encoded) > MAX_STORE:
                raise Invalid('显示年代保存总量已达上限')
            temporary = None
            try:
                fd, temporary = tempfile.mkstemp(prefix='.place-periods-', suffix='.tmp', dir=self.path.parent)
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
