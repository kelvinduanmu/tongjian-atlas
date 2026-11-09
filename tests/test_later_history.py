"""Historical display contracts; run with Python + Shapely after building history-data.js."""
import json
import unittest
from pathlib import Path

from shapely.geometry import Point, shape


class LaterHistoryContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.history = json.loads((root / 'history-data.js').read_text(encoding='utf-8').split('=', 1)[1].strip().rstrip(';'))
        cls.snapshots = {s['year']: s for s in cls.history['snapshots']}
        cls.areas = {year: {f['properties']['polityId']: shape(f['geometry']) for f in s['features']} for year, s in cls.snapshots.items()}

    def owners(self, year, lon, lat):
        current = max(y for y in self.areas if y <= year)
        return {owner for owner, area in self.areas[current].items() if area.covers(Point(lon, lat))}

    def test_southern_bank_not_transferred_with_huainan(self):
        for year, owner in [(552, 'liang'), (557, 'chen'), (573, 'chen'), (579, 'chen'), (581, 'chen'), (587, 'chen'), (589, 'sui')]:
            for name, lon, lat in [('建康原县治', 118.76899, 32.05256), ('京口', 119.45, 32.2)]:
                with self.subTest(year=year, place=name):
                    self.assertEqual(self.owners(year, lon, lat), {owner})
        for year, owner in [(552, 'northern-qi'), (573, 'northern-qi'), (574, 'chen'), (579, 'northern-zhou'), (581, 'sui')]:
            with self.subTest(year=year, place='广陵'):
                self.assertEqual(self.owners(year, 119.43, 32.39), {owner})

    def test_regime_succession_and_regional_losses(self):
        cases = [
            (479, 118.76899, 32.05256, 'southern-qi'),
            (502, 118.76899, 32.05256, 'liang'),
            (534, 108.93719, 34.31799, 'northern-wei'),
            (534, 114.41195, 36.27238, 'eastern-wei'),
            (535, 108.93719, 34.31799, 'western-wei'),
            (535, 112.4935669, 37.7296293, 'eastern-wei'),
            (550, 114.41195, 36.27238, 'northern-qi'),
            (552, 107.08756, 33.02875, 'western-wei'),
            (553, 104.078, 30.65038, 'western-wei'),
            (555, 112.19077, 30.35044, 'western-liang-jingling'),
            (557, 114.3, 30.55, 'liang'),
            (560, 114.3, 30.55, 'chen'),
            (577, 114.41195, 36.27238, 'northern-zhou'),
            (581, 108.93719, 34.31799, 'sui'),
            (587, 112.19077, 30.35044, 'sui'),
        ]
        for year, lon, lat, owner in cases:
            with self.subTest(year=year, owner=owner):
                self.assertEqual(self.owners(year, lon, lat), {owner})

    def test_589_central_unification_does_not_claim_unverified_frontiers(self):
        self.assertEqual(self.history['maxYear'], 589)
        for lon, lat in [(118.76899, 32.05256), (108.93719, 34.31799), (112.59631, 34.73157), (104.078, 30.65038), (112.19077, 30.35044)]:
            self.assertEqual(self.owners(589, lon, lat), {'sui'})
        self.assertNotIn('chen', self.areas[589])
        self.assertNotIn('western-liang-jingling', self.areas[587])
        self.assertNotIn('qiuchi', self.areas[443])
        self.assertEqual(self.owners(589, 113.26, 23.13), set(), 'The source notes explicitly leave the Lingnan accession process unfilled.')

    def test_valid_nonoverlapping_shapes(self):
        for year, owners in self.areas.items():
            items = list(owners.items())
            for index, (owner, geometry) in enumerate(items):
                with self.subTest(year=year, owner=owner):
                    self.assertTrue(geometry.is_valid)
                    self.assertFalse(geometry.is_empty)
                for other, other_geometry in items[index + 1:]:
                    with self.subTest(year=year, owners=(owner, other)):
                        self.assertLess(geometry.intersection(other_geometry).area, 1e-8)

    def test_later_geometry_keeps_base_provenance(self):
        self.assertTrue(set(self.snapshots[439]['sources']).issubset(self.snapshots[442]['inheritedSources']))
        for year, snapshot in self.snapshots.items():
            if year <= 439:
                continue
            with self.subTest(year=year):
                self.assertTrue(snapshot['sources'])
                self.assertTrue(snapshot['reviewScope'])
                for feature in snapshot['features']:
                    self.assertTrue(feature['properties']['source'])
                    self.assertTrue(feature['properties']['sourceEvidence'])


if __name__ == '__main__':
    unittest.main()
