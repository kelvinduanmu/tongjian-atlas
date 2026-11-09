/* Shared territory edits. Historical inputs are never mutated. */
(() => {
  'use strict';

  const ENDPOINT = '/api/territory-edits';
  const OFFLINE = window.AtlasUI.personal ? 'file:// 只读；请通过 HTTP/HTTPS 打开站点后编辑本机个人副本。' : '离线文件模式仅供浏览；疆域编辑请打开 http://172.20.30.1:8765/';
  const HTTP = /^https?:$/.test(window.location.protocol);
  const EPS = 1e-10;
  const places = new Map((window.GEO_DATA?.places || []).map(place => [place.id, place]));
  const polities = new Map((window.HISTORY_DATA?.polities || []).map(polity => [polity.id, polity]));
  const listeners = new Set();
  let state = Object.freeze({ loaded: false, revision: 0, edits: Object.freeze([]), error: HTTP ? null : OFFLINE, writable: false });
  let sortedEdits = [];
  let cache = new WeakMap();
  let loading = null;
  let successVersion = 0;

  function notify() {
    for (const listener of [...listeners]) {
      try { listener(state); } catch (error) { console.error('疆域编辑订阅更新失败', error); }
    }
  }

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }

  function failed(message) {
    const changed = state.error !== message || state.writable || state.loaded;
    state = Object.freeze({ ...state, loaded: false, writable: false, error: message });
    if (changed) notify();
  }

  function cross(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  }

  function onSegment(point, a, b) {
    return Math.abs(cross(a, b, point)) <= EPS &&
      point[0] >= Math.min(a[0], b[0]) - EPS && point[0] <= Math.max(a[0], b[0]) + EPS &&
      point[1] >= Math.min(a[1], b[1]) - EPS && point[1] <= Math.max(a[1], b[1]) + EPS;
  }

  function intersects(a, b, c, d) {
    const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
    return (((ac > EPS && ad < -EPS) || (ac < -EPS && ad > EPS)) &&
      ((ca > EPS && cb < -EPS) || (ca < -EPS && cb > EPS))) ||
      onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
  }

  function contains(point, ring) {
    let inside = false;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i], b = ring[i + 1];
      if (onSegment(point, a, b)) return true;
      if ((a[1] > point[1]) !== (b[1] > point[1]) &&
          point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  function validate(edit) {
    if (!edit || typeof edit !== 'object' || !places.has(edit.placeId)) throw new Error('请选择已知郡县或城邑');
    if (!polities.has(edit.polityId)) throw new Error('请选择已知目标势力');
    if (!Number.isInteger(edit.startYear) || edit.startYear < 304 || edit.startYear > 439) throw new Error('生效年须为304至439之间的整数');
    if (typeof edit.note !== 'string' || [...edit.note].length > 500) throw new Error('备注限500字');
    const geometry = edit.geometry;
    if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) {
      throw new Error('范围须为单环Polygon多边形，不支持孔洞');
    }
    const ring = geometry.coordinates[0];
    if (!Array.isArray(ring) || ring.length < 4 || ring.length > 257) throw new Error('范围需3至256个顶点并闭合');
    for (const point of ring) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
          Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw new Error('范围坐标必须是有效经纬度[经度,纬度]');
    }
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('范围必须闭合');
    const n = ring.length - 1;
    const vertices = new Set();
    let area2 = 0;
    for (let i = 0; i < n; i += 1) {
      const key = `${ring[i][0]},${ring[i][1]}`;
      if (vertices.has(key)) throw new Error('范围顶点不可重复');
      vertices.add(key);
      const a = ring[(i + n - 1) % n], b = ring[i], c = ring[i + 1];
      if (Math.abs(b[0] - c[0]) > 180) throw new Error('范围不可跨越日期变更线');
      if (Math.abs(cross(a, b, c)) <= EPS && (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > EPS) {
        throw new Error('范围边线不可折返重叠');
      }
      area2 += cross(first, b, c);
      for (let j = i + 1; j < n; j += 1) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue;
        if (intersects(b, c, ring[j], ring[j + 1])) throw new Error('范围不可自交或自相接触');
      }
    }
    if (Math.abs(area2) <= EPS) throw new Error('范围面积过小或为零');
    const place = places.get(edit.placeId);
    if (!contains([place.lon, place.lat], ring)) throw new Error('所绘范围必须包含选定的郡县或城邑');
  }

  function accept(payload) {
    if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision < 0 || !Array.isArray(payload.edits) || payload.edits.length > 500) {
      throw new Error(window.AtlasUI.text('服务器返回的疆域编辑数据格式不正确'));
    }
    const ids = new Set(), sequences = new Set();
    for (const edit of payload.edits) {
      validate(edit);
      if (typeof edit.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(edit.id) ||
          !Number.isSafeInteger(edit.sequence) || edit.sequence < 1 || edit.sequence > payload.revision ||
          typeof edit.createdAt !== 'string' || !Number.isFinite(Date.parse(edit.createdAt)) ||
          ids.has(edit.id) || sequences.has(edit.sequence)) throw new Error(window.AtlasUI.text('服务器返回的编辑编号或序号不正确'));
      ids.add(edit.id);
      sequences.add(edit.sequence);
    }
    // A read started before a successful write must not roll that write back.
    if (payload.revision < state.revision) return;
    const changed = !state.loaded || !state.writable || state.error !== null || payload.revision !== state.revision;
    const editsChanged = payload.revision !== state.revision || !state.loaded;
    if (editsChanged) {
      sortedEdits = payload.edits.slice().sort((a, b) => a.startYear - b.startYear || a.sequence - b.sequence);
      cache = new WeakMap();
    }
    state = freeze({ loaded: true, writable: true, error: null, revision: payload.revision, edits: editsChanged ? payload.edits : state.edits });
    successVersion += 1;
    if (changed) notify();
  }

  async function responseBody(response) {
    try { return await response.json(); } catch (_) { throw new Error(window.AtlasUI.text('服务器未提供疆域编辑接口，请使用 http://172.20.30.1:8765/')); }
  }

  function load() {
    if (!HTTP) {
      failed(OFFLINE);
      return Promise.reject(new Error(OFFLINE));
    }
    if (loading) return loading;
    const version = successVersion;
    loading = (async () => {
      try {
        if (!window.MapAnnotations) throw new Error('地点标注模块未初始化，请刷新页面；未读取疆域以免误判自定义地点。');
        await window.MapAnnotations.load();
        const response = await window.AtlasAPI.fetch(ENDPOINT, { cache: 'no-store', credentials: 'same-origin' });
        const payload = await responseBody(response);
        // A second client can add a place and a territory between these two reads.
        if (response.ok && payload.edits?.some(edit => !places.has(edit.placeId))) await window.MapAnnotations.load();
        if (!response.ok) throw new Error(payload.error || window.AtlasUI.text('无法读取共享疆域编辑'));
        accept(payload);
      } catch (error) {
        const message = error instanceof TypeError ? window.AtlasUI.text('无法连接共享编辑服务器，请检查局域网连接后刷新') : error.message;
        if (successVersion === version) failed(message);
        throw new Error(message);
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  async function commit(operation) {
    if (!state.loaded || !state.writable) throw new Error(state.error || window.AtlasUI.text('共享编辑尚未加载，请先刷新'));
    let response, payload;
    try {
      response = await window.AtlasAPI.fetch(ENDPOINT, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: state.revision, ...operation }),
      });
      payload = await responseBody(response);
    } catch (error) {
      const message = error instanceof TypeError ? window.AtlasUI.text('无法确认保存结果，请刷新共享记录后再操作（请勿重复保存）') : error.message;
      failed(message);
      throw new Error(message);
    }
    if (response.status === 409) {
      if (loading) await loading.catch(() => {});
      await load();
      throw new Error(window.AtlasUI.text('其他浏览器已更改疆域，已刷新共享记录；请检查后重试'));
    }
    if (!response.ok) {
      const message = payload.error || window.AtlasUI.text('共享编辑保存失败');
      if (response.status === 403 || response.status >= 500) failed(message);
      throw new Error(message);
    }
    try { accept(payload); } catch (error) {
      failed(error.message);
      throw error;
    }
  }

  function activeCount(year) {
    let low = 0, high = sortedEdits.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sortedEdits[middle].startYear <= year) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function coordinates(geometry) {
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) throw new Error('历史疆域包含不支持的几何类型');
    return geometry.coordinates;
  }

  function changedFeature(feature, polygons, edit, isTarget) {
    const polityId = isTarget ? edit.polityId : feature.properties.polityId;
    const prior = feature?.properties || {};
    const historicalNote = prior.historicalNote ?? prior.note ?? '';
    const placeName = places.get(edit.placeId).name;
    const targetName = polities.get(edit.polityId).name;
    const properties = {
      ...prior, polityId, name: polities.get(polityId)?.name || prior.name,
      historicalNote, userEdited: true, userEditId: edit.id, userEditYear: edit.startYear,
      note: `${historicalNote}${historicalNote ? '\n' : ''}用户编辑：自${edit.startYear}年起，${placeName}所绘范围划归${targetName}。这是用户编辑范围，非已考证县界。${edit.note ? ` 备注：${edit.note}` : ''}`,
    };
    delete properties.labelCoordinates;
    const result = { ...feature, type: 'Feature', properties, geometry: { type: 'MultiPolygon', coordinates: polygons } };
    delete result.bbox;
    return result;
  }

  function apply(baseFeatures, year) {
    if (!Number.isInteger(year)) throw new Error('地图年份必须为整数');
    const count = activeCount(year);
    if (!count) return baseFeatures;
    if (!window.polygonClipping) throw new Error('多边形运算组件未加载，无法显示用户编辑疆域');
    let entries = cache.get(baseFeatures);
    if (entries?.has(count)) return entries.get(count);
    let features = baseFeatures;
    try {
      for (let i = 0; i < count; i += 1) {
        const edit = sortedEdits[i];
        const mask = edit.geometry.coordinates;
        const next = [], targetParts = [];
        let targetFeature = null;
        for (const feature of features) {
          const source = coordinates(feature.geometry);
          const isTarget = feature.properties.polityId === edit.polityId;
          if (isTarget) targetFeature ||= feature;
          // Only intersected polygons acquire user-edited metadata. Clipping returns fresh coordinates.
          const touched = window.polygonClipping.intersection(source, mask).length > 0;
          const remainder = touched ? window.polygonClipping.difference(source, mask) : source;
          if (isTarget) {
            if (remainder.length) targetParts.push(remainder);
          } else if (remainder.length) {
            next.push(touched ? changedFeature(feature, remainder, edit, false) : feature);
          }
        }
        const target = window.polygonClipping.union(mask, ...targetParts);
        if (target.length) next.push(changedFeature(targetFeature, target, edit, true));
        features = next;
      }
    } catch (error) {
      throw new Error(`疆域多边形运算失败，未修改历史数据：${error.message}`);
    }
    if (!entries) {
      entries = new Map();
      cache.set(baseFeatures, entries);
    }
    entries.set(count, features);
    return features;
  }

  function ownershipAtPlace(placeId, year) {
    const place = places.get(placeId);
    if (!place || !Number.isInteger(year)) return null;
    for (let i = activeCount(year) - 1; i >= 0; i -= 1) {
      const edit = sortedEdits[i];
      if (contains([place.lon, place.lat], edit.geometry.coordinates[0])) return edit;
    }
    return null;
  }

  function ownersAtPlace(placeId, features) {
    const place = places.get(placeId);
    if (!place || !Number.isFinite(place.lon) || !Number.isFinite(place.lat) || !Array.isArray(features)) return [];
    const point = [place.lon, place.lat], owners = new Set();
    for (const feature of features) {
      const geometry = feature?.geometry, polityId = feature?.properties?.polityId;
      if (!polityId || !geometry) continue;
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
      if (!Array.isArray(polygons)) continue;
      const covered = polygons.some(polygon => {
        if (!Array.isArray(polygon) || !polygon[0]?.length || !contains(point, polygon[0])) return false;
        for (let i = 1; i < polygon.length; i += 1) {
          const hole = polygon[i];
          if (!hole?.length || !contains(point, hole)) continue;
          // Polygon boundaries (including hole rims) belong to both adjoining areas.
          let boundary = false;
          for (let j = 0; j < hole.length - 1; j += 1) {
            if (onSegment(point, hole[j], hole[j + 1])) { boundary = true; break; }
          }
          if (!boundary) return false;
        }
        return true;
      });
      if (covered) owners.add(polityId);
    }
    return [...owners];
  }

  window.TerritoryEdits = Object.freeze({
    load, apply, ownershipAtPlace, ownersAtPlace,
    setCustomPlaces(customPlaces) {
      const referenced = new Set(state.edits.map(edit => edit.placeId));
      for (const id of places.keys()) if (id.startsWith('user-') && !referenced.has(id)) places.delete(id);
      for (const place of customPlaces) if (place.id.startsWith('user-') && ['city', 'county'].includes(place.kind)) places.set(place.id, place);
      cache = new WeakMap();
    },
    getState: () => state,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('订阅者必须为函数');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async save(edit) {
      if (!HTTP) throw new Error(OFFLINE);
      const payload = { placeId: edit?.placeId, startYear: edit?.startYear, polityId: edit?.polityId, geometry: edit?.geometry, note: edit?.note ?? '' };
      validate(payload);
      await commit({ op: 'add', edit: payload });
    },
    async remove(id) {
      if (typeof id !== 'string' || !state.edits.some(edit => edit.id === id)) throw new Error('找不到该编辑记录');
      await commit({ op: 'remove', id });
    },
    async clear() { await commit({ op: 'clear' }); },
  });
})();
