#!/usr/bin/env python3
"""Build the published map from coarse source plus separately evidenced corrections.
Requires Node.js and Shapely. Does not read or alter user annotations/territory edits.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess

from shapely.geometry import Point, Polygon, shape, mapping
from shapely.ops import unary_union


def assignment(path):
    return json.loads(path.read_text(encoding='utf-8').split('=', 1)[1].strip().rstrip(';'))


def union_geometry(geometry):
    raw = shape(geometry)
    pieces = list(raw.geoms) if raw.geom_type == 'MultiPolygon' else [raw]
    if any(not part.is_valid for part in pieces):
        raise ValueError('Invalid source polygon; refusing silent geometry repair')
    return unary_union(pieces)


def polygon_only(geometry):
    if geometry.is_empty:
        return Polygon()
    if geometry.geom_type in ('Polygon', 'MultiPolygon'):
        return geometry
    return unary_union([part for part in geometry.geoms if part.geom_type in ('Polygon', 'MultiPolygon')])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--output', default='history-data.js')
    args = parser.parse_args()
    directory = args.directory.resolve()
    source_path = directory / 'history-reconstruction.source.js'
    raw = subprocess.run(['node', '-e', 'global.window={};require(process.argv[1]);process.stdout.write(JSON.stringify(window.HISTORY_DATA));', str(source_path)], check=True, capture_output=True, text=True)
    history = json.loads(raw.stdout)
    geo = assignment(directory / 'geo-data.js')
    document = json.loads((directory / 'territory-corrections.json').read_text(encoding='utf-8'))
    land = unary_union([shape(feature['geometry']) for feature in geo['land']['features']])
    original = sorted(history['snapshots'], key=lambda snapshot: snapshot['year'])
    events = {event['year']: event for event in document['events']}
    years = sorted({snapshot['year'] for snapshot in original} | set(events))
    polity_order = {polity['id']: index for index, polity in enumerate(history['polities'])}
    polity_names = {polity['id']: polity['name'] for polity in history['polities']}
    corrections = [(item, union_geometry(item['mask']), [(entry, union_geometry(entry['geometry'])) for entry in item['assignments']]) for item in document['corrections']]
    output = []
    for year in years:
        base = max((snapshot for snapshot in original if snapshot['year'] <= year), key=lambda snapshot: snapshot['year'])
        snapshot = copy.deepcopy(base)
        snapshot['sourceSnapshotYear'] = base['year']
        snapshot['year'] = year
        original_shapes = {}
        original_properties = {}
        for feature in base['features']:
            owner = feature['properties']['polityId']
            original_shapes[owner] = union_geometry(feature['geometry'])
            original_properties[owner] = feature['properties']
        shapes = dict(original_shapes)
        applied = []
        notes = {}
        sources = list(snapshot.get('sources', []))
        for correction, mask, assignments in corrections:
            targets = []
            for entry, geometry in assignments:
                if geometry.difference(mask).area > 1e-8:
                    raise ValueError('Correction assignment lies outside mask: ' + correction['id'])
                if 'inheritFrom' in entry:
                    point = Point(entry['inheritFrom'])
                    matches = [owner for owner, area in original_shapes.items() if area.covers(point)]
                    if len(matches) > 1:
                        raise ValueError('Ambiguous inherited control: ' + correction['id'])
                    targets.append((matches[0] if matches else None, geometry))
                else:
                    rules = [rule for rule in entry['rules'] if rule['begin'] <= year <= rule['end']]
                    if len(rules) > 1:
                        raise ValueError('Overlapping correction time rules: ' + correction['id'])
                    if rules:
                        targets.append((rules[0]['owner'], geometry))
            if not targets:
                continue
            applied.append(correction['id'])
            sources.extend(correction.get('sources', []))
            for owner, area in list(shapes.items()):
                if area.intersects(mask):
                    shapes[owner] = area.difference(mask)
                    notes.setdefault(owner, []).append(correction['note'])
            for owner, geometry in targets:
                if owner is None:
                    continue
                if owner not in polity_names:
                    raise ValueError('Unknown polity: ' + owner)
                shapes[owner] = unary_union([shapes.get(owner, Polygon()), geometry])
                notes.setdefault(owner, []).append(correction['note'])
        features = []
        for owner in sorted(shapes, key=lambda name: polity_order[name]):
            geometry = polygon_only(shapes[owner].intersection(land))
            if geometry.is_empty:
                continue
            if not geometry.is_valid:
                raise ValueError(f'Invalid generated geometry: {year} {owner}')
            properties = dict(original_properties.get(owner, {'polityId': owner, 'name': polity_names[owner]}))
            unique_notes = list(dict.fromkeys(notes.get(owner, [])))
            if unique_notes:
                properties['reviewNotes'] = unique_notes
                properties['note'] = properties.get('note', '') + '\n核验修正：' + '；'.join(unique_notes)
            largest = max(geometry.geoms, key=lambda part: part.area) if geometry.geom_type == 'MultiPolygon' else geometry
            anchor = largest.representative_point()
            properties['labelCoordinates'] = [anchor.x, anchor.y]
            features.append({'type': 'Feature', 'properties': properties, 'geometry': mapping(geometry)})
        for index, feature in enumerate(features):
            for other in features[index + 1:]:
                if shape(feature['geometry']).intersection(shape(other['geometry'])).area > 1e-8:
                    raise ValueError(f'Polity overlap after corrections: {year}')
        if year in events:
            snapshot['title'] = events[year]['title']
            snapshot['description'] = events[year]['description']
            sources.extend(events[year].get('sources', []))
        snapshot.update(document.get('snapshotOverrides', {}).get(str(year), {}))
        snapshot['features'] = features
        snapshot['sources'] = list(dict.fromkeys(sources))
        snapshot['appliedCorrections'] = applied
        snapshot['reviewStatus'] = 'partially-crosschecked; see territory-audit.json for unresolved records'
        output.append(snapshot)
    history['snapshots'] = output
    history['method'] = document['method']
    history['uncertainties'] = document['remainingLimitations']
    history['disclaimer'] = '疆域为有来源的区域概略重建，非精确县界；已做全量地点对照但仍有未决项，详见疆域核验报告。未知不表示无人或无政权，行政隶属不等于实控。'
    history['geometryProcessing'] = '先合并原始绘图分区，再应用有证据的区域/年代修正，最后按Natural Earth现代陆地裁剪；不是古海岸复原。'
    history['buildInputs'] = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in ('history-reconstruction.source.js', 'territory-corrections.json', 'geo-data.js')}
    target = directory / args.output
    target.write_text('window.HISTORY_DATA = ' + json.dumps(history, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(json.dumps({'output': str(target), 'snapshots': len(output), 'features': sum(len(snapshot['features']) for snapshot in output), 'newYears': sorted(events)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
