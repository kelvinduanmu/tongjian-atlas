#!/usr/bin/env python3
"""Remove non-distributed references from this checkout; never read private inputs."""
import argparse
import json
from pathlib import Path


def load_assignment(path, symbol):
    text = path.read_text(encoding='utf-8').strip()
    prefix = 'window.' + symbol + ' = '
    if not text.startswith(prefix):
        raise ValueError(f'Expected JSON assignment: {path.name}')
    return json.loads(text[len(prefix):].rstrip(';'))


def save_assignment(path, symbol, data):
    path.write_text('window.' + symbol + ' = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')


def prepare(directory):
    geo_path = directory / 'geo-data.js'
    geo = load_assignment(geo_path, 'GEO_DATA')
    geo.pop('terrain', None)
    geo.pop('historicalTileUrl', None)
    geo['sources'] = [row for row in geo.get('sources', []) if not any(term in row.get('url', '') for term in ('registry.opendata.aws/terrain', 'tilezen/joerd', 'gis.sinica.edu.tw'))]
    geo['publicationNote'] = '公开版未分发原图扫描、地形影像或中研院在线瓦片。历史地名保留CHGIS非商业许可和逐条来源；现代水系不是古水系复原。'
    save_assignment(geo_path, 'GEO_DATA', geo)
    catalog_path = directory / 'map-data.js'
    catalog = load_assignment(catalog_path, 'MAP_DATA')
    fields = ('id', 'title', 'page', 'note', 'years', 'kind')
    save_assignment(catalog_path, 'MAP_DATA', [{key: row[key] for key in fields if key in row} for row in catalog])
    history_path = directory / 'history-data.js'
    history = load_assignment(history_path, 'HISTORY_DATA')
    history['disclaimer'] = '疆域为有来源的区域概略重建，非精确县界；仍有未决项。原始核验报告与扫描未随公开版发布，见来源说明。未知不表示无人或无政权，行政隶属不等于实控。'
    history['publicationNote'] = '保留项目手绘概略重建和来源引用，不分发引用站点的原图、OCR或全文；数据不适用项目代码MIT许可证。'
    for snapshot in history.get('snapshots', []):
        snapshot['reviewStatus'] = 'partially-crosschecked; original audit omitted from public distribution; see sources.html#audit'
    save_assignment(history_path, 'HISTORY_DATA', history)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    directory = args.directory.resolve()
    if directory != Path(__file__).resolve().parents[1]:
        parser.error('This helper only modifies its own publication checkout.')
    prepare(directory)
    print('Prepared public geo/history/source-catalog assignments; no private inputs read.')


if __name__ == '__main__':
    main()
