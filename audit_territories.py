#!/usr/bin/env python3
"""Reproducible point/territory evidence audit; never modifies atlas source data.

Run with the Shapely-enabled interpreter in /tmp/jin-map-tools/bin/python.
Only missing CHGIS parent records are fetched; --offline uses the saved cache.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
from urllib.request import HTTPRedirectHandler, Request, build_opener

from shapely.geometry import Point, shape
from shapely.ops import nearest_points, unary_union
from shapely.prepared import prep


POLITY_NAMES = {
    "western-jin": ["西晋", "西晉"],
    "eastern-jin": ["东晋", "東晉"],
    "liu-song": ["南朝宋", "刘宋", "劉宋"],
    "han-zhao": ["汉前赵", "漢前趙", "汉赵", "漢趙", "前赵", "前趙"],
    "later-zhao": ["后赵", "後趙"],
    "cheng-han": ["成汉", "成漢"],
    "former-liang": ["前凉", "前涼"],
    "former-qin": ["前秦"],
    "later-qin": ["后秦", "後秦"],
    "western-qin": ["西秦"],
    "murong": ["慕容部"],
    "former-yan": ["前燕"],
    "later-yan": ["后燕", "後燕"],
    "western-yan": ["西燕"],
    "southern-yan": ["南燕"],
    "northern-yan": ["北燕"],
    "later-liang": ["后凉", "後涼"],
    "southern-liang": ["南凉", "南涼"],
    "western-liang": ["西凉", "西涼"],
    "northern-liang": ["北凉", "北涼"],
    "dai": ["代", "代国", "代國"],
    "northern-wei": ["北魏"],
    "xia": ["夏", "胡夏"],
    "ran-wei": ["冉魏"],
    "qiao-shu": ["谯蜀", "譙蜀"],
    "huan-chu": ["桓楚"],
    "qiuchi": ["仇池", "前仇池", "后仇池", "後仇池"],
    "tuyuhun": ["吐谷浑", "吐谷渾"],
    "duan-xianbei": ["段部", "段部鲜卑", "段部鮮卑"],
}
# IDs are taken from the local canonical parent links, not guessed from numbering.
POLITY_IDS = {
    "hvd_113660": "western-jin", "hvd_113661": "western-jin",
    "hvd_113686": "eastern-jin", "hvd_113687": "liu-song",
    "hvd_113662": "han-zhao", "hvd_113665": "later-zhao",
    "hvd_113664": "former-liang", "hvd_113668": "former-qin",
    "hvd_113669": "later-qin", "hvd_113672": "western-qin",
    "hvd_113667": "former-yan", "hvd_113670": "later-yan",
    "hvd_113675": "southern-yan", "hvd_113678": "northern-yan",
    "hvd_113676": "western-liang", "hvd_113679": "northern-liang",
    "hvd_113680": "northern-wei", "hvd_113681": "northern-wei",
    "hvd_113677": "xia", "hvd_113666": "ran-wei",
}
# Reviewed polity-wide bounds, distinct from canonical capital/phase records.
# Former Liang's disputed starting convention is deliberately left unspecified.
POLITY_LIFESPANS = {"western-jin": (265, 316), "former-yan": (337, 370),
                    "former-qin": (351, 394), "former-liang": (None, 376)}
NAME_TO_POLITY = {name: polity for polity, names in POLITY_NAMES.items() for name in names}
STATUSES = ["核对一致", "矛盾待核", "范围缺失", "行政证据不足", "当年无效", "固定参考"]
REASONS = {
    "reference": "固定地标：年代不表示连续统治",
    "outside-period": "不在记录建置年代内",
    "unknown-period": "记录年代无法完整解析",
    "no-geometry": "未被任何政治面覆盖",
    "multiple-owners": "同一点被多个政治实体覆盖",
    "overlapping-features": "同一点位于多个政治面的内部",
    "boundary": "点恰在概略政治面边线上",
    "near-boundary": "距概略面边线不足10公里，仅作复核优先级",
    "owner-mismatch": "政治面与行政链指向不一致，须史料复核",
    "no-polity": "没有覆盖当年的完整政治实体父级链",
    "partial-chain": "部分当年行政分支未到达政治实体",
    "multiple-expected": "行政链指向多个政治实体",
    "missing-parent": "缺少父级canonical记录",
    "no-active-parent": "不存在覆盖当年的行政父级边",
    "unknown-edge-period": "父级边年代不完整，未沿用",
    "parent-outside-period": "父级记录不在当年有效期内",
    "polity-outside-period": "行政源边指向不可能存续于当年的政治实体，已排除该归属",
    "polity-not-in-snapshot": "行政链所指政治实体不在当年断面中，不能直接采信",
    "polity-record-phase": "父级canonical只代表该政权的某一阶段，当年不在此条目时段；不等于政权不存在",
    "polity-lifespan-unconfirmed": "已缓存同政权条目时段并集未覆盖当年且无明确国祚约束，仅列不确定而不删除归属",
    "cycle": "行政父级链循环或超过深度限制",
    "approx-endpoint": "处于约年起止端点附近，不能断言当年归属",
    "edge-endpoint": "处于行政边起止年，无月日不能对应事件后断面",
    "succession-year": "403/420继承变局年：行政建置不等于事件后实控",
    "relocated": "原始条目提及侨置、寄治或迁治，代表点须定位复核",
    "cross-era-point": "代表点记录跨百年以上，未证实当年治所坐标",
    "same-name-sources": "同年存在同名多条记录，未确认是否同一治所",
    "polity-id-name-conflict": "父级ID与政治实体名称映射冲突",
    "invalid-coordinate": "坐标缺失或超出经纬度范围",
    "invalid-geometry": "原始政治面无效，未自行修复边界",
    "geometry-error": "几何运算失败，不能判为通过",
    "curated-evidence": "使用有明确地点与年代的人工复核证据，不构成精密县界证明",
    "source-conflict": "人工复核证据与原行政链冲突，原链保留供复核",
    "curated-conflict": "同年人工复核规则之间归属冲突，未擅自选取一条",
    "outside-modern-land": "古治所代表点在现代概化陆地之外，需核查坐标/古岸线；不等同于当年不属该政权",
}
BASE_URL = "https://chgis.hudci.org/tgaz/placename/"
RELOCATION = re.compile(r"侨|僑|寄治|遥领|遙領|迁治|遷治|徙治|移治|移置|迁置|遷置")


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"), strict=False)


def load_assignment(path, variable):
    text = Path(path).read_text(encoding="utf-8")
    match = re.search(r"(?:window\.)?" + re.escape(variable) + r"\s*=\s*", text)
    if not match:
        raise ValueError(f"{path}: missing {variable} JSON assignment")
    data, end = json.JSONDecoder(strict=False).raw_decode(text[match.end():].lstrip())
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def number(value):
    if isinstance(value, bool):
        return None
    text = str(value).strip()
    return int(text) if re.fullmatch(r"-?\d+", text) else None


def interval(record, edge=False):
    return (number(record.get("begin year" if edge else "begin")),
            number(record.get("end year" if edge else "end")))


def active(record, year, edge=False):
    start, end = interval(record, edge)
    return start is not None and end is not None and start <= year <= end


def polity_for(edge):
    by_id = POLITY_IDS.get(edge.get("parent id"))
    by_name = NAME_TO_POLITY.get(edge.get("name", "").strip())
    return by_id or by_name, bool(by_id and by_name and by_id != by_name)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("CHGIS redirect refused")


def fetch_parent(pid, timeout):
    url = BASE_URL + "json/" + pid
    try:
        if not re.fullmatch(r"hvd_\d+", pid):
            raise ValueError("invalid canonical id")
        request = Request(url, headers={"User-Agent": "EasternJinAtlas/territory-audit", "Accept": "application/json"})
        with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError("canonical exceeds 2 MiB")
        record = json.loads(body.decode("utf-8"), strict=False)
        if not isinstance(record, dict) or record.get("sys_id") != pid:
            raise ValueError("canonical identity mismatch")
        return pid, {"record": record, "url": url}
    except Exception as exc:
        return pid, {"error": f"{type(exc).__name__}: {exc}", "url": url}


def extend_sources(sources, places, years, cache, args):
    entries = cache.setdefault("entries", {})
    for pid, entry in entries.items():
        if "record" in entry and pid not in sources:
            sources[pid] = entry["record"]
    attempted = set() if args.retry_failed else {pid for pid, e in entries.items() if "error" in e}
    requested = 0
    for _ in range(16):
        missing = set()
        for record in sources.values():
            for edge in record.get("historical_context", {}).get("part of", []):
                pid = edge.get("parent id", "")
                if (any(active(edge, year, True) for year in years)
                        and pid not in sources and re.fullmatch(r"hvd_\d+", pid)):
                    missing.add(pid)
        # User-added records may have parent links without a local canonical record.
        for place in places:
            for edge in place.get("administrativeHistory", []):
                pid = edge.get("parent id", "")
                if (any(active(edge, year, True) for year in years)
                        and pid not in sources and re.fullmatch(r"hvd_\d+", pid)):
                    missing.add(pid)
        candidates = sorted(missing - attempted)[:max(0, args.max_fetch - requested)]
        if args.offline or not candidates:
            break
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for pid, entry in pool.map(lambda pid: fetch_parent(pid, args.timeout), candidates):
                entries[pid] = entry
                if "record" in entry:
                    sources[pid] = entry["record"]
        attempted.update(candidates)
        requested += len(candidates)
    return requested


def source_flags(record, year):
    flags = set()
    period = record.get("temporal", {})
    start, end = interval(period)
    for key in ("begin", "end"):
        endpoint = number(period.get(key))
        if endpoint is not None and abs(endpoint - year) <= 1 and str(period.get(key + " rule", "")) != "1":
            flags.add("approx-endpoint")
    if start is not None and end is not None and end - start >= 100:
        flags.add("cross-era-point")
    if RELOCATION.search(record.get("source note", "")):
        flags.add("relocated")
    return flags


class AdministrativeEvidence:
    def __init__(self, sources):
        self.sources = sources
        self.cache = {}
        self.chains = {}
        terminals = dict(POLITY_IDS)
        for record in sources.values():
            for edge in record.get("historical_context", {}).get("part of", []):
                polity, conflict = polity_for(edge)
                if polity and not conflict and edge.get("parent id"):
                    terminals[edge["parent id"]] = polity
        intervals = defaultdict(list)
        self.polity_period_sources = defaultdict(list)
        for pid, polity in terminals.items():
            period = sources.get(pid, {}).get("temporal", {})
            start, end = interval(period)
            if start is not None and end is not None and start <= end:
                intervals[polity].append((start, end))
                self.polity_period_sources[polity].append({"sourceId": pid, "begin": start, "end": end})
        self.polity_periods = {}
        for polity, spans in intervals.items():
            merged = []
            for start, end in sorted(spans):
                if merged and start <= merged[-1][1] + 1:
                    merged[-1][1] = max(merged[-1][1], end)
                else:
                    merged.append([start, end])
            self.polity_periods[polity] = merged

    def walk(self, pid, year, trail=()):
        key = (pid, year)
        if key in self.cache:
            return self.cache[key]
        if pid in trail or len(trail) >= 16:
            return [], {"cycle"}, False
        record = self.sources.get(pid)
        if record is None:
            return [], {"missing-parent"}, False
        flags = source_flags(record, year)
        if not active(record.get("temporal", {}), year):
            return [], flags | {"parent-outside-period"}, False
        edges = record.get("historical_context", {}).get("part of", [])
        selected = [edge for edge in edges if active(edge, year, True)]
        if any(None in interval(edge, True) for edge in edges):
            flags.add("unknown-edge-period")
        if not selected:
            return [], flags | {"no-active-parent"}, False
        paths = []
        complete = True
        for edge in selected:
            parent = edge.get("parent id", "")
            polity, conflict = polity_for(edge)
            link = {"childId": pid, "parentId": parent, "parentName": edge.get("name", ""),
                    "begin": edge.get("begin year"), "end": edge.get("end year")}
            if year in interval(edge, True):
                flags.add("edge-endpoint")
            if conflict:
                flags.add("polity-id-name-conflict")
            if polity:
                terminal = self.sources.get(parent)
                eligible = True
                if terminal is None:
                    flags.add("missing-parent")
                    complete = False
                elif not active(terminal.get("temporal", {}), year):
                    flags.add("polity-record-phase")
                bounds = POLITY_LIFESPANS.get(polity)
                if bounds is not None:
                    start, end = bounds
                    eligible = (start is None or start <= year) and (end is None or year <= end)
                elif not any(start <= year <= end for start, end in self.polity_periods.get(polity, [])):
                    flags.add("polity-lifespan-unconfirmed")
                    complete = False
                if not eligible:
                    flags.add("polity-outside-period")
                    complete = False
                paths.append({"polityId": polity, "edges": [link], "eligible": eligible})
            else:
                subpaths, subflags, subcomplete = self.walk(parent, year, trail + (pid,))
                flags.update(subflags)
                complete = complete and subcomplete
                paths.extend(dict(path, edges=[link] + path["edges"]) for path in subpaths)
        result = paths, flags, complete
        self.cache[key] = result
        return result

    def evidence(self, pid, year):
        paths, flags, complete = self.walk(pid, year)
        ids = []
        for path in paths:
            encoded = json.dumps(path, ensure_ascii=False, sort_keys=True)
            key = "chain-" + hashlib.sha256(encoded.encode()).hexdigest()[:16]
            self.chains[key] = path
            ids.append(key)
        return sorted({p["polityId"] for p in paths if p.get("eligible", True)}), sorted(set(ids)), set(flags), complete


def region(place):
    lon, lat = place.get("lon"), place.get("lat")
    if not isinstance(lon, (float, int)) or not isinstance(lat, (float, int)):
        return "坐标不明"
    if lat < 22.5 and lon < 108.5:
        return "交州（坐标分组）"
    if lat < 29.5 and lon < 106:
        return "宁州南中（坐标分组）"
    if lat < 26.5 and lon >= 106:
        return "岭南（坐标分组）"
    if lon < 106 and lat >= 29.5:
        return "西北巴蜀（坐标分组）"
    if lat >= 34:
        return "北方（坐标分组）"
    return "江淮荆扬（坐标分组）"


def distance_km(point, geometry):
    if geometry is None or geometry.is_empty:
        return None
    nearest = nearest_points(point, geometry)[1]
    # Local equirectangular length, not a survey/geodesic boundary measurement.
    mean_lat = math.radians((point.y + nearest.y) / 2)
    return round(111.195 * math.hypot((point.x - nearest.x) * math.cos(mean_lat), point.y - nearest.y), 2)


def prepare_geometry(snapshot):
    geometries = []
    issues = []
    for index, feature in enumerate(snapshot.get("features", [])):
        polity = feature.get("properties", {}).get("polityId")
        try:
            geom = shape(feature["geometry"])
            if not geom.is_valid or geom.geom_type not in ("Polygon", "MultiPolygon") or not polity:
                issues.append({"featureIndex": index, "polityId": polity, "reason": "invalid-geometry"})
                continue
            geometries.append((polity, geom, index))
        except Exception as exc:
            issues.append({"featureIndex": index, "polityId": polity, "reason": "invalid-geometry", "error": str(exc)})
    boundaries = unary_union([geom.boundary for _, geom, _ in geometries])
    return geometries, boundaries, issues


def normalized_name(place):
    # No fuzzy/simplified conversion: only identical display names count as potential duplicates.
    return re.sub(r"\s+", "", place.get("name", ""))


def curated_index(document, places):
    index = defaultdict(list)
    identifiers = set()
    known_places = {place["id"] for place in places}
    for rule in document.get("rules", []):
        rule_id = rule.get("id")
        start, end = interval(rule)
        if (not isinstance(rule_id, str) or not rule_id or rule_id in identifiers
                or start is None or end is None or start > end
                or not isinstance(rule.get("placeIds"), list) or not rule["placeIds"]
                or not isinstance(rule.get("owners"), list) or not rule["owners"]
                or not isinstance(rule.get("evidence"), list) or not rule["evidence"]):
            raise ValueError(f"Invalid curated evidence rule: {rule_id}")
        if set(rule["owners"]) - set(POLITY_NAMES):
            raise ValueError(f"Unknown polity in curated evidence rule: {rule_id}")
        if set(rule["placeIds"]) - known_places:
            raise ValueError(f"Unknown place ID in curated evidence rule: {rule_id}")
        identifiers.add(rule_id)
        for pid in rule["placeIds"]:
            index[pid].append(rule)
    return index


def audit(places, snapshots, sources, evidence_engine, dataset, curated, modern_land):
    rows, geometry_issues = [], []
    for snapshot in snapshots:
        year = snapshot["year"]
        geometries, boundaries, issues = prepare_geometry(snapshot)
        geometry_issues.extend(dict(issue, year=year, dataset=dataset) for issue in issues)
        names = Counter(normalized_name(p) for p in places if not p.get("referenceSite") and active(p.get("period", {}), year))
        for index, place in enumerate(places):
            pid = place.get("id", f"missing-id-{index}")
            flags = set()
            current, interior, feature_hits = [], [], []
            boundary_distance = None
            expected_distance = None
            point = None
            try:
                lon, lat = float(place["lon"]), float(place["lat"])
                if not math.isfinite(lon) or not math.isfinite(lat) or not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    raise ValueError("invalid coordinates")
                point = Point(lon, lat)
            except (KeyError, ValueError, TypeError):
                flags.add("invalid-coordinate")
            if issues:
                flags.add("invalid-geometry")
            expected, chain_ids, admin_flags, complete = evidence_engine.evidence(pid, year)
            flags.update(admin_flags)
            administrative_expected = list(expected)
            rules = [rule for rule in curated.get(pid, []) if active(rule, year)]
            if rules:
                expected = sorted({owner for rule in rules for owner in rule["owners"]})
                raw_owners = {evidence_engine.chains[cid]["polityId"] for cid in chain_ids}
                flags.intersection_update({"invalid-coordinate", "invalid-geometry", "cross-era-point", "relocated", "approx-endpoint"})
                flags.add("curated-evidence")
                if raw_owners and raw_owners != set(expected):
                    flags.add("source-conflict")
                complete = True
                if len({tuple(sorted(rule["owners"])) for rule in rules}) > 1:
                    flags.add("curated-conflict")
                    complete = False
            if point is not None and not modern_land.covers(point):
                flags.add("outside-modern-land")
            if set(expected) - {owner for owner, _, _ in geometries}:
                flags.add("polity-not-in-snapshot")
            if point is not None:
                try:
                    for owner, geom, feature_index in geometries:
                        if geom.covers(point):
                            current.append(owner)
                            feature_hits.append(feature_index)
                            if geom.contains(point):
                                interior.append(owner)
                    boundary_distance = distance_km(point, boundaries)
                    expected_shapes = [geom for owner, geom, _ in geometries if owner in expected]
                    if expected_shapes:
                        expected_distance = min(distance_km(point, geom) for geom in expected_shapes)
                except Exception:
                    flags.add("geometry-error")
            owners = sorted(set(current))
            if not owners:
                flags.add("no-geometry")
            if len(owners) > 1:
                flags.add("multiple-owners")
            if len(interior) > 1:
                flags.add("overlapping-features")
            if current and len(current) != len(interior):
                flags.add("boundary")
            if boundary_distance is not None and boundary_distance < 10:
                flags.add("near-boundary")
            if not expected:
                flags.add("no-polity")
            if expected and not complete:
                flags.add("partial-chain")
            if len(expected) > 1:
                flags.add("multiple-expected")
            if expected and owners and set(expected) != set(owners):
                flags.add("owner-mismatch")
            if year in (403, 420):
                flags.add("succession-year")
            if names[normalized_name(place)] > 1:
                flags.add("same-name-sources")
            period = place.get("period", {})
            if None in interval(period):
                flags.add("unknown-period")
            in_period = active(period, year)
            uncertain = flags - {"no-geometry", "owner-mismatch", "near-boundary", "curated-evidence", "source-conflict"}
            if place.get("referenceSite"):
                status = "固定参考"
                flags.add("reference")
            elif not in_period and "unknown-period" not in flags:
                status = "当年无效"
                flags.add("outside-period")
            elif {"multiple-owners", "overlapping-features"} & flags:
                status = "矛盾待核"
            elif {"invalid-coordinate", "invalid-geometry", "geometry-error", "unknown-period"} & flags:
                status = "行政证据不足"
            elif not owners:
                status = "范围缺失"
            elif uncertain or not expected or not complete:
                status = "行政证据不足"
            elif "owner-mismatch" in flags:
                status = "矛盾待核"
            else:
                status = "核对一致"
            if status in {"固定参考", "当年无效"} or point is None:
                comparison = "无可比线索"
            elif not owners:
                comparison = "无面"
            elif not expected:
                comparison = "无可比线索"
            elif set(expected) == set(owners):
                comparison = "资料线索与面一致"
            else:
                comparison = "资料线索与面冲突"
            rows.append({"placeId": pid, "placeIndex": index, "year": year,
                         "placeName": place.get("name", ""), "region": region(place),
                         "currentOwners": owners, "expectedOwners": expected,
                         "status": status, "reasons": [REASONS.get(flag, flag) for flag in sorted(flags)],
                         "comparison": comparison,
                         "flags": sorted(flags), "distanceToBoundary": boundary_distance,
                         "distanceToExpectedTerritory": expected_distance,
                         "evidence": {"sourceId": pid, "chainIds": chain_ids, "complete": complete},
                         "geometryFeatureIndices": feature_hits})
            if rules:
                rows[-1]["evidence"].update(curatedRuleIds=[rule["id"] for rule in rules],
                                             administrativeOwners=administrative_expected,
                                             administrativeFlags=sorted(admin_flags))
    return rows, geometry_issues


def summarize(rows):
    by_year, by_region, by_year_comparison = {}, {}, {}
    comparable_rows = [row for row in rows if row["status"] not in {"当年无效", "固定参考"}]
    for row in comparable_rows:
        by_year_comparison.setdefault(str(row["year"]), Counter())[row["comparison"]] += 1
    for row in rows:
        year = str(row["year"])
        by_year.setdefault(year, Counter())[row["status"]] += 1
        by_region.setdefault(row["region"], {}).setdefault(year, Counter())[row["status"]] += 1
    excluded = {"核对一致", "当年无效", "固定参考"}
    anomalies = [i for i, row in enumerate(rows) if row["year"] == 382 and row["status"] not in excluded]
    anomalies.sort(key=lambda i: (rows[i]["region"], STATUSES.index(rows[i]["status"]), rows[i]["placeName"], rows[i]["placeId"]))
    return {"rowCount": len(rows), "byStatus": Counter(row["status"] for row in rows),
            "byYear": dict(sorted(by_year.items(), key=lambda item: int(item[0]))),
            "byRegion": dict(sorted(by_region.items())),
            "comparisonScope": "仅当年有效且非固定参照点；资料线索相合不是历史实控已证实",
            "byComparison": Counter(row["comparison"] for row in comparable_rows),
            "byYearComparison": dict(sorted(by_year_comparison.items(), key=lambda item: int(item[0]))),
            "anomalies382": anomalies, "anomalyCount382": len(anomalies),
            "anomalies382IndexMeaning": "Indices into rows; all active non-reference non-consistent rows, including unknown administrative evidence",
            "byFlag382": Counter(flag for row in rows if row["year"] == 382 and row["status"] not in {"当年无效", "固定参考"} for flag in row["flags"])}


def compare(previous, rows):
    before = {(r["placeId"], r["year"], r.get("placeIndex")): r for r in previous.get("rows", [])}
    fields = ("status", "currentOwners", "expectedOwners", "flags", "distanceToBoundary", "distanceToExpectedTerritory")
    changes, added = [], []
    for row in rows:
        key = (row["placeId"], row["year"], row["placeIndex"])
        old = before.pop(key, None)
        if old is None:
            added.append({"placeId": row["placeId"], "year": row["year"], "placeIndex": row["placeIndex"]})
            continue
        changed = {field: {"before": old.get(field), "after": row[field]} for field in fields if old.get(field) != row[field]}
        if changed:
            changes.append({"placeId": row["placeId"], "year": row["year"], "placeName": row["placeName"], "changes": changed})
    return {"changedCount": len(changes), "addedCount": len(added), "removedCount": len(before), "changes": changes, "added": added,
            "interpretation": "changedCount只比较前后都有的地点/断面；新增及删除行单列，不代表旧问题已经解决。规则和来源补全也会改变status/expectedOwners，不能把所有变化都归于改面。" ,
            "removed": [{"placeId": key[0], "year": key[1], "placeIndex": key[2]} for key in before]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--cache", type=Path, default=None)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=4)
    parser.add_argument("--timeout", type=float, default=8)
    parser.add_argument("--max-fetch", type=int, default=256)
    parser.add_argument("--compare", type=Path, help="Previous audit JSON; adds reproducible row-level differences")
    parser.add_argument("--custom-places", type=Path, help="Optional JSON list or {places: [...]} audited separately")
    parser.add_argument("--custom-history", type=Path, help="Optional JSON {snapshots: [...]} audited separately")
    parser.add_argument("--curated-evidence", type=Path, help="Reviewed place-ID/year rules; defaults to directory/curated-evidence.json when present")
    args = parser.parse_args()
    root = args.directory
    output = args.output or root / "territory-audit.json"
    cache_path = args.cache or root / "audit-source-cache.json"
    if args.timeout <= 0 or args.max_fetch < 0:
        parser.error("timeout must be positive and max-fetch nonnegative")
    inputs = {"geo": root / "geo-data.js", "history": root / "history-data.js", "sources": root / "city-sources.json"}
    curated_path = args.curated_evidence or root / "curated-evidence.json"
    if args.curated_evidence or curated_path.exists():
        inputs["curatedEvidence"] = curated_path
    input_hashes = {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in inputs.items()}
    protected = {path.resolve() for path in inputs.values()}
    protected.update(path.resolve() for path in (args.custom_places, args.custom_history, args.compare) if path)
    if output.resolve() in protected or cache_path.resolve() in protected or output.resolve() == cache_path.resolve():
        raise ValueError("Refusing to overwrite input data or conflate audit and cache")
    geo = load_assignment(inputs["geo"], "GEO_DATA")
    history = load_assignment(inputs["history"], "HISTORY_DATA")
    sources = load_json(inputs["sources"])
    places, snapshots = geo["places"], history["snapshots"]
    years = [snapshot["year"] for snapshot in snapshots]
    if len(years) != len(set(years)):
        raise ValueError("Duplicate snapshot years; audit key would be ambiguous")
    custom_places = load_json(args.custom_places) if args.custom_places else []
    if isinstance(custom_places, dict):
        custom_places = custom_places["places"]
    custom_snapshots = load_json(args.custom_history)["snapshots"] if args.custom_history else []
    curated_document = load_json(curated_path) if "curatedEvidence" in inputs else {"rules": []}
    curated = curated_index(curated_document, places + custom_places)
    # Preserve local canonical data as authoritative; optional records only fill absent IDs.
    for place in places + custom_places:
        if place["id"] not in sources and place.get("administrativeHistory"):
            sources[place["id"]] = {"sys_id": place["id"], "temporal": place.get("period", {}),
                                     "historical_context": {"part of": place["administrativeHistory"]},
                                     "source note": "", "uri": place.get("source")}
    cache = load_json(cache_path) if cache_path.exists() else {"schemaVersion": 1, "entries": {}}
    fetched = extend_sources(sources, places + custom_places, years + [s["year"] for s in custom_snapshots], cache, args)
    if not args.offline:
        cache_path.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    engine = AdministrativeEvidence(sources)
    modern_land = prep(unary_union([shape(feature["geometry"]) for feature in geo["land"]["features"]]))
    rows, geometry_issues = audit(places, snapshots, sources, engine, "original", curated, modern_land)
    if len(rows) != len(places) * len(snapshots):
        raise AssertionError("Audit omitted place/snapshot pairs")
    custom = {"included": False, "rows": [], "note": "User additions and saved territorial overrides are not merged into original snapshot audit; pass explicit custom JSON exports to audit separately."}
    if custom_places or custom_snapshots:
        custom_rows, custom_issues = audit(custom_places or places, custom_snapshots or snapshots, sources, engine, "custom", curated, modern_land)
        geometry_issues.extend(custom_issues)
        custom = {"included": True, "rows": custom_rows, "summary": summarize(custom_rows)}
    used_source_ids = {row["evidence"]["sourceId"] for row in rows + custom["rows"]}
    used_source_ids.update(edge["childId"] for chain in engine.chains.values() for edge in chain["edges"])
    # Include unresolved branches as a compact adjacency index, not only successful chains.
    used_source_ids.update(sources)
    used_source_ids.update(edge.get("parent id", "") for record in sources.values()
                           for edge in record.get("historical_context", {}).get("part of", [])
                           if any(active(edge, year, True) for year in years))
    if any(hashlib.sha256(path.read_bytes()).hexdigest() != input_hashes[key] for key, path in inputs.items()):
        raise ValueError("Atlas inputs changed during audit; rerun against a stable input snapshot")
    result = {
        "schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generator": {"file": "audit_territories.py", "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
        "sourceCacheSha256": hashlib.sha256(json.dumps(cache, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
        "sourceBasis": {
            "scope": "All original GEO_DATA.places × original HISTORY_DATA.snapshots; no annual interpolation or saved user overrides.",
            "interpretation": "行政隶属不等于每年实际控制；明确地点/年代的人工复核规则优先，原行政链保留。核对一致仅表示无已识别疑点时资料证据与概略面相合，不是精确县界或全年实控已证实。范围缺失仅表示未覆盖，并非证明该地属于某国。",
            "maps": "图题/断代/OCR见可用的map-crosscheck.json和map-ocr.json；本工具仅登记其哈希供交叉核验，不声称已看清图面边界，不将盛时图或不同年图直接作为当年归属。",
            "temporal": "Only parent edges whose inclusive numeric begin/end cover the snapshot year are traversed. Unknown periods, predecessor/successor links and other-year parents are never borrowed. Approximate endpoints use ±1 year solely as a review heuristic, not a historical dating confidence interval; rule codes other than 1 follow existing atlas display caution.",
            "uncertainty": "侨寄迁治原文提示、跨百年代表点、同年同名多记录、行政边端点及403/420变局均不自动通过。行政链任何分支不完整亦不通过。",
            "distance": "distanceToBoundary / distanceToExpectedTerritory: approximate km; degree-plane nearest point followed by local equirectangular conversion, not an exact geodesic minimum. Null means unavailable; 10 km is a review priority only, never a correction tolerance.",
            "modernLand": "outside-modern-land使用原始GEO_DATA.land现代概化陆地covers判定，只提示坐标/古岸线待核，不改变点位、政治面或资料归属；即使有人工归属规则也不自动消除此警告。" ,
            "region": "大区仅按坐标粗分便于排序，非古州界：交州lat<22.5/lon<108.5；宁州南中lat<29.5/lon<106；岭南lat<26.5/lon>=106；其后西北巴蜀lon<106/lat>=29.5；北方lat>=34；余为江淮荆扬。",
            "statusPrecedence": "固定参考 → 当年无效 → 多面问题 → 数据无效 → 范围缺失 → 行政证据不足 → 可信链与面矛盾 → 核对一致。所有附加问题保留于flags/reasons。",
        },
        "inputs": {key: {"file": path.name, "sha256": input_hashes[key]} for key, path in inputs.items()},
        "mapEvidenceFiles": [{"file": name, "sha256": hashlib.sha256((root / name).read_bytes()).hexdigest()}
                             for name in ("map-ocr.json", "map-crosscheck.json", "south-boundary-review.json") if (root / name).exists()],
        "coverage": {"placeCount": len(places), "snapshotCount": len(snapshots), "expectedRowCount": len(places) * len(snapshots), "actualRowCount": len(rows), "snapshotYears": years,
                     "duplicatePlaceIds": {pid: count for pid, count in Counter(p["id"] for p in places).items() if count > 1}},
        "polityMapping": {"exactNames": POLITY_NAMES, "canonicalIds": POLITY_IDS, "historicalLifespans": POLITY_LIFESPANS,
                          "canonicalPeriodUnions": engine.polity_periods, "canonicalPeriodSources": engine.polity_period_sources,
                          "lifespanBasis": "国祚与capital/phase记录分开：西晋265–316、前燕337–370、前秦351–394、前凉止于376。其他同政权canonical时段取并集；并集外无明确国祚限制仅警告，不以单条记录时段删归属。",
                          "unmappedHistoryPolities": sorted({p["id"] for p in history["polities"]} - set(POLITY_NAMES))},
        "reasonLegend": REASONS, "summary": summarize(rows), "rows": rows,
        "evidenceChains": engine.chains,
        "authoritativeOverrides": {rule["id"]: rule for rule in curated_document.get("rules", [])},
        "sourceIndex": {pid: {"url": BASE_URL + pid if re.fullmatch(r"hvd_\d+", pid) else None,
                              "available": pid in sources, "temporal": sources.get(pid, {}).get("temporal"),
                              "parentLinks": [edge for edge in sources.get(pid, {}).get("historical_context", {}).get("part of", [])
                                              if any(active(edge, year, True) for year in years) or None in interval(edge, True)],
                              "cacheError": cache.get("entries", {}).get(pid, {}).get("error")} for pid in sorted(used_source_ids)},
        "fetch": {"requestedThisRun": fetched, "cachedRecords": sum("record" in e for e in cache["entries"].values()),
                  "failures": {pid: e["error"] for pid, e in cache["entries"].items() if "error" in e}, "offline": args.offline},
        "geometryIssues": geometry_issues, "custom": custom,
    }
    if args.compare:
        result["comparison"] = compare(load_json(args.compare), rows)
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(output), "coverage": result["coverage"], "summary": {"byStatus": result["summary"]["byStatus"], "year382": result["summary"]["byYear"].get("382"), "anomalyCount382": result["summary"]["anomalyCount382"]}, "fetch": result["fetch"], "geometryIssueCount": len(geometry_issues)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
