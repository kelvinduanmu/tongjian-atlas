"""Append evidence-led, explicitly approximate 440–589 regional snapshots.

The original corrected snapshots are inputs, never modified. Coordinates in the
JSON are human regional selection masks, not digitized historical boundaries.
"""
import json
from pathlib import Path

from shapely.geometry import Polygon, mapping, shape
from shapely.ops import unary_union


def append_later_snapshots(history, directory, land):
    document = json.loads((Path(directory) / 'later-dynasties.json').read_text(encoding='utf-8'))
    if document['baseYear'] != history['snapshots'][-1]['year']:
        raise ValueError('Later dynasty source requires the corrected 439 endpoint')
    names = {polity['id']: polity['name'] for polity in history['polities']}
    order = {owner: index for index, owner in enumerate(names)}
    shapes = {feature['properties']['polityId']: shape(feature['geometry'])
              for feature in history['snapshots'][-1]['features']}
    base_snapshot = history['snapshots'][-1]
    lineage = {}
    for feature in base_snapshot['features']:
        properties = feature['properties']
        owner = properties['polityId']
        urls = list(base_snapshot.get('sources', []))
        for field in ('source', 'sources'):
            values = properties.get(field, [])
            urls.extend([values] if isinstance(values, str) else values)
        lineage[owner] = {f'base:{owner}': {
            'year': document['baseYear'], 'polityId': owner,
            'sources': list(dict.fromkeys(urls)),
            'note': properties.get('note', ''),
            'reviewNotes': properties.get('reviewNotes', []),
            'scope': '439年已修正基底的原始来源与说明，仅支持基底区域判断，不是后来年份全境实控的独立证明。',
        }}
    masks = {}
    for key, record in document['masks'].items():
        mask = shape(record['geometry'])
        if not mask.is_valid or mask.geom_type not in ('Polygon', 'MultiPolygon'):
            raise ValueError('Invalid later dynasty regional mask: ' + key)
        masks[key] = mask
    source_ledger = document['sources']
    accumulated_sources = []
    accumulated_actions = []
    limitations = list(document['limitations'])
    previous_year = document['baseYear']
    for event in document['events']:
        year = event['year']
        if year <= previous_year or year > document['maxYear']:
            raise ValueError('Later dynasty years must be strictly increasing')
        previous_year = year
        for key in event['sources']:
            if key not in source_ledger:
                raise ValueError('Unknown later dynasty source: ' + key)
            if key not in accumulated_sources:
                accumulated_sources.append(key)
        for action_index, action in enumerate(event['actions']):
            target = action['to']
            if target is not None and target not in names:
                raise ValueError('Unknown later dynasty polity: ' + target)
            mask = masks[action['mask']] if action.get('mask') else None
            pieces = []
            inherited_lineage = {}
            evidence_key = f'{year}:{action_index}'
            evidence = {
                'year': year, **action,
                'sources': [source_ledger[key]['url'] for key in event['sources']],
                'scope': '本次区域转属的来源；沿政权接续保存证据链，不代表对继承的全境逐年复核。',
            }
            for owner in action['from']:
                if owner not in names:
                    raise ValueError('Unknown source polity: ' + owner)
                current = shapes.get(owner, Polygon())
                taken = current.intersection(mask) if mask is not None else current
                shapes[owner] = current.difference(taken)
                if not taken.is_empty:
                    pieces.append(taken)
                    lineage.setdefault(owner, {})[evidence_key] = evidence
                    inherited_lineage.update(lineage[owner])
            if target is not None and pieces:
                shapes[target] = unary_union([shapes.get(target, Polygon()), *pieces])
                lineage.setdefault(target, {}).update(inherited_lineage)
            accumulated_actions.append({'year': year, 'sources': event['sources'], **action})
        limitations.extend(event.get('limitations', []))
        features = []
        for owner in sorted(shapes, key=order.__getitem__):
            geometry = shapes[owner].intersection(land)
            if geometry.geom_type not in ('Polygon', 'MultiPolygon'):
                geometry = unary_union([piece for piece in getattr(geometry, 'geoms', [])
                                        if piece.geom_type in ('Polygon', 'MultiPolygon')])
            if geometry.is_empty:
                continue
            if not geometry.is_valid:
                raise ValueError(f'Invalid later dynasty geometry: {year} {owner}')
            largest = max(geometry.geoms, key=lambda part: part.area) if geometry.geom_type == 'MultiPolygon' else geometry
            anchor = largest.representative_point()
            relevant = [action for action in accumulated_actions
                        if owner in action['from'] or action['to'] == owner]
            inherited_evidence = list(lineage.get(owner, {}).values())
            owner_sources = list(dict.fromkeys(url for record in inherited_evidence for url in record['sources']))
            notes = [f"{action['year']}年：{action['note']}" for action in relevant]
            notes.append('证据链保留439年基底来源及后来转属来源；基底旧说明仅存档，不作为本年全境实控的新证明。')
            notes.append(f'{year}年事件后区域概略断面；未涉及的区域沿用最近断面，不构成该年逐县实控的独立确证。')
            notes.append(document['precision'])
            features.append({
                'type': 'Feature',
                'properties': {
                    'polityId': owner, 'name': names[owner],
                    'source': owner_sources,
                    'sourceYear': year,
                    'regionalSourceYears': sorted({record['year'] for record in inherited_evidence}),
                    'sourceEvidence': inherited_evidence,
                    'note': '\n'.join(notes),
                    'reviewNotes': notes,
                    'reviewStatus': 'partial-regional-review; not covered by the 304–439 place audit',
                    'labelCoordinates': [anchor.x, anchor.y],
                },
                'geometry': mapping(geometry),
            })
        for index, feature in enumerate(features):
            for other in features[index + 1:]:
                if shape(feature['geometry']).intersection(shape(other['geometry'])).area > 1e-8:
                    raise ValueError(f'Overlapping later dynasty geometry: {year}')
        history['snapshots'].append({
            'year': year, 'title': event['title'],
            'description': event['description'] + ' ' + document['precision']
                           + (' 未确证区域：' + '；'.join(limitations[len(document['limitations']):]) if len(limitations) > len(document['limitations']) else ''),
            'sourceSnapshotYear': document['baseYear'],
            'baseSources': list(base_snapshot.get('sources', [])),
            'features': features,
            'sources': [source_ledger[key]['url'] for key in event['sources']],
            'inheritedSources': list(dict.fromkeys([
                *base_snapshot.get('sources', []),
                *(source_ledger[key]['url'] for key in accumulated_sources
                  if key not in event['sources']),
            ])),
            'sourceEvidence': [dict(id=key, **source_ledger[key]) for key in event['sources']],
            'regionalChanges': event['actions'],
            'appliedCorrections': [],
            'reviewStatus': 'partial-regional-review; not covered by the 304–439 place audit',
            'reviewScope': event['reviewScope'],
            'uncertainties': list(dict.fromkeys(limitations)),
        })
    if previous_year != document['maxYear']:
        raise ValueError('Later dynasty source must reach its declared endpoint')
    history['minYear'] = document['minYear']
    history['maxYear'] = document['maxYear']
    history['laterDynastiesMethod'] = document['method']
    history['laterDynastiesPrecision'] = document['precision']
    history['laterDynastiesLimitations'] = document['limitations']
    history['auditScope'] = {'minYear': 304, 'maxYear': 439,
                             'laterPeriod': '440–589: partial regional source review, not the original full place audit'}
