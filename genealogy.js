(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const staticFamilies = window.GENEALOGY_DATA?.families || [];
  let families = [...staticFamilies];
  const sharedAvailable = ['http:', 'https:'].includes(location.protocol);
  let sharedLoading = sharedAvailable;
  let sharedFailed = false;
  const status = $('genealogy-status');
  const viewport = $('tree-viewport');
  const stage = $('tree-stage');
  const extent = $('tree-extent');
  const svg = $('tree-connectors');
  const nodes = new Map();
  const positions = new Map();
  let family, people, sources, edges, parents, children;
  let selectedId = null;
  let scale = 1;
  let width = 0;
  let height = 0;
  let geometry;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const setStatus = message => { status.textContent = message; };
  const safeSourceUrl = value => {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  function sourceList(ids) {
    const list = element('ul', undefined, 'source-list');
    for (const id of new Set(ids || [])) {
      const source = sources.get(id);
      const item = element('li');
      const href = source && safeSourceUrl(source.url);
      if (href) {
        const link = element('a', source.title);
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        item.append(link);
      } else {
        item.textContent = source ? `${source.title}（暂无可打开的来源链接）` : `来源 ${id} 暂未收录`;
      }
      list.append(item);
    }
    if (!list.childElementCount) list.append(element('li', '本条暂无单独列出的来源。'));
    return list;
  }
  function pageUrl(personId) {
    const url = new URL(location.href);
    url.searchParams.set('family', family.id);
    if (personId) url.searchParams.set('person', personId);
    else url.searchParams.delete('person');
    url.hash = '';
    return url;
  }
  function updateUrl(personId) {
    const url = pageUrl(personId);
    if (url.href === location.href) return;
    try { history.pushState(null, '', url); }
    catch { setStatus('浏览器限制了地址栏更新；仍可正常阅读，并使用人物资料中的固定链接。'); }
  }
  function centerPerson(id, focus = false) {
    const position = positions.get(id);
    if (!position) return;
    viewport.scrollLeft = Math.max(0, (position.x + geometry.cardWidth / 2) * scale - viewport.clientWidth / 2);
    viewport.scrollTop = Math.max(0, (position.y + geometry.cardHeight / 2) * scale - viewport.clientHeight / 2);
    if (focus) nodes.get(id)?.focus({ preventScroll: true });
  }
  function setScale(value, centerId = selectedId) {
    const oldScale = scale;
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / oldScale;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / oldScale;
    scale = Math.min(2, Math.max(0.1, value));
    stage.style.transform = `scale(${scale})`;
    extent.style.width = `${Math.ceil(width * scale)}px`;
    extent.style.height = `${Math.ceil(height * scale)}px`;
    $('zoom-level').textContent = `${Math.round(scale * 100)}%`;
    $('zoom-out').disabled = scale <= 0.1;
    $('zoom-in').disabled = scale >= 2;
    if (centerId) centerPerson(centerId);
    else {
      viewport.scrollLeft = Math.max(0, centerX * scale - viewport.clientWidth / 2);
      viewport.scrollTop = Math.max(0, centerY * scale - viewport.clientHeight / 2);
    }
  }
  function fit() {
    setScale(Math.min(1, (viewport.clientWidth - geometry.padding) / width, (viewport.clientHeight - geometry.padding) / height), null);
    viewport.scrollTo(0, 0);
  }
  function renderRelations(title, relationships, direction, host) {
    host.append(element('h3', title));
    if (!relationships.length) {
      host.append(element('p', '本次选录未收录；不表示不存在。', 'hint'));
      return;
    }
    const list = element('ul', undefined, 'relation-list');
    for (const edge of relationships) {
      const person = people.get(direction === 'parents' ? edge.parentId : edge.childId);
      const item = element('li');
      const button = element('button', person.name);
      button.type = 'button';
      button.addEventListener('click', () => selectPerson(person.id, true, true));
      item.append(button);
      item.append(element('p', `${people.get(edge.parentId).name} → ${people.get(edge.childId).name} · 亲子关系`));
      if (edge.note) item.append(element('p', edge.note));
      item.append(sourceList(edge.sourceIds));
      list.append(item);
    }
    host.append(list);
  }
  function renderDetail() {
    const host = $('person-detail-content');
    host.replaceChildren();
    if (!selectedId) {
      $('person-detail-title').textContent = '选择一位人物';
      host.append(element('p', '点击图中姓名，查看身份、直接亲属与文献出处。'));
      return;
    }
    const person = people.get(selectedId);
    $('person-detail-title').textContent = person.name;
    host.append(element('p', person.identity || '资料未列出身份说明。', 'person-identity'));
    if (person.polity) host.append(element('p', `相关政权：${person.polity}`));
    if (person.aliases?.length) host.append(element('p', `别名：${person.aliases.join('、')}`));
    if (person.note) host.append(element('p', person.note, 'person-note'));
    const permalink = element('a', '此人物固定链接', 'detail-link');
    permalink.href = pageUrl(person.id).href;
    host.append(permalink, element('h3', '人物来源'), sourceList(person.sourceIds));
    renderRelations('直接父母', parents.get(person.id), 'parents', host);
    renderRelations('直接子女', children.get(person.id), 'children', host);
  }
  function selectPerson(id, changeUrl = true, focus = false) {
    selectedId = people.has(id) ? id : null;
    const related = new Set();
    if (selectedId) {
      for (const edge of [...parents.get(selectedId), ...children.get(selectedId)]) {
        related.add(edge.parentId);
        related.add(edge.childId);
      }
    }
    for (const [personId, node] of nodes) {
      node.setAttribute('aria-pressed', String(personId === selectedId));
      node.classList.toggle('is-related', personId !== selectedId && related.has(personId));
    }
    for (const path of svg.children) {
      path.classList.toggle('is-related', !!selectedId && (path.dataset.parentId === selectedId || path.dataset.childId === selectedId));
    }
    renderDetail();
    if (changeUrl) updateUrl(selectedId);
    if (selectedId) {
      setStatus(`已选择 ${people.get(selectedId).name}；人物资料及关系出处见“人物与依据”。`);
      // Keep deep-linked cards legible even after a whole-family overview.
      if (scale < 0.75) setScale(1);
      requestAnimationFrame(() => centerPerson(selectedId, focus));
    }
  }
  function renderTree() {
    nodes.clear();
    positions.clear();
    $('tree-people').replaceChildren();
    $('tree-generations').replaceChildren();
    svg.replaceChildren();
    const style = getComputedStyle(document.body);
    const token = name => parseFloat(style.getPropertyValue(`--genealogy-${name}`));
    geometry = { cardWidth: token('card-width'), cardHeight: token('card-height'), columnGap: token('column-gap'), rowGap: token('row-gap'), gutter: token('gutter'), padding: token('padding') };
    const levels = new Map();
    const remaining = new Map([...people.keys()].map(id => [id, parents.get(id).length]));
    const queue = [...people.keys()].filter(id => remaining.get(id) === 0);
    queue.forEach(id => levels.set(id, 0));
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      for (const edge of children.get(id)) {
        levels.set(edge.childId, Math.max(levels.get(edge.childId) || 0, levels.get(id) + 1));
        remaining.set(edge.childId, remaining.get(edge.childId) - 1);
        if (!remaining.get(edge.childId)) queue.push(edge.childId);
      }
    }
    if (queue.length !== people.size) throw new Error('谱系关系包含循环，无法可靠排列；请核对本地谱系资料。');
    const primaryChildren = new Map([...people.keys()].map(id => [id, []]));
    for (const id of people.keys()) {
      const firstParent = parents.get(id)[0];
      if (firstParent) primaryChildren.get(firstParent.parentId).push(id);
    }
    let leaf = 0;
    function place(id) {
      const descendants = primaryChildren.get(id);
      let column;
      if (!descendants.length) column = leaf++;
      else {
        const columns = descendants.map(place);
        column = (columns[0] + columns[columns.length - 1]) / 2;
      }
      positions.set(id, {
        x: geometry.gutter + geometry.padding + column * (geometry.cardWidth + geometry.columnGap),
        y: geometry.padding + levels.get(id) * (geometry.cardHeight + geometry.rowGap)
      });
      return column;
    }
    for (const id of queue) if (!parents.get(id).length) place(id);
    const generations = Math.max(0, ...levels.values()) + 1;
    width = geometry.gutter + geometry.padding * 2 + Math.max(1, leaf) * (geometry.cardWidth + geometry.columnGap) - geometry.columnGap;
    // Multiple parents can move a node below its primary branch's usual row.
    // Keep imported DAGs legible without changing the curated tree layout.
    if (!staticFamilies.some(item => item.id === family.id)) {
      const rows = new Map();
      for (const position of positions.values()) {
        if (!rows.has(position.y)) rows.set(position.y, []);
        rows.get(position.y).push(position);
      }
      for (const row of rows.values()) {
        row.sort((a, b) => a.x - b.x);
        let nextX = geometry.gutter + geometry.padding;
        for (const position of row) {
          position.x = Math.max(position.x, nextX);
          nextX = position.x + geometry.cardWidth + geometry.columnGap;
          width = Math.max(width, position.x + geometry.cardWidth + geometry.padding);
        }
      }
    }
    height = geometry.padding * 2 + generations * (geometry.cardHeight + geometry.rowGap) - geometry.rowGap;
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    for (let level = 0; level < generations; level++) {
      const label = element('div', `第 ${level + 1} 层`, 'generation-label');
      label.style.top = `${geometry.padding + level * (geometry.cardHeight + geometry.rowGap)}px`;
      $('tree-generations').append(label);
    }
    for (const edge of edges) {
      const parent = positions.get(edge.parentId), child = positions.get(edge.childId);
      const x1 = parent.x + geometry.cardWidth / 2, y1 = parent.y + geometry.cardHeight;
      const x2 = child.x + geometry.cardWidth / 2, y2 = child.y;
      const elbow = y1 + geometry.rowGap / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} V ${elbow} H ${x2} V ${y2}`);
      path.setAttribute('class', 'genealogy-edge');
      path.dataset.parentId = edge.parentId;
      path.dataset.childId = edge.childId;
      svg.append(path);
    }
    // DOM order follows generations, so keyboard reading matches the visual hierarchy.
    for (const id of queue) {
      const person = people.get(id), position = positions.get(id);
      const button = element('button', undefined, 'person-node');
      button.type = 'button';
      button.dataset.personId = id;
      button.style.left = `${position.x}px`;
      button.style.top = `${position.y}px`;
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-controls', 'person-detail');
      button.setAttribute('aria-label', [person.name, person.identity, person.polity, '查看人物与亲子关系'].filter(Boolean).join('，'));
      button.append(element('strong', person.name));
      if (person.polity) button.append(element('span', person.polity));
      if (person.identity) button.append(element('span', person.identity));
      button.addEventListener('click', () => selectPerson(id));
      button.addEventListener('focus', () => centerPerson(id));
      nodes.set(id, button);
      $('tree-people').append(button);
    }
    $('tree-count').textContent = `${people.size} 位人物 · ${edges.length} 条亲子关系 · ${people.size ? generations : 0} 层`;
    setScale(1, null);
    viewport.scrollTo(0, 0);
  }
  function loadFamily(next) {
    family = next;
    selectedId = null;
    people = new Map(family.people.map(person => [person.id, person]));
    sources = new Map(family.sources.map(source => [source.id, source]));
    edges = family.relationships.filter(edge => edge.type === 'parent-child' && people.has(edge.parentId) && people.has(edge.childId));
    parents = new Map([...people.keys()].map(id => [id, []]));
    children = new Map([...people.keys()].map(id => [id, []]));
    edges.forEach(edge => { parents.get(edge.childId).push(edge); children.get(edge.parentId).push(edge); });
    $('family-select').value = family.id;
    $('family-title').textContent = family.name;
    $('family-description').textContent = family.description || '';
    $('family-scope').textContent = family.scopeNote || '';
    const generated = !staticFamilies.some(item => item.id === family.id);
    $('family-kind').textContent = generated ? window.AtlasUI.text('人物关系 / 共享导入 · 待核实') : '人物关系 / 本地核心选录';
    $('family-provenance').hidden = !generated;
    const generatedDate = family.generatedAt ? new Date(family.generatedAt) : null;
    $('family-generated-at').textContent = generatedDate && !Number.isNaN(generatedDate.getTime())
      ? `生成时间：${generatedDate.toLocaleString('zh-CN')}` : '生成时间：未提供有效日期';
    $('family-warnings').replaceChildren(...(family.warnings || []).map(warning => element('li', warning)));
    $('family-source-note').textContent = generated
      ? '以下为导入时记录的检索来源，并非人工核实结论。打开来源需联网，请逐条核对原文及同名人物身份。'
      : '本地选录资料随地图提供；打开文献链接需要联网。关系说明中的保留意见以资料原文为准。';
    setFamilyControls(true);
    document.title = `${family.name} · 家族谱系 · 东晋十六国`;
    $('person-search').value = '';
    $('search-panel').hidden = true;
    $('genealogy-workspace').hidden = false;
    $('family-sources').hidden = false;
    $('family-source-list').replaceChildren(...sourceList(family.sources.map(source => source.id)).children);
    renderTree();
    renderDetail();
    setStatus(people.size ? '本图仅展示资料中明确收录的亲子关系。请选择人物阅读依据。' : '此家族暂未收录人物。请切换家族，或稍后补充资料后再查看。');
  }
  function readLocation() {
    const query = new URL(location.href).searchParams;
    const familyId = query.get('family');
    const personId = query.get('person');
    const next = familyId ? families.find(item => item.id === familyId) : families[0];
    if (!next) {
      family = null;
      selectedId = null;
      $('family-select').value = '';
      $('family-title').textContent = sharedLoading ? '正在读取链接中的家族…' : '未能找到链接中的家族';
      $('family-description').textContent = familyId ? `链接指定家族：${familyId}` : '暂无可显示的家族。';
      $('family-scope').textContent = '';
      $('family-kind').textContent = '人物关系 / 链接待解析';
      for (const id of ['genealogy-workspace', 'family-sources', 'family-provenance', 'search-panel']) $(id).hidden = true;
      document.title = '家族谱系 · 东晋十六国';
      setFamilyControls(false);
      setStatus(sharedLoading ? window.AtlasUI.text('正在加载共享家族，加载完成后再解析此链接。也可选择本地家族阅读。')
        : sharedFailed || !sharedAvailable ? window.AtlasUI.text('共享资料暂不可用，无法确认此链接的家族。未改为显示其他家族；可刷新共享家族，或手动选择本地家族阅读。')
          : window.AtlasUI.text('共享列表中没有此家族；原链接已保留，未改为显示其他家族。可刷新列表或手动选择其他家族。'));
      return;
    }
    const unchanged = family === next;
    if (!unchanged) loadFamily(next);
    if (personId && !people.has(personId)) {
      selectPerson(null, false);
      setStatus(`本族未收录人物“${personId}”，已显示全族。可使用姓名搜索重新选择。`);
    } else if (personId) selectPerson(personId, false, !unchanged);
    else if (!unchanged && next.rootPersonId && people.has(next.rootPersonId)) selectPerson(next.rootPersonId, false);
    else if (unchanged && selectedId !== next.rootPersonId) selectPerson(null, false);
  }
  function setFamilyControls(enabled) {
    for (const control of $('person-search-form').querySelectorAll('button, input')) control.disabled = !enabled;
    $('show-family').disabled = !enabled;
  }
  function renderFamilyOptions() {
    const placeholder = element('option', '请选择家族');
    placeholder.value = '';
    placeholder.disabled = true;
    $('family-select').replaceChildren(placeholder, ...families.map(item => {
      const option = element('option', `${item.name}${staticFamilies.some(local => local.id === item.id) ? ' · 本地选录' : ' · 导入待核实'}`);
      option.value = item.id;
      return option;
    }));
    $('family-select').disabled = !families.length;
    $('family-select').value = family?.id || '';
  }
  async function refreshFamilies() {
    sharedLoading = true;
    sharedFailed = false;
    $('refresh-families').disabled = true;
    $('refresh-families').textContent = '正在刷新…';
    $('shared-status').textContent = window.AtlasUI.text('正在读取共享家族列表；本地选录资料仍可阅读。');
    try {
      if (!window.GENEALOGY_CLIENT) throw new Error(window.AtlasUI.text('共享资料客户端未加载'));
      const saved = await window.GENEALOGY_CLIENT.load();
      if (!Array.isArray(saved?.families)) throw new Error(window.AtlasUI.text('共享家族列表格式不正确'));
      const localIds = new Set(staticFamilies.map(item => item.id));
      families = [...staticFamilies, ...saved.families.filter(item => !localIds.has(item.id))];
      $('shared-status').textContent = `${window.AtlasUI.text("共享列表已更新：")}${saved.families.length} 个已保存的导入家族。导入资料尚未经人工核实。`;
    } catch (error) {
      sharedFailed = true;
      $('shared-status').textContent = `${window.AtlasUI.text("共享列表加载失败：")}${error.message}${window.AtlasUI.text("。保留本地资料及此前已读取的列表；可点击“刷新共享家族”重试。")}`;
    } finally {
      sharedLoading = false;
      $('refresh-families').disabled = false;
      $('refresh-families').textContent = window.AtlasUI.text('刷新共享家族');
    }
    renderFamilyOptions();
    try { readLocation(); }
    catch (error) {
      $('genealogy-workspace').hidden = true;
      setFamilyControls(false);
      setStatus(`此家族无法显示：${error.message}。可选择其他家族阅读，不会修改保存的资料。`);
    }
  }
  function search() {
    const term = $('person-search').value.trim().toLocaleLowerCase();
    const list = $('person-search-results');
    list.replaceChildren();
    $('search-panel').hidden = !term;
    if (!term) return [];
    const matches = [...people.values()].filter(person => [person.name, ...(person.aliases || [])].some(name => name.toLocaleLowerCase().includes(term)));
    $('search-status').textContent = matches.length ? `找到 ${matches.length} 位人物；选择姓名定位。搜索不会隐藏其他分支。` : '未找到匹配姓名。请尝试其他写法或别名；本页仅收录部分核心人物。';
    for (const person of matches) {
      const item = element('li');
      const button = element('button', person.name);
      button.type = 'button';
      button.append(element('small', person.identity || person.polity || '查看资料'));
      button.addEventListener('click', () => selectPerson(person.id, true, true));
      item.append(button);
      list.append(item);
    }
    return matches;
  }
  if (!Array.isArray(families) || !families.length) {
    $('family-title').textContent = '谱系资料暂不可用';
    setStatus('未能读取本地 genealogy-data.js，或尚未收录家族。请检查该文件与本页是否放在同一目录，然后刷新重试。地图与用户人物记录不受影响。');
    return;
  }
  try {
    renderFamilyOptions();
    readLocation();
    if (sharedAvailable) refreshFamilies();
    else $('shared-status').textContent = window.AtlasUI.text('当前以 file:// 打开：共享家族不可用，仅显示随地图提供的本地选录。请通过本地 HTTP 服务打开以读取已保存的导入家族。');
    $('refresh-families').addEventListener('click', refreshFamilies);
    const detailLink = element('a', '查看人物资料 ↓');
    detailLink.href = '#person-detail';
    detailLink.addEventListener('click', () => $('person-detail').focus());
    document.querySelector('.tree-actions').append(detailLink);
    $('family-select').addEventListener('change', () => {
      loadFamily(families.find(item => item.id === $('family-select').value));
      updateUrl(null);
      if (family.rootPersonId && people.has(family.rootPersonId)) selectPerson(family.rootPersonId);
    });
    $('person-search').addEventListener('input', search);
    $('person-search-form').addEventListener('submit', event => {
      event.preventDefault();
      const matches = search();
      if (matches.length === 1) selectPerson(matches[0].id, true, true);
      else $('person-search-results').querySelector('button')?.focus();
    });
    $('show-family').addEventListener('click', () => {
      $('person-search').value = '';
      search();
      selectPerson(null);
      fit();
      setStatus('已显示全族概览。可放大或搜索姓名查看人物；所有分支均可滚动到达。');
    });
    $('zoom-in').addEventListener('click', () => setScale(scale * 1.25));
    $('zoom-out').addEventListener('click', () => setScale(scale / 1.25));
    $('zoom-reset').addEventListener('click', () => setScale(1));
    $('zoom-fit').addEventListener('click', fit);
    window.addEventListener('popstate', readLocation);
  } catch (error) {
    $('genealogy-workspace').hidden = true;
    $('family-title').textContent = '谱系资料无法显示';
    setStatus(`本地谱系资料读取失败：${error.message} 不会修改地图或任何人物记录。`);
  }
})();
