(() => {
  'use strict';
  window.createPlaceManager = ({ map, getYear, token, arrangeLabels, onPlaces, editPlace, isDrawing }) => {
    const $ = id => document.getElementById(id), http = /^https?:$/.test(location.protocol);
    const kinds = { city: '城邑', county: '郡县', lake: '湖泊', river: '河流' }, symbols = { city: '◆', county: '■', lake: '○', river: '≈' }, colors = { city: '--city', county: '--county', lake: '--river-ink', river: '--river' };
    const node = (tag, value, cls) => { const el = document.createElement(tag); el.textContent = value; if (cls) el.className = cls; return el; };
    const button = (label, action) => { const el = node('button', label); el.type = 'button'; el.addEventListener('click', action); return el; };
    map.createPane('annotations').style.zIndex = 475;
    const labelPane = map.createPane('annotationLabels'); labelPane.style.zIndex = 476; labelPane.style.pointerEvents = 'none';
    const layer = L.layerGroup().addTo(map), labels = L.layerGroup().addTo(map), preview = L.layerGroup().addTo(map), popup = L.popup({ maxWidth: 340, maxHeight: 360, autoPan: false });
    let annotations = [], revision = 0, loaded = false, writable = false, loading = null, busy = false;
    let candidates = [], selected = null, selectedId = null, searching = false, sequence = 0, controller = null;
    function message(value, error = false) { $('annotation-status').textContent = value; $('annotation-status').classList.toggle('territory-error', error); }
    function details(place) {
      const address = typeof place.address === 'string' ? place.address : Object.values(place.address || {}).filter(Boolean).join(' · ');
      const el = node('div', '', 'annotation-details');
      el.append(node('p', `匹配名称：${place.matchedName || place.name} · ${kinds[place.kind]}\n地址：${address || '来源未提供行政地址'}\n${place.lat.toFixed(5)}°N，${place.lon.toFixed(5)}°E\n来源：${place.provider} · ${place.providerId || ''}\n${place.temporalNote || '年代未确认，不证明古代治所'}${place.period ? ` · 记录年代 ${place.period.begin}—${place.period.end}` : ''}\n坐标精度：${place.coordinatePrecision || '来源未说明'} · ${place.license || '许可未说明'}${['lake', 'river'].includes(place.kind) ? '\n仅为定位点，不表示河道或湖面范围。' : ''}`));
      if (/^https?:\/\//i.test(place.sourceUrl || '')) { const a = node('a', '查看原始来源 ↗'); a.href = place.sourceUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; el.append(a); }
      return el;
    }
    function controls() {
      $('annotation-summary').textContent = `用户标注 · ${annotations.length} 条${loaded ? '' : window.AtlasUI.text(' · 未读取共享状态')}${!http ? ' · 文件浏览模式' : ''}`;
      $('annotation-search-fields').disabled = !http || busy; $('annotation-save-fields').disabled = !writable || busy;
      $('annotation-refresh').disabled = !http || busy || Boolean(loading); $('annotation-close').disabled = busy;
      $('annotation-search').textContent = searching ? '重新搜索（替换本次请求）' : '搜索候选';
    }
    function cancelPreview() { selected = null; preview.clearLayers(); $('annotation-save-form').hidden = true; document.querySelectorAll('[data-candidate-id]').forEach(el => el.setAttribute('aria-pressed', 'false')); }
    function setOpen(open) {
      if (busy) return;
      $('annotation-panel').hidden = !open; $('annotation-toggle').setAttribute('aria-expanded', String(open));
      if (open) { document.body.classList.remove('sidebar-hidden'); $('toggle-sidebar').setAttribute('aria-expanded', 'true'); $('toggle-sidebar').textContent = '收起侧栏'; map.invalidateSize({ pan: false }); $('annotation-query').focus(); }
      else { sequence++; controller?.abort(); searching = false; cancelPreview(); controls(); }
    }
    function choose(place) {
      if (busy) return;
      cancelPreview(); selected = place; $('annotation-save-form').hidden = false; $('annotation-name').value = place.name; $('annotation-note').value = '';
      $('annotation-selection').textContent = `待确认：${place.name}。仅为预览，尚未保存。请核对地图与来源。`;
      document.querySelectorAll('[data-candidate-id]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.candidateId === place.candidateId)));
      L.circleMarker([place.lat, place.lon], { pane: 'annotations', radius: 10, color: token('--accent'), fillColor: token('--surface'), fillOpacity: .5, dashArray: '4 4', interactive: false }).addTo(preview);
      map.setView([place.lat, place.lon], Math.max(map.getZoom(), 8), { animate: false }); controls();
    }
    function renderCandidates() { $('annotation-candidates').replaceChildren(...candidates.map(place => {
      const item = node('div', '', 'annotation-candidate'), select = button(`预览 ${place.name}`, () => choose(place)); select.dataset.candidateId = place.candidateId; select.setAttribute('aria-pressed', 'false'); item.append(select, details(place)); return item;
    })); }
    async function request(url, options = {}) {
      const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 25000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
      try { const response = await window.AtlasAPI.fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options, signal });
        let payload; try { payload = await response.json(); } catch (_) { throw new Error(window.AtlasUI.text('服务器未提供有效地点接口，请使用局域网入口。')); }
        return { response, payload };
      } finally { clearTimeout(timer); }
    }
    async function search(event) {
      event.preventDefault(); if (!http || busy || !$('annotation-search-form').reportValidity()) return;
      const current = ++sequence; controller?.abort(); controller = new AbortController(); cancelPreview(); candidates = []; renderCandidates();
      searching = true; $('annotation-warnings').replaceChildren(); message('正在检索真实来源…可修改条件后重新搜索。'); controls();
      const query = new URLSearchParams({ q: $('annotation-query').value.trim(), kind: $('annotation-kind').value, scope: $('annotation-scope').value, year: getYear() });
      try { const { response, payload } = await request(`/api/place-search?${query}`, { signal: controller.signal });
        if (current !== sequence) return;
        if (!response.ok) throw new Error(payload.error || '检索失败，请重试。');
        if (!Array.isArray(payload.candidates)) throw new Error('候选响应格式错误，请重试。');
        candidates = payload.candidates; renderCandidates(); $('annotation-warnings').replaceChildren(...(payload.warnings || []).map(warning => node('li', warning)));
        message(candidates.length ? `找到 ${candidates.length} 个候选。请自行选择并核对；尚未选中任何位置。` : '未找到匹配候选。请尝试别名、其他类别或来源范围后重新搜索。');
      } catch (error) { if (current === sequence) message(error.name === 'AbortError' ? '检索超时，请点击搜索重试。' : error.message, true); }
      finally { if (current === sequence) { searching = false; controls(); } }
    }
    function labelCandidates() {
      labels.clearLayers(); if (!map.hasLayer(layer)) return [];
      return annotations.filter(place => map.getBounds().contains([place.lat, place.lon]) && (place.id === selectedId || map.getZoom() >= (place.kind === 'county' ? 7 : 5))).map(place => ({ entry: { place }, label: place.name, rank: place.id === selectedId ? -3 : 2, city: true,
        show(offset, width, height) { const span = node('span', place.name); span.dataset.annotationLabel = place.id;
          L.marker(map.containerPointToLatLng(map.latLngToContainerPoint([place.lat, place.lon]).add(offset)), { pane: 'annotationLabels', interactive: false, keyboard: false, icon: L.divIcon({ html: span, className: 'city-label-host annotation-label', iconSize: [width, height], iconAnchor: [width / 2, height / 2] }) }).addTo(labels);
        }
      }));
    }
    function focus(id) {
      const place = annotations.find(item => item.id === id); if (!place || isDrawing()) return;
      $('layer-annotations').checked = true; layer.addTo(map); selectedId = id; map.setView([place.lat, place.lon], Math.max(map.getZoom(), 8), { animate: false });
      const content = node('div', '', 'place-popup'); content.dataset.annotationId = id;
      content.append(node('h3', place.name), node('p', '用户添加地点 · 非原始史实', 'reference-note'), details(place)); if (place.note) content.append(node('p', place.note));
      if (['city', 'county'].includes(place.kind)) { const edit = button('编辑此地归属', () => editPlace(place)); edit.dataset.editPlace = id; edit.disabled = !window.TerritoryEdits?.getState().writable; content.append(edit); }
      const remove = button('删除此标注', () => removePlace(place)); remove.disabled = !writable || busy; remove.dataset.removeAnnotation = id; content.append(remove);
      popup.setLatLng([place.lat, place.lon]).setContent(content).openOn(map); selectedId = id; arrangeLabels();
      if (!attributed && /Photon|OpenStreetMap/i.test(place.provider)) { map.attributionControl.addAttribution(attribution); attributed = true; }
    }
    const attribution = '用户标注现代检索：© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';
    let attributed = false;
    function renderSaved() {
      layer.clearLayers();
      const showAttribution = annotations.some(place => /Photon|OpenStreetMap/i.test(place.provider)) && map.hasLayer(layer);
      if (showAttribution !== attributed) { map.attributionControl[showAttribution ? 'addAttribution' : 'removeAttribution'](attribution); attributed = showAttribution; }
      annotations.forEach(place => {
        const icon = node('span', symbols[place.kind], `annotation-symbol annotation-${place.kind}`); icon.style.color = token(colors[place.kind]);
        const size = parseFloat(token('--s6')), anchor = size / 2;
        const marker = L.marker([place.lat, place.lon], { pane: 'annotations', title: `${place.name} · 用户标注 · ${kinds[place.kind]}`, icon: L.divIcon({ html: icon, className: 'annotation-marker', iconSize: [size, size], iconAnchor: [anchor, anchor] }) }); marker.on('click', () => focus(place.id)); marker.addTo(layer);
      });
      $('annotation-records').replaceChildren(...annotations.map(place => { const li = node('li', ''); li.dataset.annotationId = place.id;
        const locate = button(`${place.name} · ${kinds[place.kind]} · 定位`, () => focus(place.id)); locate.dataset.locateAnnotation = place.id;
        const remove = button('删除', () => removePlace(place)); remove.dataset.removeAnnotation = place.id; remove.disabled = !writable || busy;
        li.append(locate, node('p', place.temporalNote || '年代未确认', 'hint'), remove); return li;
      }));
      if (!annotations.length) $('annotation-records').append(node('li', loaded ? '尚无用户标注。搜索候选并确认位置后保存。' : window.AtlasUI.text('尚未读取共享标注；已有记录不会被清空，请刷新重试。')));
      arrangeLabels(); controls();
    }
    function accept(payload) {
      if (!Number.isSafeInteger(payload.revision) || !Array.isArray(payload.annotations) || payload.annotations.some(place => !place.id?.startsWith('user-') || !kinds[place.kind] || !Number.isFinite(place.lon) || !Number.isFinite(place.lat))) throw new Error(window.AtlasUI.text('共享标注数据格式错误，未覆盖当前记录。'));
      if (payload.revision < revision) return;
      annotations = payload.annotations; revision = payload.revision; loaded = writable = true; window.TerritoryEdits?.setCustomPlaces(annotations); onPlaces(annotations);
      if (selectedId && !annotations.some(place => place.id === selectedId)) { selectedId = null; map.closePopup(popup); } renderSaved();
    }
    function load() {
      if (!http) return Promise.reject(new Error(window.AtlasUI.text('文件模式无法读取共享标注，请使用局域网入口。'))); if (loading) return loading;
      loading = (async () => { try { const { response, payload } = await request('/api/map-annotations'); if (!response.ok) throw new Error(payload.error || window.AtlasUI.text('共享标注读取失败')); accept(payload); }
        catch (error) { loaded = writable = false; message(`标注读取失败：${error.name === 'AbortError' ? '请求超时' : error.message}。保留已显示数据；请刷新重试，疆域编辑暂不可用。`, true); renderSaved(); throw error; }
        finally { loading = null; controls(); }
      })(); controls(); return loading;
    }
    async function commit(operation) {
      if (!writable || busy) return; busy = true; controls(); renderSaved(); message(window.AtlasUI.text('正在保存共享标注…'));
      let failed = false;
      try { const { response, payload } = await request('/api/map-annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, ...operation }) });
        if (response.status === 409) { await load(); throw new Error(window.AtlasUI.text('其他浏览器已修改标注，已重新读取。请核对后重试；预览仍保留。')); }
        if (!response.ok) throw new Error(payload.error || '保存失败，请重试。');
        accept(payload); cancelPreview(); message(operation.op === 'add' ? window.AtlasUI.text('已保存共享标注。其他浏览器刷新或切回窗口即可同步。') : window.AtlasUI.text('已删除共享标注。')); if (selectedId) map.closePopup(popup);
      } catch (error) {
        failed = true;
        if (error.name === 'AbortError' || error instanceof TypeError) { writable = false; message(window.AtlasUI.text('无法确认保存结果，请先刷新共享标注核对，勿重复保存。'), true); }
        else message(error.message, true);
      }
      finally {
        busy = false; renderSaved();
        if (failed) {
          setOpen(true);
          $('annotation-status').tabIndex = -1;
          $('annotation-status').focus({ preventScroll: true });
          $('annotation-status').scrollIntoView({ block: 'nearest' });
        }
      }
    }
    function removePlace(place) { if (writable && !busy && confirm(`删除用户标注“${place.name}${window.AtlasUI.text("”？所有局域网浏览器共享此变更。已被疆域编辑引用的地点须先撤销相关编辑。")}`)) commit({ op: 'remove', id: place.id }); }
    $('annotation-toggle').addEventListener('click', () => setOpen($('annotation-panel').hidden)); $('annotation-close').addEventListener('click', () => setOpen(false));
    $('annotation-search-form').addEventListener('submit', search);
    ['annotation-query', 'annotation-kind', 'annotation-scope'].forEach(id => $(id).addEventListener('input', () => { sequence++; controller?.abort(); searching = false; candidates = []; cancelPreview(); renderCandidates(); controls(); message('条件已修改，请点击搜索候选。'); }));
    $('annotation-cancel').addEventListener('click', cancelPreview);
    $('annotation-save-form').addEventListener('submit', event => { event.preventDefault(); if (selected && $('annotation-save-form').reportValidity()) commit({ op: 'add', candidateId: selected.candidateId, name: $('annotation-name').value.trim(), note: $('annotation-note').value.trim() }); });
    $('annotation-refresh').addEventListener('click', async () => { try { if (window.TerritoryEdits) await window.TerritoryEdits.load(); else await load(); message(window.AtlasUI.text('共享标注与疆域已刷新；未丢弃候选预览。')); } catch (error) { message(error.message, true); } });
    $('layer-annotations').addEventListener('change', () => { if ($('layer-annotations').checked) layer.addTo(map); else { map.removeLayer(layer); map.closePopup(popup); } renderSaved(); });
    map.on('popupclose', event => { if (event.popup === popup) { selectedId = null; arrangeLabels(); } });
    $('annotation-offline').hidden = http; controls(); renderSaved();
    window.MapAnnotations = { load, focus, labelCandidates, searchEntries: () => annotations.map(place => ({ place, custom: true, category: place.kind, search: [place.name, place.matchedName, typeof place.address === 'string' ? place.address : Object.values(place.address || {}).join(' ')].join('\n').toLocaleLowerCase() })), getState: () => ({ loaded, writable, count: annotations.length, searching, candidateCount: candidates.length, selectedCandidateId: selected?.candidateId || null, previewVisible: preview.getLayers().length > 0, revision }) };
    return window.MapAnnotations;
  };
})();
