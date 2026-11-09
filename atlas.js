(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const text = (tag, value, className) => {
    const element = document.createElement(tag);
    element.textContent = value == null ? '' : String(value);
    if (className) element.className = className;
    return element;
  };
  function sourceLinks(container, sources) {
    container.replaceChildren();
    (Array.isArray(sources) ? sources : [sources]).filter(Boolean).forEach(source => {
      const url = typeof source === 'string' ? source : source.url;
      const title = typeof source === 'string' ? source : source.title || source.url;
      if (/^https?:\/\//i.test(url || '')) {
        const link = text('a', title);
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        container.append(link);
      } else container.append(text('p', title || source));
    });
  }
  function fatal(message) {
    $('map-error').hidden = false;
    $('map-error').textContent = message;
    $('event-title').textContent = '本地地图未能启动';
    document.querySelectorAll('.timeline button, .timeline input, .timeline select, .layer-controls input, #city-search, #reset-view').forEach(element => { element.disabled = true; });
  }
  const geo = window.GEO_DATA;
  const history = window.HISTORY_DATA;
  if (!window.L || !geo || !history) {
    const missing = [!window.L && 'vendor/leaflet.js', !geo && 'geo-data.js', !history && 'history-data.js'].filter(Boolean);
    fatal(`缺少本地文件或加载失败：${missing.join('、')}。请保持这些文件与 index.html 的相对位置，重新打开。可从顶部“原图图册”继续查阅原图。`);
    return;
  }
  if (![geo.land, geo.rivers, geo.lakes].every(collection => collection && collection.type === 'FeatureCollection' && Array.isArray(collection.features)) || !Array.isArray(geo.places) || !Array.isArray(geo.mountains) || !Array.isArray(history.snapshots) || !history.snapshots.length || !Array.isArray(history.polities)) {
    fatal('本地地理或历史资料格式不完整。需要完整的 GEO_DATA 地理集合和 HISTORY_DATA 历史断面；未生成模拟地图。');
    return;
  }
  const snapshots = history.snapshots.slice().sort((a, b) => a.year - b.year);
  const minYear = history.minYear ?? snapshots[0].year;
  const maxYear = history.maxYear ?? snapshots.at(-1).year;
  if (snapshots.some(snapshot => !Number.isFinite(snapshot.year) || !Array.isArray(snapshot.features)) || !Number.isInteger(minYear) || !Number.isInteger(maxYear) || minYear > maxYear || snapshots[0].year > minYear) {
    fatal('历史断面资料无效，或缺少起始年份参照。请检查 history-data.js。');
    return;
  }
  const css = getComputedStyle(document.documentElement);
  for (const id of ['year-range', 'territory-year']) {
    $(id).min = minYear; $(id).max = maxYear;
  }
  $('year-range').setAttribute('aria-label', `选择公元${minYear}至${maxYear}年`);
  document.querySelector('.timeline').setAttribute('aria-label', `${minYear}至${maxYear}年时间轴`);
  $('atlas-year-span').textContent = `${minYear}—${maxYear}`;
  document.querySelector('.timeline-scale').replaceChildren(...Array.from({ length: 6 }, (_, index) => text('span', Math.round(minYear + (maxYear - minYear) * index / 5))));
  const token = name => css.getPropertyValue(name).trim();
  const polities = new Map(history.polities.map(polity => [polity.id, polity]));
  const review = window.TERRITORY_REVIEW;
  const reviewPolities = new Map([...history.polities, ...(review?.polities || [])].map(polity => [polity.id, polity]));
  const reviewRules = new Map();
  for (const rule of review?.rules || []) {
    if (!Array.isArray(rule.placeIds)) continue;
    for (const id of rule.placeIds) {
      if (!reviewRules.has(id)) reviewRules.set(id, []);
      reviewRules.get(id).push(rule);
    }
  }
  const ownerNames = owners => owners.map(id => reviewPolities.get(id)?.name || id).join('、');
  const ownerKey = owners => [...new Set(owners)].sort().join('|');
  function politicalClue(entry) {
    // Only explicit ID/year evidence applies; reference-site visibility never extends a rule.
    const rules = (reviewRules.get(entry.place.id) || []).filter(rule => Number.isInteger(rule.begin) && Number.isInteger(rule.end) && rule.begin <= selectedYear && selectedYear <= rule.end);
    const first = rules[0]?.owners;
    const consistent = Array.isArray(first) && first.length > 0 && rules.every(rule => Array.isArray(rule.owners) && rule.owners.length > 0 && ownerKey(rule.owners) === ownerKey(first));
    return { rules, owners: consistent ? [...new Set(first)] : [], status: !Array.isArray(review?.rules) ? 'unavailable' : !rules.length ? 'unreviewed' : consistent ? 'consistent' : 'conflict' };
  }
  let territoryEditor = null;
  let placeManager = null;
  let politicalFeatures = null;
  const editState = () => window.TerritoryEdits?.getState() || { edits: [], revision: 0 };
  const eventYears = () => [...new Set([...snapshots.map(item => item.year), ...editState().edits.map(edit => edit.startYear)])].filter(year => year >= minYear && year <= maxYear).sort((a, b) => a - b);
  const initialBounds = [[20, 92], [44, 125]];
  const map = L.map('map', { minZoom: 3, maxZoom: 10, zoomSnap: .25, attributionControl: true });
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('地形、水系：现代参考 · 疆域：概略重建');
  function pane(name, z, interactive = false) {
    const element = map.createPane(name);
    element.style.zIndex = z;
    if (!interactive) element.style.pointerEvents = 'none';
    return element;
  }
  pane('land', 210); pane('terrain', 220); pane('water', 230);
  pane('historical', 260); pane('mountains', 440); pane('cities', 450, true); pane('cityLabels', 460);
  pane('riverLabels', 470, true);
  pane('regionalPowers', 425, true).classList.add('political-pane');
  const regionalPowerLayer = L.layerGroup();
  const regionalPowerPopup = L.popup({ autoPan: false, maxWidth: 340, maxHeight: 360 });
  let regionalPowers = [];
  const slots = [0, 1].map(index => {
    const areaPane = pane(`politics${index}`, 310 + index, true);
    const labelPane = pane(`politicsLabels${index}`, 420 + index);
    areaPane.classList.add('political-pane'); labelPane.classList.add('political-pane');
    const renderer = L.svg({ pane: `politics${index}` }).addTo(map);
    return { areaPane, labelPane, renderer, group: null, shapes: null, labels: [], index };
  });
  L.geoJSON(geo.land, { pane: 'land', interactive: false, style: { color: token('--line'), weight: 1, fillColor: token('--land'), fillOpacity: 1 } }).addTo(map);
  let terrain = null;
  if (geo.terrain && geo.terrain.url && geo.terrain.bounds) {
    terrain = L.imageOverlay(geo.terrain.url, geo.terrain.bounds, { pane: 'terrain', opacity: .72, interactive: false, attribution: '地形：<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen/AWS</a> · USGS SRTM/GMTED2010 · NOAA ETOPO1' }).addTo(map);
    $('layer-terrain').checked = true;
    $('layer-terrain').disabled = false;
    terrain.on('error', () => {
      $('layer-terrain').checked = false; $('layer-terrain').disabled = true;
      map.removeLayer(terrain);
      $('tile-status').textContent = '本地地形图片未加载；陆地、城市及水系仍可使用。';
    });
  } else { $('layer-terrain').checked = false; $('layer-terrain').disabled = true; $('layer-terrain').parentElement.title = '本地未提供地形影像'; }
  const water = L.layerGroup([
    L.geoJSON(geo.lakes, { pane: 'water', interactive: false, style: { color: token('--river'), weight: .7, fillColor: token('--water'), fillOpacity: .9 } }),
    L.geoJSON(geo.rivers, { pane: 'water', interactive: false, style: { color: token('--river'), weight: 1.4, opacity: .9 } })
  ]).addTo(map);
  const cityLayer = L.layerGroup().addTo(map);
  const cityRenderer = L.canvas({ pane: 'cities', padding: .1 });
  const yearNumber = value => /^-?\d+$/.test(String(value ?? '').trim()) ? Number(value) : NaN;
  const inPeriod = (begin, end, year) => Number.isFinite(begin) && Number.isFinite(end) && begin <= year && year <= end;
  const category = place => /郡|州/.test(place.kind || '') ? 'prefecture' : /县|縣/.test(place.kind || '') ? 'county' : 'city';
  const cityMarkers = geo.places.filter(place => Number.isFinite(place.lat) && Number.isFinite(place.lon)).map((place, index) => ({
    place, key: `${place.lat},${place.lon}`, category: category(place),
    priority: Number.isFinite(place.priority) ? place.priority : index < 27 ? 0 : category(place) === 'county' ? 2 : 1,
    begin: yearNumber(place.period?.begin), end: yearNumber(place.period?.end),
    search: [place.name, ...(Array.isArray(place.aliases) ? place.aliases : [])].join('\n').toLocaleLowerCase()
  })).sort((a, b) => Number(Boolean(b.place.referenceSite)) - Number(Boolean(a.place.referenceSite)) || a.priority - b.priority || Number(b.category === 'city') - Number(a.category === 'city'));
  const sites = new Map();
  // Page-session label choices; eligibility still follows the active filters and display periods.
  const siteLabelChoices = new Map();
  cityMarkers.forEach(entry => {
    if (!sites.has(entry.key)) sites.set(entry.key, []);
    sites.get(entry.key).push(entry);
  });
  const names = new Map();
  cityMarkers.filter(entry => !entry.place.referenceSite).forEach(entry => {
    if (!names.has(entry.place.name)) names.set(entry.place.name, []);
    names.get(entry.place.name).push(entry);
  });
  const visibleCities = new Map();
  const labelMeasure = document.createElement('canvas').getContext('2d');
  const labelGap = parseFloat(token('--s2'));
  const cityColors = { city: token('--city'), prefecture: token('--prefecture'), county: token('--county') };
  let visiblePlaceCount = 0;
  let cityLabelCount = 0;
  let visiblePlaceIds = [];
  let visibleCityLabelIds = [];
  let selectedPlace = null;
  let openPlace = null;
  const placePopup = L.popup({ autoPan: true, maxWidth: 340, maxHeight: 360 });
  const isCurrent = entry => inPeriod(entry.begin, entry.end, selectedYear);
  const displayPeriod = entry => window.PlacePeriods?.lookup(entry.place.id) || null;
  const displayEligible = entry => { const override = displayPeriod(entry); return override ? inPeriod(override.begin, override.end, selectedYear) : Boolean(entry.place.referenceSite) || isCurrent(entry); };
  const displayText = entry => { const override = displayPeriod(entry); return override ? `用户显示年代：${override.begin}—${override.end}年（非史料修订）` : '用户显示年代：未设置，沿用原始显示规则'; };
  const periodText = entry => ['begin', 'end'].map((key, index) => Number.isFinite(entry[key]) ? `${entry.place.period?.[`${key} rule`] && String(entry.place.period[`${key} rule`]) !== '1' ? '约' : ''}${entry[key]}` : index ? '止年不明' : '起年不明').join('—') + '年';
  const currentParents = entry => (entry.place.administrativeHistory || []).filter(item => inPeriod(yearNumber(item['begin year']), yearNumber(item['end year']), selectedYear));
  const matchesPlaceFilter = entry => entry === selectedPlace || (($('place-type').value === 'all' || $('place-type').value === entry.category) && (!$('place-year-only').checked || displayEligible(entry)));
  const preferredSiteEntry = key => siteLabelChoices.get(key) || (selectedPlace?.key === key ? selectedPlace : null);
  function placeLabel(entry) {
    if (entry.place.referenceSite) return entry.place.name;
    const peers = names.get(entry.place.name) || [];
    if (peers.length < 2) return entry.place.name;
    const clue = politicalClue(entry);
    const parent = currentParents(entry).map(item => item.name || item['parent id']).join('、');
    const qualifier = clue.status === 'consistent' ? `核对：${ownerNames(clue.owners)}` : clue.status === 'conflict' ? '政治线索冲突待核' : `资料：${parent || '父级未明'}`;
    if (!$('place-year-only').checked) return `${entry.place.name}（${qualifier} · ${periodText(entry)}）`;
    if (peers.filter(displayEligible).length > 1) return `${entry.place.name}（${qualifier}）`;
    return entry.place.name;
  }
  function yearStatus(entry) {
    if (entry.place.referenceSite) return '固定历史地点，仅作跨期地理参照；不表示所选年份为都城或郡治';
    return isCurrent(entry) ? `${selectedYear}年在记录有效期内（不代表政权控制）` : !Number.isFinite(entry.begin) || !Number.isFinite(entry.end) ? `记录年代不完整，不能确认${selectedYear}年有效` : `${selectedYear}年不在此条记录有效期内`;
  }
  function placeNotice(entry, changes = []) {
    $('place-notice').hidden = false;
    $('place-notice').textContent = `${entry.place.name}：${yearStatus(entry)}。${changes.length ? changes.join('；') + '。' : ''}所选年份未改变。`;
  }
  function appendPoliticalReview(popup, entry, ownership) {
    const clue = politicalClue(entry);
    const canLocate = Array.isArray(politicalFeatures) && typeof window.TerritoryEdits?.ownersAtPlace === 'function';
    const owners = canLocate ? window.TerritoryEdits.ownersAtPlace(entry.place.id, politicalFeatures) : [];
    const section = text('section', '', 'place-review');
    section.setAttribute('aria-label', '政治线索与图面核对');
    section.dataset.reviewStatus = clue.status;
    section.dataset.coverageStatus = !canLocate ? 'unavailable' : !owners.length ? 'missing' : owners.length > 1 ? 'multiple' : 'covered';
    section.dataset.userEdited = String(Boolean(ownership));
    const coverage = text('p', `当前图面覆盖势力（${selectedYear}年）：${!canLocate ? '无法读取，不能判定覆盖。' : owners.length ? ownerNames(owners) : '无覆盖面；此地点仍保留显示。'}`);
    coverage.dataset.reviewCoverage = '';
    section.append(coverage);
    const clueText = clue.status === 'consistent' ? `${ownerNames(clue.owners)}（明确ID与年份范围内的政治语境，不等于县级实控或县界证明）` : clue.status === 'conflict' ? '匹配规则归属不一致，冲突待核；不采用单一政治名称。' : clue.status === 'unavailable' ? '核查规则未加载，不能宣称已核验。' : '此ID在所选年份无人工规则，尚未核查，不能宣称通过。';
    const evidence = text('p', `人工核查政治线索：${clueText}`);
    evidence.dataset.reviewEvidence = '';
    section.append(evidence);
    if (clue.status === 'consistent') section.append(text('p', '原行政父级仅为原资料，可能存在误记或跨朝代延续；与人工政治线索不同不表示当前仍由该父级政权控制。', 'hint'));
    if (ownership) section.append(text('p', '当前图面含用户编辑，原始核验见报告。下列图面对照仅说明自定义覆盖与人工线索的差异，不计为原始历史错误。', 'reference-note'));
    const comparison = !canLocate ? 'unavailable' : !owners.length ? 'missing' : clue.status !== 'consistent' ? clue.status : ownerKey(owners) === ownerKey(clue.owners) ? 'aligned' : 'mismatch';
    section.dataset.comparison = comparison;
    const warnings = [];
    if (!canLocate) warnings.push('当前图面读取不可用，暂不能做点面核对。');
    else if (!owners.length) warnings.push('缺面提示：当前图面没有覆盖此点，不能用修改地点标签代替修复疆域。');
    if (owners.length > 1) warnings.push('多面覆盖：此点位于重叠面或公共边界，不能据此认定唯一实控。');
    if (comparison === 'mismatch') warnings.push(ownership ? '用户图面对照：自定义覆盖与人工原始政治线索不一致。' : '点面不一致：当前图面覆盖与人工政治线索不同，须核查疆域面及地点定位。');
    if (clue.status === 'conflict') warnings.push('人工规则相互冲突，待核实来源与年代。');
    if (comparison === 'aligned') section.append(text('p', `${ownership ? '用户图面' : '当前图面'}与人工政治线索相符；仅为本点对照，不表示整片疆域或县级实控已通过核验。`, 'hint'));
    warnings.forEach(message => section.append(text('p', message, 'reference-note')));
    for (const rule of clue.rules) {
      const details = document.createElement('details');
      details.dataset.reviewRule = rule.id;
      details.append(text('summary', `${rule.begin}—${rule.end}年 · ${ownerNames(rule.owners || []) || '归属未明'} · ${rule.id}`));
      details.append(text('p', rule.note || '来源未提供补充说明。'));
      const links = text('div', '', 'source-body'); sourceLinks(links, rule.evidence || []); details.append(links);
      section.append(details);
    }
    popup.append(section);
  }
  function popupContent(entry) {
    const { place } = entry;
    const popup = text('div', '', 'place-popup');
    popup.dataset.placeId = place.id;
    popup.append(text('h3', place.name), text('p', `${place.referenceSite ? '固定历史地点 · 资料年代' : `${place.kind || '历史城市'} · 记录起止`}：${periodText(entry)}`), text('p', yearStatus(entry), 'reference-note'));
    const displayInfo = text('p', displayText(entry), 'reference-note'); displayInfo.dataset.displayPeriod = place.id; popup.append(displayInfo);
    const periodButton = text('button', '编辑显示年代'); periodButton.type = 'button'; periodButton.dataset.editDisplayPeriod = place.id;
    periodButton.disabled = !window.PlacePeriods;
    periodButton.addEventListener('click', () => { stopPlayback(); window.PlacePeriods.edit(place); }); popup.append(periodButton);
    if (!place.referenceSite) {
      const parents = isCurrent(entry) ? currentParents(entry) : [];
      const originalParents = text('p', parents.length ? `${selectedYear}年行政父级（原资料）：${parents.map(item => item.name || item['parent id']).join('、')}（保留来源记录，非当年政权控制结论）` : `${selectedYear}年行政父级（原资料）：无可确认的当年记录。`);
      originalParents.dataset.originalParents = '';
      popup.append(originalParents);
    }
    const ownership = window.TerritoryEdits?.ownershipAtPlace(place.id, selectedYear);
    popup.append(text('p', ownership ? `用户编辑归属：${polities.get(ownership.polityId)?.name || ownership.polityId} · ${ownership.startYear}年起（自定义覆盖，非原始史实；CHGIS行政父级保持原记录）` : '用户编辑归属：当前年无覆盖此点的编辑。', 'reference-note'));
    appendPoliticalReview(popup, entry, ownership);
    const editButton = text('button', '编辑此地归属'); editButton.type = 'button'; editButton.dataset.editPlace = place.id;
    editButton.disabled = location.protocol === 'file:' || !window.TerritoryEdits?.getState().writable;
    editButton.addEventListener('click', () => territoryEditor?.selectPlace(place)); popup.append(editButton);
    const auditLink = text('a', '核查报告未随公开版发布 · 查看说明');
    auditLink.href = 'sources.html#audit';
    auditLink.target = '_blank'; auditLink.rel = 'noopener'; auditLink.dataset.auditPlace = place.id;
    const auditParagraph = text('p', ''); auditParagraph.append(auditLink); popup.append(auditParagraph);
    if (place.period?.['begin rule'] || place.period?.['end rule']) popup.append(text('p', `来源年代规则：起年 ${place.period['begin rule'] || '未注明'} / 止年 ${place.period['end rule'] || '未注明'}；标“约”的界年保留来源的不确定性，非精确迁治日期。`));
    popup.append(text('p', place.note || '历史地点定位参照；迁治、侨置与坐标精度请查原始条目，不表示建置连续。'));
    popup.append(text('p', `${place.lat.toFixed(5)}°N，${place.lon.toFixed(5)}°E · ${place.id}`));
    const sources = document.createElement('div'); sourceLinks(sources, place.source); popup.append(sources);
    const colocated = sites.get(entry.key);
    if (colocated.length > 1) {
      const preferred = preferredSiteEntry(entry.key);
      const active = preferred && matchesPlaceFilter(preferred) ? preferred : colocated.find(matchesPlaceFilter);
      popup.append(text('p', `当地共址记录 ${colocated.length} 条（可跨年代，不表示同时存在）：点击选择地图标名。本页记住各点选择，刷新后恢复默认；不修改史料或显示年代，不符合筛选时自动改用有效记录。`));
      const list = text('div', '', 'colocated-records');
      const more = text('button', '下一组共址记录'); more.type = 'button';
      let offset = Math.floor(Math.max(0, colocated.indexOf(active)) / 10) * 10;
      const show = () => {
        list.replaceChildren(...colocated.slice(offset, offset + 10).map(other => {
          const button = text('button', `${other === active ? '当前标名：' : '选为标名：'}${other.place.name} · ${other.place.kind || '历史城市'} · ${periodText(other)}`);
          button.append(text('small', ` · ${displayText(other)}`));
          button.type = 'button'; button.dataset.placeId = other.place.id;
          button.setAttribute('aria-pressed', String(other === active));
          button.addEventListener('click', () => focusPlace(other));
          return button;
        }));
        more.textContent = `下一组共址记录（${offset + 1}—${Math.min(offset + 10, colocated.length)} / ${colocated.length}）`;
      };
      more.addEventListener('click', () => { offset = offset + 10 < colocated.length ? offset + 10 : 0; show(); });
      show(); popup.append(list); if (colocated.length > 10) popup.append(more);
    }
    return popup;
  }
  function openPlacePopup(entry) {
    if (territoryEditor?.isDrawing()) return;
    if (territoryEditor?.isActive()) territoryEditor.selectPlace(entry.place);
    placePopup.setLatLng([entry.place.lat, entry.place.lon]).setContent(popupContent(entry)).openOn(map);
    openPlace = entry;
    selectedPlace = entry;
    arrangeLabels();
  }
  map.on('popupclose', event => { if (event.popup === placePopup) { openPlace = null; selectedPlace = null; arrangeLabels(); } });
  function focusPlace(entry) {
    const changes = [];
    $('layer-cities').checked = true; cityLayer.addTo(map);
    selectedPlace = entry;
    if (sites.get(entry.key).length > 1) siteLabelChoices.set(entry.key, entry);
    if ($('place-year-only').checked && !displayEligible(entry)) changes.push('仅临时显示此条异期记录，关闭弹窗即结束；可点击“编辑显示年代”，或取消勾选“仅显示所选年份有效建置”');
    if ($('place-type').value !== 'all' && $('place-type').value !== entry.category) changes.push('仅此条记录临时不受类型筛选限制');
    placeNotice(entry, changes);
    map.setView([entry.place.lat, entry.place.lon], Math.max(map.getZoom(), 8), { animate: false });
    arrangeLabels(); openPlacePopup(entry);
  }
  const cityLabelLayer = L.layerGroup().addTo(map);
  function renderCities() {
    const bounds = map.getBounds();
    cityLabelLayer.clearLayers();
    const desired = new Map();
    visiblePlaceIds = []; visibleCityLabelIds = []; cityLabelCount = 0;
    if (map.hasLayer(cityLayer)) cityMarkers.forEach(entry => {
      if (!matchesPlaceFilter(entry) || !bounds.contains([entry.place.lat, entry.place.lon])) return;
      visiblePlaceIds.push(entry.place.id);
      if (!desired.has(entry.key) || entry === preferredSiteEntry(entry.key)) desired.set(entry.key, entry);
    });
    visiblePlaceCount = visiblePlaceIds.length;
    visibleCities.forEach((item, key) => {
      if (!desired.has(key)) { cityLayer.removeLayer(item.marker); visibleCities.delete(key); }
    });
    const candidates = [];
    desired.forEach((entry, key) => {
      const { place } = entry;
      let item = visibleCities.get(key);
      if (!item) {
        const marker = L.circleMarker([place.lat, place.lon], { pane: 'cities', renderer: cityRenderer, weight: 1.2, fillOpacity: 1 });
        item = { entry, marker };
        marker.on('click', () => { placeNotice(item.entry); openPlacePopup(item.entry); });
        marker.addTo(cityLayer); visibleCities.set(key, item);
      }
      item.entry = entry;
      const important = place.referenceSite || entry.priority === 0;
      item.marker.setStyle({ color: cityColors[entry.category], fillColor: important ? token('--surface') : cityColors[entry.category] });
      item.marker.setRadius(important ? 4 : entry.category === 'prefecture' ? 3.5 : 2.5);
      const selected = entry === selectedPlace;
      const chosen = siteLabelChoices.get(key) === entry;
      if (!selected && !chosen && map.getZoom() < (important ? 4 : entry.category === 'county' ? 7 : 5)) return;
      const label = placeLabel(entry);
      candidates.push({ entry, label, rank: selected ? -2 : chosen ? -1 : important ? 0 : 3, city: true, show(offset, width, height) {
        const span = text('span', label); span.dataset.placeId = place.id;
        const position = map.containerPointToLatLng(map.latLngToContainerPoint([place.lat, place.lon]).add(offset));
        L.marker(position, { pane: 'cityLabels', interactive: false, keyboard: false, icon: L.divIcon({ html: span, className: `city-label city-label-host${important ? ' city-label-important' : ''}`, iconSize: [width, height], iconAnchor: [width / 2, height / 2] }) }).addTo(cityLabelLayer);
        visibleCityLabelIds.push(place.id); cityLabelCount++;
      } });
    });
    return candidates;
  }
  const riverEntries = ['river', 'lake'].flatMap(category => (Array.isArray(geo[`${category}Labels`]) ? geo[`${category}Labels`] : []).filter(place => Number.isFinite(place.lat) && Number.isFinite(place.lon)).map(place => ({
    place, category, priority: Number.isFinite(place.priority) ? place.priority : 1,
    search: [place.name, place.modernName, ...(Array.isArray(place.aliases) ? place.aliases : [])].filter(Boolean).join('\n').toLocaleLowerCase()
  }))).sort((a, b) => a.priority - b.priority);
  const waterType = entry => entry.category === 'lake' ? '湖泊' : '河流';
  const isWater = entry => entry.category === 'river' || entry.category === 'lake';
  const riverLabelLayer = L.layerGroup().addTo(map);
  const visibleRiverLabels = new Map();
  const riverPopup = L.popup({ autoPan: false, maxWidth: 340, maxHeight: 360 });
  let selectedRiverId = null;
  map.on('popupclose', event => { if (event.popup === riverPopup) selectedRiverId = null; });
  function openRiver(entry) {
    if (territoryEditor?.isDrawing()) return;
    const { place } = entry;
    const popup = text('div', '', 'river-popup'); popup.dataset.waterId = place.id; popup.dataset.riverId = place.id;
    popup.append(text('h3', place.name), text('p', `${waterType(entry)} · 现代对应：${place.modernName || '尚未确认，请查来源'}`));
    if (place.aliases?.length) popup.append(text('p', `别名：${place.aliases.join('、')}`));
    if (place.note) popup.append(text('p', place.note));
    popup.append(text('p', '现代水系仅为地理定位参照，古河道与古湖岸线未复原；不得将现代湖面当作382年或所选年份的古湖范围。', 'reference-note'));
    const sources = document.createElement('div'); sourceLinks(sources, place.source); popup.append(sources);
    const reference = text('a', window.AtlasUI.personal ? '原图未随公开版发布 · 查看来源说明' : '对照382年本地原图与识读说明'); reference.href = window.AtlasUI.personal ? 'sources.html' : '#source-details';
    reference.addEventListener('click', () => { if (window.AtlasUI.personal) return; $('source-details').open = true; document.body.classList.remove('sidebar-hidden'); $('toggle-sidebar').setAttribute('aria-expanded', 'true'); $('toggle-sidebar').textContent = '收起侧栏'; map.invalidateSize({ pan: false }); });
    popup.append(reference);
    riverPopup.setLatLng([place.lat, place.lon]).setContent(popup).openOn(map);
    selectedRiverId = place.id;
    $('place-notice').hidden = false;
    $('place-notice').textContent = `${place.name}：${waterType(entry)}名称与现代水系定位参照；古河道与古湖岸线未复原，所选年份未改变。`;
  }
  function focusRiver(entry) {
    $('layer-rivers').checked = true; water.addTo(map);
    $('layer-river-labels').checked = true; $('layer-river-labels').disabled = false;
    map.setView([entry.place.lat, entry.place.lon], Math.max(map.getZoom(), 7), { animate: false });
    arrangeLabels(); openRiver(entry);
  }
  function renderRiverLabels(candidates) {
    const enabled = map.hasLayer(water) && $('layer-river-labels').checked;
    const bounds = map.getBounds(); const size = map.getSize();
    const desired = new Set();
    riverEntries.forEach(entry => {
      const { place } = entry;
      if (!enabled || map.getZoom() < (entry.priority === 0 ? 4 : 5) || !bounds.contains([place.lat, place.lon])) return;
      candidates.push({ entry, label: place.name, rank: entry.priority === 0 ? 1 : 2, show(offset, width, height) {
        desired.add(entry);
        const position = map.containerPointToLatLng(map.latLngToContainerPoint([place.lat, place.lon]).add(offset));
        if (visibleRiverLabels.has(entry)) { visibleRiverLabels.get(entry).setLatLng(position); return; }
        const button = text('button', place.name, 'river-label'); button.type = 'button'; button.dataset.riverId = place.id; button.dataset.waterId = place.id; button.dataset.waterType = entry.category;
        button.setAttribute('aria-label', `${place.name}，查看${waterType(entry)}古今对应说明`);
        L.DomEvent.disableClickPropagation(button); L.DomEvent.disableScrollPropagation(button);
        button.addEventListener('click', () => openRiver(entry));
        const marker = L.marker(position, { pane: 'riverLabels', keyboard: false, icon: L.divIcon({ html: button, className: 'river-label-host', iconSize: [width, height], iconAnchor: [width / 2, height / 2] }) });
        marker.addTo(riverLabelLayer); visibleRiverLabels.set(entry, marker);
      } });
    });
    const occupied = [];
    labelMeasure.font = `600 ${token('--text-sm')} ${token('--sans')}`;
    candidates.sort((a, b) => a.rank - b.rank).forEach(candidate => {
      const { entry, label } = candidate;
      const width = labelMeasure.measureText(label).width + labelGap * 2;
      const height = parseFloat(token('--text-sm')) * 1.2 + labelGap;
      const point = map.latLngToContainerPoint([entry.place.lat, entry.place.lon]);
      const side = width / 2 + labelGap;
      const offsets = candidate.city ? [[side, 0], [-side, 0], [0, -height], [0, height], [side, -height], [-side, height]] : [[0, 0], [0, -height], [0, height], [labelGap * 3, -height], [-labelGap * 3, height]];
      if (candidate.rank <= -2) offsets.unshift([Math.max(width / 2, Math.min(size.x - width / 2, point.x + side)) - point.x, Math.max(height / 2, Math.min(size.y - height / 2, point.y)) - point.y]);
      for (const offset of offsets) {
        const box = [point.x + offset[0] - width / 2, point.y + offset[1] - height / 2, point.x + offset[0] + width / 2, point.y + offset[1] + height / 2];
        if (box[0] < 0 || box[1] < 0 || box[2] > size.x || box[3] > size.y || occupied.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
        occupied.push(box); candidate.show(offset, width, height); break;
      }
    });
    visibleRiverLabels.forEach((marker, entry) => { if (!desired.has(entry)) { riverLabelLayer.removeLayer(marker); visibleRiverLabels.delete(entry); } });
    const lakeCount = riverEntries.filter(entry => entry.category === 'lake').length;
    const visibleLakes = [...desired].filter(entry => entry.category === 'lake').length;
    $('water-count').textContent = `河流 ${riverEntries.length - lakeCount} · 湖泊 ${lakeCount}；当前标名：河流 ${desired.size - visibleLakes} / 湖泊 ${visibleLakes}${enabled ? '' : '（水名图层已关闭）'}`;
    $('place-count').textContent = `总收录 ${geo.places.length} 条 · 当前范围 ${visiblePlaceCount} 条 / ${visibleCities.size} 个点 · ${cityLabelCount} 个名称${map.hasLayer(cityLayer) ? '' : '（图层已关闭）'}`;
    return occupied;
  }
  const mountainLayer = L.layerGroup();
  const mountainMarkers = geo.mountains.filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon)).map(point => {
    const marker = L.circleMarker([point.lat, point.lon], { pane: 'mountains', radius: 0, opacity: 0, fillOpacity: 0, interactive: false });
    marker.bindTooltip(text('span', point.name), { pane: 'mountains', permanent: true, direction: 'center', className: 'mountain-label', opacity: 1 });
    mountainLayer.addLayer(marker);
    return { place: point, marker };
  });
  function arrangeLabels() {
    const occupied = renderRiverLabels([...renderCities(), ...(placeManager?.labelCandidates() || [])]);
    slots.forEach(slot => {
      const boxes = [];
      slot.labels.forEach(marker => {
        const element = marker.getTooltip().getElement();
        if (!element) return;
        const point = map.latLngToContainerPoint(marker.getLatLng());
        const halfWidth = element.offsetWidth / 2 + 8;
        const halfHeight = element.offsetHeight / 2 + 4;
        const box = [point.x - halfWidth, point.y - halfHeight, point.x + halfWidth, point.y + halfHeight];
        const visible = !boxes.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]);
        element.style.visibility = visible ? 'visible' : 'hidden';
        if (visible) boxes.push(box);
      });
    });
    const size = map.getSize();
    const candidates = map.hasLayer(mountainLayer) ? mountainMarkers : [];
    candidates.forEach(({ place, marker }) => {
      const element = marker.getTooltip().getElement();
      if (!element) return;
      const point = map.latLngToContainerPoint([place.lat, place.lon]);
      const width = element.offsetWidth || place.name.length * 13;
      const height = element.offsetHeight || 18;
      const box = [point.x + 6, point.y - height / 2, point.x + width + 14, point.y + height / 2 + 4];
      const visible = map.getZoom() >= 4.5 && point.x >= 0 && point.x <= size.x && point.y >= 0 && point.y <= size.y && !occupied.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]);
      element.style.visibility = visible ? 'visible' : 'hidden';
      if (visible) occupied.push(box);
    });
    slots.forEach(slot => { slot.labelPane.style.display = map.getZoom() < 4 ? 'none' : ''; });
  }
  map.on('zoomend moveend resize', arrangeLabels);
  let historical = null;
  let tileFailed = false;
  function toggleLayer(id, layer) {
    $(id).addEventListener('change', event => {
      if (!layer) return;
      if (event.target.checked) layer.addTo(map); else map.removeLayer(layer);
      arrangeLabels();
    });
  }
  toggleLayer('layer-cities', cityLayer); toggleLayer('layer-rivers', water); toggleLayer('layer-terrain', terrain); toggleLayer('layer-mountains', mountainLayer);
  $('layer-river-labels').addEventListener('change', () => { arrangeLabels(); if (!$('layer-river-labels').checked) map.closePopup(riverPopup); });
  $('layer-rivers').addEventListener('change', () => {
    $('layer-river-labels').disabled = !$('layer-rivers').checked;
    if (!$('layer-rivers').checked) map.closePopup(riverPopup);
  });
  $('layer-cities').addEventListener('change', () => { if (!$('layer-cities').checked) map.closePopup(placePopup); });
  ['place-type', 'place-year-only'].forEach(id => $(id).addEventListener('change', () => {
    map.closePopup(placePopup); $('place-notice').hidden = true; arrangeLabels();
  }));
  if (!geo.historicalTileUrl) { $('layer-historical').checked = false; $('layer-historical').disabled = true; $('historical-opacity').disabled = true; $('layer-historical').parentElement.title = '公开版不提供未获再发布许可的历史瓦片；请参阅资料来源与发布范围。'; }
  $('layer-historical').addEventListener('change', event => {
    $('historical-opacity').disabled = !event.target.checked;
    if (!event.target.checked) {
      if (historical) map.removeLayer(historical);
      $('tile-status').textContent = '州郡参照已关闭；主地图完全使用本地资料。';
      return;
    }
    if (!geo.historicalTileUrl) {
      event.target.checked = false; $('historical-opacity').disabled = true;
      $('tile-status').textContent = '未提供州郡参照图层地址。'; return;
    }
    tileFailed = false;
    if (!historical) {
      historical = L.tileLayer(geo.historicalTileUrl, { pane: 'historical', opacity: Number($('historical-opacity').value) / 100, minZoom: 3, maxZoom: 10, maxNativeZoom: 8, bounds: [[15, 70], [55, 140]], attribution: '州郡参照固定382年 · 中研院中国历史地图（非商业）' });
      historical.on('tileerror', () => { tileFailed = true; $('tile-status').textContent = '州郡参照部分或全部瓦片加载失败。请检查网络，或关闭后重试；不影响本地历史地图。'; });
      historical.on('load', () => { if (!tileFailed) $('tile-status').textContent = '联网州郡参照已加载 · 固定382年，与所选年份无关。'; });
    }
    $('tile-status').textContent = '正在联网加载固定382年州郡参照…';
    historical.addTo(map);
  });
  $('historical-opacity').addEventListener('input', event => {
    $('opacity-value').textContent = `${event.target.value}%`;
    if (historical) historical.setOpacity(Number(event.target.value) / 100);
  });
  let selectedYear = 382;
  let snapshot = null;
  let selectedPolity = null;
  let activeSlot = -1;
  let fadeTimer = null;
  let fadeFrame = null;
  let playTimer = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function openRegionalPower(reference, center = false) {
    if (!$('layer-politics').checked || territoryEditor?.isDrawing()) return;
    const polity = polities.get(reference.polityId);
    const position = [reference.labelCoordinates[1], reference.labelCoordinates[0]];
    const popup = text('div', '', 'regional-power-popup');
    popup.dataset.regionalPowerId = reference.polityId;
    popup.append(text('h3', polity.name), text('p', `${snapshot.year}年资料断面 · 活动区参考 / 范围未核`, 'reference-note'), text('p', '此标签仅示意区域活动，不代表已核定疆界、领土面积或州郡归属。'), text('p', reference.note));
    const sources = text('div', '', 'source-body'); sourceLinks(sources, reference.sources); popup.append(sources);
    if (center) map.panTo(position, { animate: false });
    regionalPowerPopup.setLatLng(position).setContent(popup).openOn(map);
  }
  function renderRegionalPowers() {
    map.closePopup(regionalPowerPopup);
    regionalPowerLayer.clearLayers();
    regionalPowers = (snapshot.regionalPowers || []).filter(reference => polities.has(reference.polityId) && Array.isArray(reference.labelCoordinates) && reference.labelCoordinates.length === 2 && reference.labelCoordinates.every(Number.isFinite));
    regionalPowers.forEach(reference => {
      const polity = polities.get(reference.polityId);
      const button = text('button', '', 'regional-power-label'); button.type = 'button'; button.dataset.regionalPowerId = reference.polityId;
      button.style.setProperty('--regional-color', polity.color || token('--muted'));
      button.append(text('strong', polity.name), text('span', '活动区参考 / 范围未核'));
      button.setAttribute('aria-label', `${polity.name}，活动区参考，范围未核，查看说明与来源`);
      L.DomEvent.disableClickPropagation(button); L.DomEvent.disableScrollPropagation(button);
      button.addEventListener('click', () => openRegionalPower(reference));
      L.marker([reference.labelCoordinates[1], reference.labelCoordinates[0]], { pane: 'regionalPowers', keyboard: false, icon: L.divIcon({ html: button, className: 'regional-power-host', iconSize: null }) }).addTo(regionalPowerLayer);
    });
    if ($('layer-politics').checked) regionalPowerLayer.addTo(map);
    else map.removeLayer(regionalPowerLayer);
  }
  function style(feature) {
    const id = feature.properties.polityId;
    const color = polities.get(id)?.color || token('--muted');
    const dimmed = selectedPolity && selectedPolity !== id;
    return { color, weight: selectedPolity === id ? 2.6 : 1.4, opacity: dimmed ? .3 : .9, fillColor: color, fillOpacity: dimmed ? .08 : selectedPolity === id ? .48 : .3 };
  }
  function showSlot(slot, opacity) {
    slot.areaPane.style.opacity = opacity; slot.labelPane.style.opacity = opacity;
    slot.areaPane.style.pointerEvents = opacity && $('layer-politics').checked ? 'auto' : 'none';
  }
  function clearSlot(slot) {
    if (slot.group) map.removeLayer(slot.group);
    slot.group = null; slot.shapes = null; slot.labels = []; showSlot(slot, 0);
  }
  function renderPolitics() {
    clearTimeout(fadeTimer); cancelAnimationFrame(fadeFrame);
    const old = activeSlot;
    const next = old === 0 ? 1 : 0;
    clearSlot(slots[next]);
    const slot = slots[next];
    const labels = L.layerGroup();
    const labelled = new Set();
    slot.shapes = L.geoJSON(politicalFeatures, {
      pane: `politics${next}`, renderer: slot.renderer, style,
      onEachFeature(feature, layer) {
        const properties = feature.properties;
        const popup = document.createElement('div');
        popup.append(text('h3', properties.name || polities.get(properties.polityId)?.name), text('p', properties.userEdited ? '用户编辑疆域 · 自定义覆盖，非原始史实、非已考证县界' : `${snapshot.year}年资料断面 · 疆域概略重建，非精确县界`), text('p', properties.note || '按历史形势概略重建，不代表精确行政边界。'));
        const sources = document.createElement('div'); sourceLinks(sources, snapshot.sources); popup.append(sources);
        layer.bindPopup(popup, { autoPan: false });
        layer.on('click', () => { if (!territoryEditor?.isDrawing()) selectPolity(properties.polityId); });
        if (!labelled.has(properties.polityId)) {
          labelled.add(properties.polityId);
          const coordinates = properties.labelCoordinates;
          const labelPosition = Array.isArray(coordinates) && coordinates.length === 2 && coordinates.every(Number.isFinite)
            ? [coordinates[1], coordinates[0]] : layer.getBounds().getCenter();
          const marker = L.circleMarker(labelPosition, { pane: `politicsLabels${next}`, radius: 0, opacity: 0, fillOpacity: 0, interactive: false });
          marker.bindTooltip(text('span', polities.get(properties.polityId)?.name || properties.name), { pane: `politicsLabels${next}`, permanent: true, direction: 'center', className: 'polity-label', opacity: .9 });
          labels.addLayer(marker);
          slot.labels.push(marker);
        }
      }
    });
    slot.group = L.layerGroup([slot.shapes, labels]).addTo(map);
    activeSlot = next;
    if (!$('layer-politics').checked) { showSlot(slot, 0); if (old >= 0) clearSlot(slots[old]); }
    else if (reducedMotion.matches || old < 0) { showSlot(slot, 1); if (old >= 0) clearSlot(slots[old]); }
    else {
      // Only two reusable panes exist. Cancel every pending transition before replacing one.
      slot.areaPane.getBoundingClientRect();
      fadeFrame = requestAnimationFrame(() => { showSlot(slot, 1); showSlot(slots[old], 0); });
      fadeTimer = setTimeout(() => clearSlot(slots[old]), 200);
    }
    arrangeLabels();
  }
  function selectPolity(id) {
    selectedPolity = selectedPolity === id ? null : id;
    slots.forEach(slot => { if (slot.shapes) slot.shapes.setStyle(style); });
    document.querySelectorAll('#legend button[data-polity-id]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.polityId === selectedPolity)));
  }
  function renderLegend() {
    const ids = [...new Set(politicalFeatures.map(feature => feature.properties.polityId))];
    if (!ids.includes(selectedPolity)) selectedPolity = null;
    $('polity-count').textContent = `${ids.length} 个政权${regionalPowers.length ? ` · ${regionalPowers.length} 个活动区参考` : ''}`;
    $('legend').replaceChildren(...ids.map(id => {
      const polity = polities.get(id);
      const button = text('button', '');
      button.type = 'button'; button.dataset.polityId = id; button.setAttribute('aria-pressed', String(id === selectedPolity));
      const swatch = text('span', '', 'swatch'); swatch.style.backgroundColor = polity?.color || token('--muted');
      button.append(swatch, text('span', `${polity?.name || id}${politicalFeatures.some(feature => feature.properties.polityId === id && feature.properties.userEdited) ? ' · 用户编辑' : ''}`)); button.addEventListener('click', () => selectPolity(id));
      return button;
    }));
    regionalPowers.forEach(reference => {
      const polity = polities.get(reference.polityId);
      const button = text('button', '', 'regional-power-legend'); button.type = 'button'; button.dataset.regionalPowerId = reference.polityId;
      button.disabled = !$('layer-politics').checked;
      const swatch = text('span', '', 'swatch regional-power-swatch'); swatch.style.borderColor = polity.color || token('--muted');
      button.append(swatch, text('span', `${polity.name} · 活动区参考 / 范围未核`));
      button.addEventListener('click', () => openRegionalPower(reference, true));
      $('legend').append(button);
    });
  }
  function setYear(year) {
    selectedYear = Math.max(minYear, Math.min(maxYear, Number(year)));
    selectedPlace = openPlace && displayEligible(openPlace) ? openPlace : null;
    $('year-range').value = selectedYear; $('selected-year').textContent = selectedYear;
    const next = snapshots.filter(item => item.year <= selectedYear).at(-1);
    const snapshotChanged = next !== snapshot;
    $('snapshot-year').textContent = `资料断面 · 公元 ${next.year} 年`;
    $('year-note').textContent = selectedYear === next.year ? '当前为已知事件断面，几何仍为概略重建。' : `沿用${next.year}年上个断面，不代表每年精确疆界。`;
    $('previous-event').disabled = !eventYears().some(year => year < selectedYear);
    $('next-event').disabled = !eventYears().some(year => year > selectedYear);
    if (next !== snapshot) {
      snapshot = next;
      $('event-title').textContent = snapshot.title;
      $('event-description').textContent = snapshot.description;
      sourceLinks($('history-sources'), snapshot.sources);
    }
    let nextFeatures;
    try {
      nextFeatures = window.TerritoryEdits ? window.TerritoryEdits.apply(snapshot.features, selectedYear) : snapshot.features;
      $('map-error').hidden = true;
      $('map-error').textContent = '';
    } catch (error) {
      clearTimeout(fadeTimer); cancelAnimationFrame(fadeFrame);
      slots.forEach(clearSlot); activeSlot = -1; politicalFeatures = [];
      regionalPowerLayer.clearLayers(); regionalPowers = [];
      selectedPolity = null; $('legend').replaceChildren(); $('polity-count').textContent = '疆域计算失败';
      stopPlayback(); map.closePopup();
      $('map-error').hidden = false;
      $('map-error').textContent = `${selectedYear}年疆域计算失败：${error.message || String(error)}${window.AtlasUI.text("。已隐藏政治填色，未沿用旧图或回退为原始图。请在“编辑疆域”中撤销有问题的编辑或刷新共享编辑。")}`;
    }
    if (nextFeatures && (nextFeatures !== politicalFeatures || snapshotChanged)) { politicalFeatures = nextFeatures; renderRegionalPowers(); renderLegend(); renderPolitics(); }
    document.querySelectorAll('#event-ticks button').forEach(button => button.setAttribute('aria-current', String(Number(button.dataset.year) === selectedYear)));
    territoryEditor?.yearChanged();
    arrangeLabels();
    if (openPlace) {
      const entry = openPlace;
      placeNotice(entry);
      if (!matchesPlaceFilter(entry)) map.closePopup(placePopup);
      else placePopup.setContent(popupContent(entry));
    }
    if ($('city-search').value.trim()) renderSearch();
  }
  $('layer-politics').addEventListener('change', () => {
    clearTimeout(fadeTimer); cancelAnimationFrame(fadeFrame);
    slots.forEach((slot, index) => { if (index !== activeSlot) clearSlot(slot); else showSlot(slot, $('layer-politics').checked ? 1 : 0); });
    if ($('layer-politics').checked) regionalPowerLayer.addTo(map);
    else { map.removeLayer(regionalPowerLayer); map.closePopup(regionalPowerPopup); }
    document.querySelectorAll('#legend button[data-regional-power-id]').forEach(button => { button.disabled = !$('layer-politics').checked; });
  });
  function stopPlayback() {
    clearTimeout(playTimer); playTimer = null;
    $('play').textContent = '播放'; $('play').setAttribute('aria-pressed', 'false');
  }
  function jump(direction) {
    const candidates = eventYears().filter(year => direction > 0 ? year > selectedYear : year < selectedYear);
    const next = direction > 0 ? candidates[0] : candidates.at(-1);
    if (next !== undefined) setYear(next);
    return Boolean(next);
  }
  function schedulePlayback() {
    playTimer = setTimeout(() => {
      if (!jump(1) || !eventYears().some(year => year > selectedYear)) { stopPlayback(); return; }
      schedulePlayback();
    }, Number($('play-speed').value));
  }
  $('play').addEventListener('click', () => {
    if (playTimer !== null) { stopPlayback(); return; }
    if (!eventYears().some(year => year > selectedYear)) setYear(eventYears()[0]);
    $('play').textContent = '暂停'; $('play').setAttribute('aria-pressed', 'true'); schedulePlayback();
  });
  $('play-speed').addEventListener('change', () => { if (playTimer !== null) { clearTimeout(playTimer); schedulePlayback(); } });
  $('previous-event').addEventListener('click', () => { stopPlayback(); jump(-1); });
  $('next-event').addEventListener('click', () => { stopPlayback(); jump(1); });
  $('year-range').addEventListener('input', event => { stopPlayback(); setYear(event.target.value); });
  function renderEventTicks() {
    $('event-years').replaceChildren(); $('event-ticks').replaceChildren();
    eventYears().forEach(year => {
      const title = [snapshots.find(item => item.year === year)?.title, editState().edits.some(edit => edit.startYear === year) ? '用户编辑生效' : null].filter(Boolean).join(' · ');
      const option = document.createElement('option'); option.value = year; option.label = title; $('event-years').append(option);
      const button = text('button', ''); button.type = 'button'; button.dataset.year = year;
      button.style.left = `${(year - minYear) / Math.max(1, maxYear - minYear) * 100}%`;
      button.title = `${year} · ${title}`; button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () => { stopPlayback(); setYear(year); }); $('event-ticks').append(button);
    });
  }
  renderEventTicks();
  const searchPageSize = 30;
  let searchMatches = [];
  let searchPage = 0;
  const searchEntries = [...cityMarkers, ...riverEntries];
  function renderSearch() {
    const query = $('city-search').value.trim();
    const start = searchPage * searchPageSize;
    $('search-results').replaceChildren(...searchMatches.slice(start, start + searchPageSize).map(entry => {
      const { place } = entry;
      const button = text('button', place.name); button.type = 'button'; button.dataset.placeId = place.id;
      button.dataset.resultType = isWater(entry) ? entry.category : 'place';
      if (isWater(entry)) { button.dataset.riverId = place.id; button.dataset.waterId = place.id; }
      button.append(text('small', entry.custom ? `用户标注 · ${place.temporalNote || '年代未确认，非原始史实'}` : isWater(entry) ? `${waterType(entry)} · 现代对应：${place.modernName || '待核对'} · 古河道与湖岸未复原` : `${place.referenceSite ? '固定历史地点 · 资料年代' : place.kind || '历史城市'} · ${periodText(entry)}${!place.referenceSite && currentParents(entry).length ? ` · ${selectedYear}年原资料父级：${currentParents(entry).map(item => item.name || item['parent id']).join('、')}` : ''}`), text('small', `${place.lat.toFixed(5)}°N，${place.lon.toFixed(5)}°E · ${place.id}`));
      if (!entry.custom && !isWater(entry)) button.append(text('small', displayText(entry)));
      button.addEventListener('click', () => entry.custom ? placeManager.focus(place.id) : isWater(entry) ? focusRiver(entry) : focusPlace(entry));
      return button;
    }));
    $('search-results').scrollTop = 0;
    const riverMatches = searchMatches.filter(entry => entry.category === 'river').length;
    const lakeMatches = searchMatches.filter(entry => entry.category === 'lake').length;
    $('search-status').textContent = !query ? '搜索城市、郡县治所、河流与湖泊，支持古今名及别名；点击结果才移动视野。' : searchMatches.length ? `找到 ${searchMatches.length} 条：地点 ${searchMatches.length - riverMatches - lakeMatches} / 河流 ${riverMatches} / 湖泊 ${lakeMatches}（不受地图筛选限制），显示 ${start + 1}—${Math.min(start + searchPageSize, searchMatches.length)} 条。` : '没有匹配的地名或水名。请缩短关键词，或尝试丸都、黄河、洞庭。';
    $('search-pagination').hidden = searchMatches.length <= searchPageSize;
    $('search-previous').disabled = searchPage === 0;
    $('search-next').disabled = start + searchPageSize >= searchMatches.length;
    $('search-page').textContent = `${searchPage + 1} / ${Math.max(1, Math.ceil(searchMatches.length / searchPageSize))}`;
  }
  $('city-search').addEventListener('input', event => {
    const query = event.target.value.trim().toLocaleLowerCase();
    searchMatches = query ? [...searchEntries, ...(placeManager?.searchEntries() || [])].filter(entry => entry.search.includes(query)) : [];
    searchPage = 0; renderSearch();
  });
  $('search-previous').addEventListener('click', () => { if (searchPage > 0) { searchPage--; renderSearch(); } });
  $('search-next').addEventListener('click', () => { if ((searchPage + 1) * searchPageSize < searchMatches.length) { searchPage++; renderSearch(); } });
  $('toggle-sidebar').addEventListener('click', () => {
    const hidden = document.body.classList.toggle('sidebar-hidden');
    $('toggle-sidebar').setAttribute('aria-expanded', String(!hidden)); $('toggle-sidebar').textContent = hidden ? '展开侧栏' : '收起侧栏';
    map.invalidateSize({ pan: false });
  });
  $('reset-view').addEventListener('click', () => map.fitBounds(initialBounds, { animate: false }));
  $('northeast-view').addEventListener('click', () => map.fitBounds([[37, 116], [43.5, 128]], { animate: false }));
  $('method-note').textContent = history.disclaimer || '暂无可用的本期逐年精确疆界；本图按有来源的事件断面作概略重建，不声称由原图精确数字化。';
  sourceLinks($('geo-sources'), geo.sources);
  const referenceSource = document.createElement('div');
  sourceLinks(referenceSource, [{ title: '中研院中国历史地图 · 固定382年州郡参照', url: 'https://gis.sinica.edu.tw/ccts/' }]);
  $('geo-sources').append(referenceSource);
  map.fitBounds(initialBounds, { animate: false });
  setYear(382);
  placeManager = window.createPlaceManager?.({ map, getYear: () => selectedYear, token, arrangeLabels,
    isDrawing: () => territoryEditor?.isDrawing(), editPlace: place => territoryEditor?.selectPlace(place),
    onPlaces: places => {
      territoryEditor?.setCustomPlaces(places);
      const query = $('city-search').value.trim().toLocaleLowerCase();
      searchMatches = query ? [...searchEntries, ...(placeManager?.searchEntries() || [])].filter(entry => entry.search.includes(query)) : [];
      searchPage = 0; renderSearch();
    }
  });
  territoryEditor = window.createTerritoryEditor?.({ map, places: geo.places, polities: history.polities, getYear: () => selectedYear, stopPlayback, token, refresh: () => { renderEventTicks(); setYear(selectedYear); } });
  let characterManager = null;
  try { characterManager = window.createCharacterManager?.({ map, polities: history.polities, getYear: () => selectedYear, isTerritoryDrawing: () => !!territoryEditor?.isDrawing() }); }
  catch (error) { $('character-summary').textContent = `人物模块初始化失败：${error.message}；基础地图仍可浏览。`; $('character-summary').setAttribute('role', 'alert'); $('character-toggle').disabled = true; }
  requestAnimationFrame(arrangeLabels);
  // Read-only inspection surface for verifying view stability and bounded transition layers.
  window.ATLAS = { map, getState: () => ({ selectedYear, snapshotYear: snapshot.year, selectedPolity, politicalLayerCount: slots.filter(slot => slot.group).length, cityCount: cityMarkers.length, totalPlaceCount: geo.places.length, visiblePlaceCount, visiblePlaceIds: [...visiblePlaceIds], visibleCityLabelIds: [...visibleCityLabelIds], visibleCityPointCount: visibleCities.size, cityLabelCount, riverCount: riverEntries.filter(entry => entry.category === 'river').length, lakeCount: riverEntries.filter(entry => entry.category === 'lake').length, waterCount: riverEntries.length, riverLabelCount: [...visibleRiverLabels.keys()].filter(entry => entry.category === 'river').length, lakeLabelCount: [...visibleRiverLabels.keys()].filter(entry => entry.category === 'lake').length, visibleWaterIds: [...visibleRiverLabels.keys()].map(entry => entry.place.id), riverLabelsEnabled: $('layer-river-labels').checked, selectedRiverId, selectedWaterId: selectedRiverId, placeType: $('place-type').value, placeYearOnly: $('place-year-only').checked, selectedPlaceId: openPlace?.place.id || null, searchResultCount: searchMatches.length, searchPage, playing: playTimer !== null, territory: territoryEditor?.getState() || null, eventYears: eventYears(), politicalFeatureCount: politicalFeatures.length, userEditedPolityIds: [...new Set(politicalFeatures.filter(feature => feature.properties.userEdited).map(feature => feature.properties.polityId))] }) };
  const atlasState = window.ATLAS.getState;
  window.ATLAS.getState = () => ({ ...atlasState(), regionalPowerIds: regionalPowers.map(reference => reference.polityId), displayedRegionalPowerIds: map.hasLayer(regionalPowerLayer) ? regionalPowers.filter(reference => map.getBounds().contains([reference.labelCoordinates[1], reference.labelCoordinates[0]])).map(reference => reference.polityId) : [], annotations: placeManager?.getState() || null, characters: characterManager?.getState() || null });
  const periodAtlasState = window.ATLAS.getState;
  window.ATLAS.getState = () => ({ ...periodAtlasState(), placePeriods: window.PlacePeriods?.getState() || null, siteLabelChoices: [...siteLabelChoices].map(([key, entry]) => ({ key, placeId: entry.place.id })), visibleSiteRepresentatives: [...visibleCities].map(([key, item]) => ({ key, placeId: item.entry.place.id })) });
  window.ATLAS.getPlaceDisplayInfo = id => { const entry = cityMarkers.find(item => item.place.id === id); return entry ? { placeId: id, sourceBegin: entry.begin, sourceEnd: entry.end, sourceCurrent: isCurrent(entry), override: displayPeriod(entry), displayEligible: displayEligible(entry), temporarySelection: entry === selectedPlace } : null; };
  window.PlacePeriods?.init(() => {
    selectedPlace = null;
    if (openPlace) { placePopup.setContent(popupContent(openPlace)); placeNotice(openPlace); }
    arrangeLabels(); renderSearch();
  });
})();
