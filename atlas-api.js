/* Explicit transport: shared edition uses the server; personal edition never sends API data. */
(() => {
  'use strict';
  const mode = window.ATLAS_CONFIG?.mode === 'shared' ? 'shared' : 'personal';
  const MAX_REVISION = Number.MAX_SAFE_INTEGER;
  const MAX_IMPORT = 16 * 1024 * 1024;
  const MAX_STORE = 8 * 1024 * 1024;
  const STORE_KEYS = ['characters', 'mapAnnotations', 'territoryEdits', 'placePeriods', 'genealogies'];
  const ROUTES = new Map([
    ['/api/characters', 'characters'], ['/api/map-annotations', 'mapAnnotations'],
    ['/api/territory-edits', 'territoryEdits'], ['/api/place-periods', 'placePeriods'],
    ['/api/genealogies', 'genealogies']
  ]);
  const CHARACTER_FIELDS = ['name', 'role', 'polityId', 'biography', 'biographySource', 'biographyOrigin', 'lon', 'lat'];
  const CANDIDATE_FIELDS = ['name', 'kind', 'lon', 'lat', 'address', 'provider', 'providerId', 'matchedName', 'sourceUrl', 'license', 'temporalNote', 'coordinatePrecision', 'period'];
  const candidates = new Map();
  const encoder = new TextEncoder();
  let database;
  let geographyIndex;

  class APIError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
  }
  function requireThat(condition, message) { if (!condition) throw new APIError(message); }
  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function fields(value, expected) {
    requireThat(object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)), '记录字段不正确；未更改个人副本');
  }
  function text(value, maximum, minimum = 0) {
    requireThat(typeof value === 'string' && [...value].length >= minimum && [...value].length <= maximum && (!minimum || value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) && !/[\uD800-\uDFFF]/u.test(value), '文字长度、内容或编码无效');
    return value;
  }
  function list(value, maximum, minimum = 0) {
    requireThat(Array.isArray(value) && value.length >= minimum && value.length <= maximum, '记录数量无效或已达上限');
    return value;
  }
  function integer(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
  function revision(value) { requireThat(integer(value, 0, MAX_REVISION), 'revision须为有效非负整数'); }
  function nextRevision(value) { revision(value); requireThat(value < MAX_REVISION, '保存版本已达上限'); return value + 1; }
  function stamp(value) {
    requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value), '记录时间无效');
    const date = new Date(value);
    requireThat(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19), '记录时间无效');
  }
  function uuid(value, prefix = '') {
    requireThat(typeof value === 'string' && value.startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.slice(prefix.length)), '记录编号无效');
  }
  function identifier(value) { text(value, 160, 1); requireThat(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value), '记录编号无效'); return value; }
  function newId(prefix = '') {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return prefix + `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function url(value) {
    text(value, 4096, 1);
    requireThat(!/[\s\\]/u.test(value) && /^https?:\/\//.test(value), '来源须为完整HTTP(S)网址');
    let parsed;
    try { parsed = new URL(value); } catch { throw new APIError('来源网址无效'); }
    requireThat(['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname && !parsed.username && !parsed.password, '来源网址无效');
    return parsed;
  }
  function unique(values, message) { requireThat(new Set(values).size === values.length, message); }
  function select(value, names) { return Object.fromEntries(names.map(name => [name, value[name]])); }
  function position(lon, lat, latitude = 85) {
    requireThat(Number.isFinite(lon) && lon >= -180 && lon <= 180 && Number.isFinite(lat) && lat >= -latitude && lat <= latitude, '坐标须为有效经纬度；人物纬度范围为-85至85');
  }
  function index() {
    if (!geographyIndex) {
      requireThat(window.GEO_DATA && window.HISTORY_DATA, '地图基础资料尚未加载，请刷新页面后重试');
      geographyIndex = {
        places: new Map(window.GEO_DATA.places.map(place => [place.id, place])),
        polities: new Set(window.HISTORY_DATA.polities.map(polity => polity.id))
      };
    }
    return geographyIndex;
  }
  function empty() {
    return { characters: { revision: 0, characters: [], formations: [] }, mapAnnotations: { revision: 0, annotations: [] }, territoryEdits: { revision: 0, edits: [] }, placePeriods: { revision: 0, overrides: [] }, genealogies: { revision: 0, families: [], links: [] } };
  }
  function size(value, maximum) { requireThat(encoder.encode(JSON.stringify(value)).length <= maximum, '保存或导入数据过大；未更改个人副本'); }
  function backupEnvelope(stores) {
    return { format: 'tongjian-atlas-personal', version: 1, exportedAt: new Date().toISOString(), stores };
  }

  // Parse JSON with duplicate-key and nesting checks before any state can change.
  function strictJSON(raw, maximum) {
    requireThat(typeof raw === 'string' && encoder.encode(raw).length <= maximum, 'JSON正文为空或超过大小上限');
    let at = 0;
    function whitespace() { while (/\s/.test(raw[at] || '') && at < raw.length) at++; }
    function string() {
      const start = at++;
      while (at < raw.length) {
        if (raw[at] === '\\') { at += 2; continue; }
        if (raw[at++] === '"') return JSON.parse(raw.slice(start, at));
      }
      throw new APIError('JSON字符串未闭合');
    }
    function value(depth) {
      requireThat(depth <= 64, 'JSON嵌套过深'); whitespace();
      const token = raw[at];
      if (token === '"') { string(); return; }
      if (token === '{' || token === '[') {
        const isObject = token === '{', end = isObject ? '}' : ']';
        const keys = new Set(); at++; whitespace();
        if (raw[at] === end) { at++; return; }
        while (at < raw.length) {
          if (isObject) {
            requireThat(raw[at] === '"', 'JSON对象字段无效');
            const key = string(); requireThat(!keys.has(key), 'JSON含重复字段'); keys.add(key);
            whitespace(); requireThat(raw[at++] === ':', 'JSON字段缺少冒号');
          }
          value(depth + 1); whitespace();
          if (raw[at] === end) { at++; return; }
          requireThat(raw[at++] === ',', 'JSON分隔符无效'); whitespace();
        }
        throw new APIError('JSON未闭合');
      }
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at));
      requireThat(match, 'JSON值无效'); at += match[0].length;
    }
    try { value(0); whitespace(); requireThat(at === raw.length, 'JSON尾部无效'); return JSON.parse(raw); }
    catch (error) { if (error instanceof APIError) throw error; throw new APIError('JSON格式无效'); }
  }
  function cloneDocument(doc) {
    const seen = new Set();
    function visit(value, depth) {
      requireThat(depth <= 64, '导入数据嵌套过深');
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') { requireThat(Number.isFinite(value), '导入数据含无效数值'); return; }
      if (typeof value === 'string') { text(value, MAX_IMPORT); return; }
      requireThat(object(value) || Array.isArray(value), '导入数据须为纯JSON');
      requireThat(!seen.has(value) && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))), '导入数据须为无循环纯JSON');
      seen.add(value);
      requireThat(Object.getOwnPropertySymbols(value).length === 0, '导入数据含非JSON字段');
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireThat(descriptor && Object.hasOwn(descriptor, 'value'), '导入数据不可含执行代码'); visit(descriptor.value, depth + 1);
      }
      seen.delete(value);
    }
    visit(doc, 0);
    return strictJSON(JSON.stringify(doc), MAX_IMPORT);
  }

  function storageError(error) {
    if (error instanceof APIError) return error;
    return new APIError(error?.name === 'QuotaExceededError' ? '浏览器存储空间不足；未提交更改，请导出备份并释放空间' : '本机浏览器存储不可用或写入失败；未提交更改。请允许此网站使用IndexedDB，不要使用禁止存储的隐私模式', 503);
  }
  function openDatabase() {
    if (!database) database = new Promise((resolve, reject) => {
      if (location.protocol === 'file:') { reject(new APIError('本机文件模式只读；请通过HTTP本地服务器或HTTPS网站打开以保存个人副本', 503)); return; }
      if (!window.indexedDB) { reject(storageError()); return; }
      const directory = new URL('.', location.href).pathname;
      let request;
      try { request = window.indexedDB.open(`tongjian-atlas-personal-v1:${directory}`, 1); }
      catch (error) { reject(storageError(error)); return; }
      request.onupgradeneeded = () => { request.result.createObjectStore('state'); };
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () => reject(new APIError('浏览器数据库升级被另一页面阻止，请关闭旧页面后刷新', 503));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
    }).catch(error => { database = undefined; throw error; });
    return database;
  }
  async function transaction(write, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      let tx, result, failure;
      try {
        tx = db.transaction('state', write ? 'readwrite' : 'readonly');
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || storageError(tx.error));
        tx.onerror = () => { /* onabort is the single rejection path. */ };
        const store = tx.objectStore('state');
        const request = store.get('document');
        request.onsuccess = () => {
          try {
            const document = request.result || empty();
            result = action(document);
            if (write) {
              for (const key of STORE_KEYS) size(document[key], MAX_STORE);
              // Every committed state must fit the same downloadable/importable envelope.
              size(backupEnvelope(document), MAX_IMPORT);
              store.put(document, 'document');
            }
          } catch (error) { failure = storageError(error); tx.abort(); }
        };
      } catch (error) { reject(storageError(error)); }
    });
  }

  function biographySource(source) {
    if (source === null) return;
    fields(source, ['provider', 'title', 'url', 'bookTitle', 'method', 'retrievedAt', 'lookupName', 'notice']);
    Object.values(source).forEach(value => text(value, 2048, 1));
    requireThat(['extractive', 'extractive-cache'].includes(source.method), '简介摘录方式无效');
    const parsed = url(source.url);
    requireThat(parsed.protocol === 'https:' && (!parsed.port || parsed.port === '443') && (
      parsed.hostname === 'sou-yun.cn' && parsed.pathname === '/QueryAllusion.aspx' ||
      ['dict.revised.moe.edu.tw', 'dict.concised.moe.edu.tw'].includes(parsed.hostname) ||
      parsed.hostname === 'github.com' && (parsed.pathname === '/g0v/moedict-data' || parsed.pathname.startsWith('/g0v/moedict-data/')) ||
      parsed.hostname === 'raw.githubusercontent.com' && parsed.pathname.startsWith('/g0v/moedict-data/')
    ), '人物简介来源不在可信来源范围');
    requireThat(/(?:Z|[+-]\d{2}:\d{2})$/.test(source.retrievedAt) && Number.isFinite(Date.parse(source.retrievedAt)), '简介来源时间无效');
    text(source.lookupName, 60, 1);
    requireThat(!/[\p{C}<>\\/]/u.test(source.lookupName), '简介查询姓名无效');
  }
  function character(value) {
    fields(value, CHARACTER_FIELDS);
    text(value.name, 60, 1);
    requireThat(value.name === value.name.trim(), '人物姓名含首尾空白');
    requireThat(['online', 'custom', 'legacy'].includes(value.biographyOrigin), '人物简介类型无效');
    text(value.biography, 3000, value.biographyOrigin === 'custom' ? 0 : 1);
    requireThat(value.biography === value.biography.trim(), '人物简介含首尾空白');
    requireThat((value.biographyOrigin === 'online') === (value.biographySource !== null), '简介来源与简介类型不符');
    biographySource(value.biographySource);
    requireThat(['monarch', 'minister'].includes(value.role) && index().polities.has(value.polityId), '人物角色或势力无效');
    position(value.lon, value.lat);
  }
  function characterInput(value, previous) {
    requireThat(object(value), '人物编辑字段无效');
    const extra = value.biographyMode === 'custom' ? ['biography'] : value.biographyMode === 'online' ? ['biographyId'] : [];
    requireThat(['custom', 'online', 'keep'].includes(value.biographyMode), '请选择简介模式');
    fields(value, ['name', 'role', 'polityId', 'biographyMode', 'lon', 'lat', ...extra]);
    if (value.biographyMode === 'online') throw new APIError('个人版不提供在线人物简介查询；请选择自定义人物，或使用Python共享版', 503);
    text(value.name, 80, 1);
    let biography, source, origin;
    if (value.biographyMode === 'keep') {
      requireThat(previous && value.name.trim() === previous.name, '新建或改名后不能保留原简介，请选择自定义人物');
      biography = previous.biography; source = previous.biographySource; origin = previous.biographyOrigin;
    } else { text(value.biography, 4000); biography = value.biography.trim(); source = null; origin = 'custom'; }
    const result = { ...select(value, ['name', 'role', 'polityId', 'lon', 'lat']), name: value.name.trim(), biography, biographySource: source, biographyOrigin: origin };
    character(result); return result;
  }
  function formation(value, ids) {
    fields(value, ['name', 'commanderId', 'memberIds']); text(value.name, 60, 1);
    requireThat(value.name === value.name.trim(), '编队名称含首尾空白');
    list(value.memberIds, 50, 2); unique(value.memberIds, '编队成员重复');
    requireThat(value.memberIds.every(id => ids.has(id)) && value.memberIds.includes(value.commanderId), '编队成员或主将无效');
  }
  function validateCharacters(state) {
    fields(state, ['revision', 'characters', 'formations']); revision(state.revision);
    list(state.characters, 500); list(state.formations, 100);
    const ids = new Set(), assigned = new Set();
    for (const item of state.characters) {
      fields(item, [...CHARACTER_FIELDS, 'id', 'createdAt', 'updatedAt', 'hidden']);
      character(select(item, CHARACTER_FIELDS)); uuid(item.id, 'character-'); stamp(item.createdAt); stamp(item.updatedAt);
      requireThat(typeof item.hidden === 'boolean' && !ids.has(item.id), '人物隐藏状态无效或编号重复'); ids.add(item.id);
    }
    unique(state.formations.map(item => item.id), '编队编号重复');
    for (const item of state.formations) {
      fields(item, ['id', 'name', 'commanderId', 'memberIds', 'createdAt', 'updatedAt']);
      uuid(item.id, 'formation-'); stamp(item.createdAt); stamp(item.updatedAt);
      formation(select(item, ['name', 'commanderId', 'memberIds']), ids);
      for (const id of item.memberIds) { requireThat(!assigned.has(id), '每个人物最多加入一个编队'); assigned.add(id); }
    }
  }
  function candidate(value) {
    fields(value, CANDIDATE_FIELDS);
    for (const key of CANDIDATE_FIELDS) if (!['lon', 'lat', 'period'].includes(key)) text(value[key], key === 'name' ? 80 : 4000, 1);
    requireThat(['city', 'county', 'lake', 'river'].includes(value.kind) && Number.isFinite(value.lon) && value.lon >= 73 && value.lon <= 136 && Number.isFinite(value.lat) && value.lat >= 15 && value.lat <= 54, '地点类别或坐标无效');
    requireThat(['local', 'CHGIS', 'Photon / OpenStreetMap', '历史地名考证'].includes(value.provider), '地点来源无效'); url(value.sourceUrl);
    if (value.period !== null) {
      fields(value.period, ['begin', 'end']);
      requireThat(integer(value.period.begin, -3000, 2100) && integer(value.period.end, value.period.begin, 2100) && value.period.begin !== 0 && value.period.end !== 0, '地点年代无效');
    }
  }
  const annotationIdentity = item => JSON.stringify([item.sourceUrl, item.kind, item.name.trim().toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ')]);
  function validateAnnotations(state) {
    fields(state, ['revision', 'annotations']); revision(state.revision); list(state.annotations, 1000);
    for (const item of state.annotations) {
      fields(item, [...CANDIDATE_FIELDS, 'id', 'note', 'createdAt']); candidate(select(item, CANDIDATE_FIELDS));
      uuid(item.id, 'user-'); text(item.note, 500); stamp(item.createdAt);
    }
    unique(state.annotations.map(item => item.id), '地点编号重复'); unique(state.annotations.map(annotationIdentity), '同一来源、类别与名称的地点重复');
  }
  const EPS = 1e-10;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (p, a, b) => Math.abs(cross(a, b, p)) <= EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
  function intersects(a, b, c, d) {
    const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
    return ((ac > EPS && ad < -EPS || ac < -EPS && ad > EPS) && (ca > EPS && cb < -EPS || ca < -EPS && cb > EPS)) || onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
  }
  function geometry(value, point) {
    fields(value, ['type', 'coordinates']); requireThat(value.type === 'Polygon', '范围须为Polygon'); list(value.coordinates, 1, 1);
    const ring = list(value.coordinates[0], 257, 4), n = ring.length - 1;
    for (const p of ring) { list(p, 2, 2); position(p[0], p[1], 90); }
    requireThat(ring[0][0] === ring[n][0] && ring[0][1] === ring[n][1], '范围必须闭合');
    unique(ring.slice(0, n).map(p => JSON.stringify(p)), '范围顶点不可重复');
    let area = 0, inside = false, boundary = false;
    for (let i = 0; i < n; i++) {
      const a = ring[(i + n - 1) % n], b = ring[i], c = ring[i + 1];
      requireThat(Math.abs(b[0] - c[0]) <= 180, '范围不可跨日期变更线');
      requireThat(!(Math.abs(cross(a, b, c)) <= EPS && (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > EPS), '边线不可折返重叠');
      for (let j = i + 1; j < n; j++) if (j !== i + 1 && !(i === 0 && j === n - 1)) requireThat(!intersects(b, c, ring[j], ring[j + 1]), '范围不可自交或自相接触');
      area += cross(ring[0], b, c);
      if (onSegment(point, b, c)) boundary = true;
      if ((b[1] > point[1]) !== (c[1] > point[1]) && point[0] < (c[0] - b[0]) * (point[1] - b[1]) / (c[1] - b[1]) + b[0]) inside = !inside;
    }
    requireThat(Math.abs(area) > EPS, '范围面积过小或为零'); requireThat(inside || boundary, '范围必须包含所选地点');
  }
  function validateTerritories(state, annotations) {
    fields(state, ['revision', 'edits']); revision(state.revision); list(state.edits, 500);
    const places = new Map(index().places);
    for (const item of annotations.annotations) if (['city', 'county'].includes(item.kind)) places.set(item.id, item);
    unique(state.edits.map(item => item.id), '疆域编辑编号重复'); unique(state.edits.map(item => item.sequence), '疆域编辑序号重复');
    for (const item of state.edits) {
      fields(item, ['placeId', 'startYear', 'polityId', 'geometry', 'note', 'id', 'sequence', 'createdAt']);
      requireThat(places.has(item.placeId) && index().polities.has(item.polityId), '疆域编辑引用未知地点或势力');
      requireThat(integer(item.startYear, 304, 439) && integer(item.sequence, 1, state.revision), '疆域编辑年份或序号无效');
      uuid(item.id); stamp(item.createdAt); text(item.note, 500);
      const place = places.get(item.placeId); geometry(item.geometry, [place.lon, place.lat]);
    }
  }
  function validatePeriods(state) {
    fields(state, ['revision', 'overrides']); revision(state.revision); list(state.overrides, index().places.size);
    unique(state.overrides.map(item => item.placeId), '显示年代地点重复');
    for (const item of state.overrides) {
      fields(item, ['placeId', 'begin', 'end', 'updatedAt']);
      requireThat(index().places.has(item.placeId), '显示年代只能引用原始地点');
      requireThat(integer(item.begin, -5000, 9999) && integer(item.end, item.begin, 9999), '显示年代须为-5000至9999整数且起年不晚于止年'); stamp(item.updatedAt);
    }
  }
  function sourceIds(values, known) {
    list(values, 128, 1); unique(values, '来源编号重复');
    for (const id of values) { identifier(id); requireThat(known.has(id), '引用未知来源'); }
  }
  function family(value) {
    fields(value, ['id', 'name', 'description', 'scopeNote', 'people', 'relationships', 'sources', 'rootPersonId', 'sourceKey', 'generatedAt', 'warnings']);
    identifier(value.id); requireThat(value.id.startsWith('family-'), '家族编号须以family-开头');
    text(value.name, 240, 1); text(value.description, 6000, 1); text(value.scopeNote, 6000, 1); text(value.sourceKey, 1024, 1); stamp(value.generatedAt);
    list(value.warnings, 64).forEach(warning => text(warning, 3000, 1));
    const sources = new Set(), people = new Set();
    for (const source of list(value.sources, 128, 1)) {
      fields(source, ['id', 'title', 'url']); identifier(source.id); text(source.title, 1000, 1);
      requireThat(!sources.has(source.id), '家族来源编号重复'); sources.add(source.id);
      const parsed = url(source.url);
      requireThat(parsed.protocol === 'https:' && (!parsed.port || parsed.port === '443') || parsed.protocol === 'http:' && parsed.hostname === 'famous.usatour.com.cn' && parsed.pathname.startsWith('/history/') && (!parsed.port || parsed.port === '80'), '家族来源须为HTTPS或批准的历史目录网址');
    }
    for (const person of list(value.people, 24, 2)) {
      fields(person, ['id', 'name', 'aliases', 'identity', 'polity', 'note', 'sourceIds']); identifier(person.id);
      requireThat(!people.has(person.id), '家族人物编号重复'); people.add(person.id);
      text(person.name, 240, 1); list(person.aliases, 32).forEach(alias => text(alias, 240, 1)); unique(person.aliases, '人物别名重复');
      text(person.identity, 3000); text(person.polity, 500); text(person.note, 6000); sourceIds(person.sourceIds, sources);
    }
    identifier(value.rootPersonId); requireThat(people.has(value.rootPersonId), '选定人物不在家族中');
    const children = new Map([...people].map(id => [id, []])), neighbours = new Map([...people].map(id => [id, []])), indegree = new Map([...people].map(id => [id, 0])), edges = new Set();
    for (const relation of list(value.relationships, 276, 1)) {
      fields(relation, ['parentId', 'childId', 'type', 'note', 'sourceIds']);
      const parent = identifier(relation.parentId), child = identifier(relation.childId), key = JSON.stringify([parent, child]);
      requireThat(relation.type === 'parent-child' && parent !== child && people.has(parent) && people.has(child) && !edges.has(key), '亲子关系无效或重复');
      edges.add(key); text(relation.note, 6000); sourceIds(relation.sourceIds, sources);
      children.get(parent).push(child); neighbours.get(parent).push(child); neighbours.get(child).push(parent); indegree.set(child, indegree.get(child) + 1);
    }
    const pending = [...people].filter(id => indegree.get(id) === 0); let visited = 0;
    while (pending.length) { const parent = pending.pop(); visited++; for (const child of children.get(parent)) { indegree.set(child, indegree.get(child) - 1); if (!indegree.get(child)) pending.push(child); } }
    requireThat(visited === people.size, '亲子关系不可存在循环');
    const connected = new Set([value.rootPersonId]); pending.push(value.rootPersonId);
    while (pending.length) for (const other of neighbours.get(pending.pop())) if (!connected.has(other)) { connected.add(other); pending.push(other); }
    requireThat(connected.size === people.size, '家族人物须与选定人物连通'); return people;
  }
  function validateGenealogies(state) {
    fields(state, ['revision', 'families', 'links']); revision(state.revision); list(state.families, 500); list(state.links, 5000);
    const families = new Map(), keys = new Set(), links = new Set();
    for (const item of state.families) {
      const people = family(item); requireThat(!families.has(item.id) && !keys.has(item.sourceKey), '家族编号或来源重复'); families.set(item.id, people); keys.add(item.sourceKey);
    }
    for (const link of state.links) {
      fields(link, ['characterId', 'characterName', 'familyId', 'personId']); uuid(link.characterId, 'character-'); text(link.characterName, 60, 1); identifier(link.familyId); identifier(link.personId);
      const key = JSON.stringify([link.characterId, link.characterName, link.familyId, link.personId]);
      requireThat(families.get(link.familyId)?.has(link.personId) && !links.has(key), '人物家族关联无效或重复'); links.add(key);
      // Historical links intentionally survive character deletion/renaming, as on the server.
    }
  }
  function validateDocument(document) {
    fields(document, STORE_KEYS);
    validateCharacters(document.characters); validateAnnotations(document.mapAnnotations);
    validateTerritories(document.territoryEdits, document.mapAnnotations); validatePeriods(document.placePeriods); validateGenealogies(document.genealogies);
    for (const key of STORE_KEYS) size(document[key], MAX_STORE);
  }

  function mutateCharacters(state, payload) {
    const stampNow = new Date().toISOString(), op = payload.op;
    const schemas = { add: ['character'], update: ['id', 'character'], move: ['id', 'lon', 'lat'], 'set-hidden': ['id', 'hidden'], remove: ['id'], 'formation-add': ['formation'], 'formation-update': ['id', 'formation'], 'formation-remove': ['id'] };
    requireThat(Object.hasOwn(schemas, op), '人物操作无效'); fields(payload, ['revision', 'op', ...schemas[op]]);
    if (op.startsWith('formation-')) {
      const at = state.formations.findIndex(item => item.id === payload.id);
      requireThat(op === 'formation-add' || at !== -1, '找不到该编队');
      if (op === 'formation-remove') state.formations.splice(at, 1);
      else {
        fields(payload.formation, ['name', 'commanderId', 'memberIds']); text(payload.formation.name, 80, 1);
        const value = { ...payload.formation, name: payload.formation.name.trim() };
        formation(value, new Set(state.characters.map(item => item.id)));
        const previous = state.formations[at];
        const record = { ...value, id: previous?.id || newId('formation-'), createdAt: previous?.createdAt || stampNow, updatedAt: stampNow };
        if (op === 'formation-add') state.formations.push(record); else state.formations[at] = record;
      }
    } else if (op === 'add') state.characters.push({ ...characterInput(payload.character), id: newId('character-'), createdAt: stampNow, updatedAt: stampNow, hidden: false });
    else {
      const at = state.characters.findIndex(item => item.id === payload.id); requireThat(at !== -1, '找不到该人物');
      const previous = state.characters[at], group = state.formations.find(item => item.memberIds.includes(previous.id));
      if (op === 'remove') { requireThat(!group, '该人物属于编队，请先编辑或解散编队'); state.characters.splice(at, 1); }
      else if (op === 'set-hidden') { requireThat(typeof payload.hidden === 'boolean', '隐藏状态须为布尔值'); previous.hidden = payload.hidden; previous.updatedAt = stampNow; }
      else if (op === 'update') {
        const value = characterInput(payload.character, previous);
        requireThat(!group || value.lon === previous.lon && value.lat === previous.lat, '编队成员不可单独修改坐标，请整体拖动或解散编队');
        state.characters[at] = { ...previous, ...value, updatedAt: stampNow };
      } else {
        position(payload.lon, payload.lat);
        if (!group) Object.assign(previous, { lon: payload.lon, lat: payload.lat, updatedAt: stampNow });
        else {
          const y = lat => Math.asinh(Math.tan(lat * Math.PI / 180));
          const deltaLon = payload.lon - previous.lon, deltaY = y(payload.lat) - y(previous.lat), maximum = y(85), members = new Set(group.memberIds);
          for (const member of state.characters) if (members.has(member.id)) {
            let lon = member.lon + deltaLon, lat = member.lat;
            if (deltaY) { const projected = y(lat) + deltaY; requireThat(projected >= -maximum && projected <= maximum, '整体移动将有成员超出纬度范围；未移动任何成员'); lat = Math.atan(Math.sinh(projected)) * 180 / Math.PI; }
            if (member.id === previous.id) { lon = payload.lon; lat = payload.lat; }
            position(lon, lat); Object.assign(member, { lon, lat, updatedAt: stampNow });
          }
          group.updatedAt = stampNow;
        }
      }
    }
    validateCharacters(state);
  }
  function mutate(document, key, payload) {
    requireThat(object(payload), '请求须为JSON对象'); revision(payload.revision);
    const state = document[key];
    if (payload.revision !== state.revision) throw new APIError('其他页面已更改个人副本，请刷新后重试', 409);
    state.revision = nextRevision(state.revision);
    const now = new Date().toISOString();
    if (key === 'characters') mutateCharacters(state, payload);
    else if (key === 'mapAnnotations') {
      requireThat(['add', 'remove'].includes(payload.op), '地点操作须为add或remove');
      fields(payload, ['revision', 'op', ...(payload.op === 'add' ? ['candidateId', 'name', 'note'] : ['id'])]);
      if (payload.op === 'add') {
        text(payload.name, 100, 1); text(payload.note, 500);
        requireThat(typeof payload.candidateId === 'string' && payload.candidateId.length <= 100, '候选编号无效');
        const cached = candidates.get(payload.candidateId);
        requireThat(cached && cached.expires > Date.now(), '候选已过期或页面已刷新，请重新搜索');
        state.annotations.push({ ...cached.value, name: payload.name.trim(), id: newId('user-'), note: payload.note, createdAt: now });
      } else {
        const at = state.annotations.findIndex(item => item.id === payload.id); requireThat(at !== -1, '找不到该地点');
        requireThat(!document.territoryEdits.edits.some(item => item.placeId === payload.id), '地点被疆域编辑引用，请先撤销相关编辑'); state.annotations.splice(at, 1);
      }
      validateAnnotations(state);
    } else if (key === 'territoryEdits') {
      requireThat(['add', 'remove', 'clear'].includes(payload.op), '疆域操作无效'); fields(payload, ['revision', 'op', ...(payload.op === 'add' ? ['edit'] : payload.op === 'remove' ? ['id'] : [])]);
      if (payload.op === 'add') { fields(payload.edit, ['placeId', 'startYear', 'polityId', 'geometry', 'note']); state.edits.push({ ...payload.edit, id: newId(), sequence: state.revision, createdAt: now }); }
      else if (payload.op === 'clear') state.edits = [];
      else { const at = state.edits.findIndex(item => item.id === payload.id); requireThat(at !== -1, '找不到该疆域编辑'); state.edits.splice(at, 1); }
      validateTerritories(state, document.mapAnnotations);
    } else if (key === 'placePeriods') {
      requireThat(['set', 'reset'].includes(payload.op), '显示年代操作无效'); fields(payload, ['revision', 'op', 'placeId', ...(payload.op === 'set' ? ['begin', 'end'] : [])]);
      requireThat(index().places.has(payload.placeId), '请选择原始地图地点');
      state.overrides = state.overrides.filter(item => item.placeId !== payload.placeId);
      if (payload.op === 'set') state.overrides.push({ placeId: payload.placeId, begin: payload.begin, end: payload.end, updatedAt: now });
      validatePeriods(state);
    }
    return state;
  }

  const normalize = value => value.normalize('NFKD').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/[\p{M}\s]/gu, '');
  function historicalKind(feature, kind) {
    const patterns = { city: /县|縣|城|\bxian\b|\bcity\b|\btown\b|settlement/i, county: /县|縣|郡|州|府|尹|\bxian\b|\bjun\b|\bzhou\b|prefecture|county/i };
    return patterns[kind].test(feature);
  }
  async function searchPlaces(params) {
    const entries = [...params]; unique(entries.map(entry => entry[0]), '搜索参数不可重复');
    requireThat(entries.every(([key]) => ['q', 'kind', 'year', 'scope'].includes(key)) && ['q', 'kind', 'year'].every(key => params.has(key)), '搜索参数应为q、kind、year及可选scope');
    const query = params.get('q').trim(), kind = params.get('kind'), scope = params.get('scope') || 'auto', year = Number(params.get('year'));
    text(query, 80, 1); requireThat(!/[\u0000-\u001f]/u.test(query), '搜索名称含控制字符');
    requireThat(['city', 'county', 'lake', 'river'].includes(kind) && ['auto', 'historical', 'modern'].includes(scope), '搜索类别或范围无效');
    requireThat(/^\d{3}$/.test(params.get('year')) && integer(year, 304, 439), '搜索年份须为304至439');
    index();
    const overrides = await transaction(false, document => new Map(document.placePeriods.overrides.map(item => [item.placeId, item])));
    const water = ['lake', 'river'].includes(kind), rows = (water ? window.GEO_DATA[kind + 'Labels'] || [] : window.GEO_DATA.places).map(row => [row, kind]);
    for (const native of ['lake', 'river']) if (native !== kind) for (const row of window.GEO_DATA[native + 'Labels'] || []) if (row.historical === true) rows.push([row, native]);
    const matches = [], warnings = ['个人版仅搜索内置地点，不连接外部地名服务。须自行核对同名异地、坐标与年代。'];
    const normalizedQuery = normalize(query);
    for (const [row, originalKind] of rows) {
      let native = originalKind;
      const nativeWater = ['lake', 'river'].includes(native), researched = row.historical === true;
      if (scope === 'modern' && (researched || !nativeWater) || scope === 'historical' && nativeWater && !researched) continue;
      let feature = row.kind || '';
      if (row.referenceSite === true && !['city', 'county'].some(type => historicalKind(feature, type))) feature = /郡|州/.test(row.name) ? '郡治参照' : '古城参照';
      const names = [row.name, ...(row.aliases || [])];
      const matched = names.find(name => normalize(name) === normalizedQuery) || (native === kind ? names.find(name => normalize(name).includes(normalizedQuery)) : null);
      if (!matched) continue;
      if (!nativeWater && !historicalKind(feature, kind)) {
        const other = kind === 'city' ? 'county' : 'city';
        if (normalize(matched) !== normalizedQuery || !historicalKind(feature, other)) continue;
        native = other;
      }
      if (!(Number.isFinite(row.lon) && row.lon >= 73 && row.lon <= 136 && Number.isFinite(row.lat) && row.lat >= 15 && row.lat <= 54)) continue;
      const rawPeriod = row.period || {}, begin = Number(rawPeriod.begin), end = Number(rawPeriod.end);
      let period = integer(begin, -3000, 2100) && integer(end, begin, 2100) && begin !== 0 && end !== 0 ? { begin, end } : null;
      const override = !nativeWater && overrides.get(row.id);
      if (override ? year < override.begin || year > override.end : row.referenceSite !== true && period && (year < period.begin || year > period.end)) continue;
      const source = Array.isArray(row.source) ? row.source[0] || '' : row.source || '';
      let note = row.note || (nativeWater ? '现代自然地理参照，不代表古代河道或湖岸。' : '内置历史地点代表点，不推断各年实际统治。');
      if (override) { note += ` 原始来源年代：${rawPeriod.begin ?? '未载'}—${rawPeriod.end ?? '未载'}年；用户显示年代：${override.begin}—${override.end}年。用户显示年代非史料修订，不是历史建置有效期证据；不证明所选年份的建置、都城身份或政治归属。`; period = null; }
      else if (row.referenceSite === true) { note += ' 固定古址参照，不按参考图年份筛除；不证明所选年份的建置、都城身份或政治归属。'; period = null; }
      const value = { name: row.name, kind: native, lon: row.lon, lat: row.lat, address: row.address || row.modernName || row.name, provider: researched ? '历史地名考证' : 'local', providerId: row.id, matchedName: matched, sourceUrl: source, license: row.license || (researched ? '依原始来源条款；考证位置不是原图测绘数据' : nativeWater ? 'Natural Earth 公有领域' : source.includes('chgis.') ? 'CC BY-NC 4.0（非商业）' : '依原始来源条款；未声明开放许可'), temporalNote: note, coordinatePrecision: row.coordinatePrecision || '内置资料代表点；非城墙、辖界、河道或湖面测绘', period };
      try { candidate(value); } catch { warnings.push(`内置地点“${row.name}”来源或资料不完整，未作为可保存候选。`); continue; }
      matches.push({ exact: normalize(matched) === normalizedQuery, researched, value });
    }
    matches.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.researched) - Number(a.researched));
    const now = Date.now(), result = [], seen = new Set();
    for (const [token, cached] of candidates) if (cached.expires <= now) candidates.delete(token);
    for (const { value } of matches) {
      const key = JSON.stringify([value.sourceUrl, value.kind, value.lon, value.lat]); if (seen.has(key)) continue; seen.add(key);
      const token = newId(); candidates.set(token, { value, expires: now + 900000 }); result.push({ ...value, candidateId: token }); if (result.length === 20) break;
    }
    while (candidates.size > 2000) candidates.delete(candidates.keys().next().value);
    if (!result.length) warnings.push('没有找到符合类别与显示年代的内置地点；这不表示该古地名不存在。');
    if (result.some(value => value.kind !== kind)) warnings.push('精确名称匹配的跨类别地点保留资料真实类别，不改写城邑、郡县或河湖类型。');
    return { candidates: result, warnings: [...new Set(warnings)] };
  }

  function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
  async function fetchAPI(input, options) {
    if (mode === 'shared') return window.fetch(input, options);
    let parsed;
    try { parsed = new URL(input instanceof Request ? input.url : String(input), location.href); }
    catch { return window.fetch(input, options); }
    if (parsed.origin !== location.origin || !parsed.pathname.startsWith('/api/')) return window.fetch(input, options);
    try {
      const method = String(options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const key = ROUTES.get(parsed.pathname);
      if (parsed.pathname === '/api/character-biographies' || parsed.pathname === '/api/genealogy-search' || key === 'genealogies' && method !== 'GET') throw new APIError('个人版不提供在线人物简介或家族搜索生成；请使用自定义人物、内置家族资料或导入备份。在线功能需Python共享版', 503);
      if (parsed.pathname === '/api/place-search') { requireThat(method === 'GET', '地点搜索只接受GET'); return response(await searchPlaces(parsed.searchParams)); }
      if (!key) return response({ error: '个人版不支持此API；未向服务器发送请求' }, 404);
      if (method === 'GET') return response(await transaction(false, document => document[key]));
      requireThat(method === 'POST' && !parsed.search, '请求方法或路径无效');
      const headers = new Headers(options?.headers || (input instanceof Request ? input.headers : undefined));
      requireThat(headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json', '提交格式必须为application/json');
      const raw = options?.body !== undefined ? options.body : input instanceof Request ? await input.clone().text() : '';
      const payload = strictJSON(raw, 131072);
      return response(await transaction(true, document => mutate(document, key, payload)));
    } catch (error) { return response({ error: error instanceof APIError ? error.message : '请求处理失败；未更改个人副本' }, error instanceof APIError ? error.status : 400); }
  }
  async function exportData() {
    if (mode !== 'personal') throw new APIError('个人副本导出仅适用于个人版');
    const stores = await transaction(false, document => document);
    const result = backupEnvelope(stores);
    size(result, MAX_IMPORT); return result;
  }
  async function importData(doc) {
    if (mode !== 'personal') throw new APIError('个人副本导入仅适用于个人版');
    const imported = typeof doc === 'string' ? strictJSON(doc, MAX_IMPORT) : cloneDocument(doc);
    fields(imported, ['format', 'version', 'exportedAt', 'stores']);
    requireThat(imported.format === 'tongjian-atlas-personal' && imported.version === 1, '备份格式或版本不受支持'); stamp(imported.exportedAt);
    validateDocument(imported.stores);
    await transaction(true, document => {
      for (const key of STORE_KEYS) {
        imported.stores[key].revision = nextRevision(Math.max(document[key].revision, imported.stores[key].revision));
        document[key] = imported.stores[key];
      }
    });
    candidates.clear();
  }
  window.AtlasAPI = Object.freeze({ mode, fetch: fetchAPI, exportData, importData });
})();
