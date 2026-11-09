(() => {
  'use strict';
  window.createTerritoryEditor = ({ map, places, polities, getYear, stopPlayback, refresh, token }) => {
    const $ = id => document.getElementById(id);
    const api = window.TerritoryEdits;
    const offline = location.protocol === 'file:';
    const state = () => api?.getState() || { loaded: false, writable: false, revision: 0, edits: [], error: '疆域编辑模块未加载，请刷新页面。' };
    const placeNames = new Map(places.map(place => [place.id, place.name]));
    const polityNames = new Map(polities.map(polity => [polity.id, polity.name]));
    const polityColors = new Map(polities.map(polity => [polity.id, polity.color]));
    let active = false, drawing = false, complete = false, busy = false, loading = false;
    let place = null, points = [], draftRevision = null, doubleClickZoom = false;
    const preview = L.layerGroup().addTo(map);
    const pane = map.createPane('territoryDraft'); pane.style.zIndex = 480; pane.style.pointerEvents = 'none';
    const inspectionPane = map.createPane('territoryInspection'); inspectionPane.style.zIndex = 475; inspectionPane.style.pointerEvents = 'none';
    const inspection = L.geoJSON(null, { pane: 'territoryInspection', interactive: false, style: feature => ({ color: polityColors.get(feature.properties.polityId) || token('--accent'), weight: 3, opacity: 1, dashArray: '8 6', fill: false, interactive: false }) }).addTo(map);
    let selectedPreviewId = null, inspectedRecord = null;
    const inspectionNotice = document.createElement('p'); inspectionNotice.id = 'territory-inspection-notice'; inspectionNotice.className = 'hint'; inspectionNotice.setAttribute('role', 'status');
    $('territory-records').before(inspectionNotice);
    function clearInspection() {
      selectedPreviewId = null; inspectedRecord = null; inspection.clearLayers();
      renderInspectionStatus();
    }
    function renderInspectionStatus() {
      const current = state();
      const edit = current.edits.find(record => record.id === selectedPreviewId);
      inspectionNotice.textContent = edit ? `虚线：${placeNames.get(edit.placeId) || edit.placeId}的原始保存范围 · ${edit.startYear}年起生效 · 当前 ${getYear()} 年${edit.startYear > getYear() ? '，尚未生效' : ''}。后续重叠编辑可能改变撤销后的实际影响；虚线不代表最终疆域或完整撤销效果。再次点击可隐藏。` : drawing ? '绘制期间暂停查看记录范围；完成或取消绘制后可查看。' : '点击记录或“查看范围”显示原始保存范围的虚线，再次点击隐藏；仅供查看，不改变年份或数据。';
      for (const item of $('territory-records').children) {
        const selected = item.dataset.editId === selectedPreviewId;
        item.classList.toggle('territory-record-selected', selected);
        const button = item.querySelector('[data-preview-edit]');
        if (button) {
          button.setAttribute('aria-pressed', String(selected));
          button.textContent = selected ? '范围已显示 · 点击隐藏' : '查看范围';
          button.disabled = drawing || !current.loaded;
        }
      }
    }
    function syncInspection(current) {
      const edit = current.loaded && active && current.edits.find(record => record.id === selectedPreviewId);
      if (!edit) { clearInspection(); return; }
      if (edit !== inspectedRecord) {
        inspection.clearLayers();
        inspection.addData({ type: 'Feature', properties: { polityId: edit.polityId }, geometry: edit.geometry });
        inspectedRecord = edit;
      }
      renderInspectionStatus();
    }
    function toggleInspection(id) {
      if (!active || drawing || !state().loaded) return;
      if (selectedPreviewId === id) { clearInspection(); return; }
      selectedPreviewId = id; syncInspection(state());
      const bounds = inspection.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 8 });
    }
    const message = (value, error = false) => {
      $('territory-status').textContent = value;
      $('territory-status').classList.toggle('territory-error', error);
    };
    function periodNotice() {
      if (!place) return;
      const year = Number($('territory-year').value);
      const begin = Number(place.period?.begin), end = Number(place.period?.end);
      $('territory-period').textContent = place.id.startsWith('user-') ? `用户添加地点，非原始史实。${place.temporalNote || '年代未确认；现代定位不可当作古治所。'}` : place.referenceSite ? '固定历史地点仅作定位，不证明当年建置或控制。' : !Number.isFinite(begin) || !Number.isFinite(end) ? '此地点年代不完整；请核对来源后编辑。' : year < begin || year > end ? `注意：生效年不在此条地点记录的 ${begin}—${end} 年内。仍可作为自定义历史定位使用。` : `地点记录年代：${begin}—${end} 年；不代表当年政权控制。`;
    }
    function renderDraft() {
      preview.clearLayers();
      if (active && place) L.circleMarker([place.lat, place.lon], { pane: 'territoryDraft', radius: 6, color: token('--accent'), fillColor: token('--surface'), fillOpacity: 1, interactive: false }).addTo(preview);
      if (points.length) {
        const latlngs = points.map(([lon, lat]) => [lat, lon]);
        const options = { pane: 'territoryDraft', color: token('--accent'), weight: 2, dashArray: complete ? null : '6 4', fillOpacity: .18, interactive: false };
        (complete ? L.polygon(latlngs, options) : L.polyline(latlngs, options)).addTo(preview);
        latlngs.forEach(latlng => L.circleMarker(latlng, { ...options, radius: 3, fillOpacity: 1 }).addTo(preview));
      }
      $('territory-preview').textContent = points.length ? `${complete ? '待保存预览' : '绘制中'} · ${points.length} 个顶点 · ${place?.name || ''} · ${$('territory-year').value}年起 → ${polityNames.get($('territory-polity').value) || '尚未选择目标势力'}。${complete ? '请核对范围；保存时校验包含地点、无自交。' : '单击地图继续添加，完成后预览。'}` : '尚未绘制范围。';
      $('territory-draw').textContent = points.length ? '重新绘制' : '开始绘制';
      $('territory-draw').disabled = !place;
      $('territory-undo-point').disabled = !drawing || !points.length;
      $('territory-finish').disabled = !drawing || points.length < 3;
      $('territory-cancel').disabled = !points.length && !drawing;
      $('territory-save').disabled = !complete || !place || !placeNames.has(place.id) || !$('territory-polity').value || !state().writable || busy || loading;
      periodNotice();
      renderInspectionStatus();
    }
    function endDrawing() {
      if (drawing) { map.off('click', addPoint); if (doubleClickZoom) map.doubleClickZoom.enable(); }
      drawing = false; map.getContainer().classList.remove('territory-drawing');
    }
    function cancelDraft() {
      endDrawing(); points = []; complete = false; draftRevision = null; renderDraft();
    }
    function addPoint(event) {
      const point = [event.latlng.lng, event.latlng.lat];
      if (!points.some(other => other[0] === point[0] && other[1] === point[1])) points.push(point);
      renderDraft();
    }
    function setActive(value) {
      if (busy) return;
      active = value; $('territory-panel').hidden = !value;
      $('territory-toggle').setAttribute('aria-expanded', String(value));
      if (value) {
        stopPlayback(); $('play').disabled = true;
        document.body.classList.remove('sidebar-hidden'); $('toggle-sidebar').setAttribute('aria-expanded', 'true'); $('toggle-sidebar').textContent = '收起侧栏';
        $('territory-year').value = getYear(); map.invalidateSize({ pan: false });
        $('territory-panel').scrollIntoView({ block: 'nearest' });
        renderDraft();
      } else { clearInspection(); cancelDraft(); preview.clearLayers(); $('play').disabled = false; }
    }
    function selectPlace(next) {
      if (busy || drawing || offline || !state().writable) return;
      if (!active) setActive(true);
      if (place?.id !== next.id) cancelDraft();
      place = next; $('territory-place').textContent = `${place.name} · ${place.kind || '历史地点'} · ${place.id}`;
      renderDraft();
    }
    function render() {
      const current = state();
      const effective = current.edits.filter(edit => edit.startYear <= getYear()).length;
      $('territory-summary').textContent = `${effective ? `用户编辑 · 当前年 ${effective} 条生效` : '原始历史图 · 当前年无生效编辑'} · 共 ${current.edits.length}${window.AtlasUI.text(" 条共享记录")}${current.loaded ? '' : window.AtlasUI.text(' · 尚未加载共享状态')}`;
      $('territory-fields').disabled = offline || !current.writable || busy || loading;
      $('territory-refresh').disabled = offline || busy || loading || !api;
      $('territory-clear').disabled = !current.writable || busy || loading || !current.edits.length;
      $('territory-close').disabled = busy;
      $('territory-toggle').disabled = busy;
      $('territory-records').replaceChildren();
      if (!current.edits.length) { const item = document.createElement('li'); item.textContent = window.AtlasUI.text('尚无共享编辑。选择地点并手绘范围后保存。'); $('territory-records').append(item); }
      [...current.edits].sort((a, b) => b.startYear - a.startYear || b.sequence - a.sequence).forEach(edit => {
        const item = document.createElement('li'); item.dataset.editId = edit.id;
        const title = document.createElement('p'); title.textContent = `${placeNames.get(edit.placeId) || edit.placeId} · ${edit.startYear}年起 → ${polityNames.get(edit.polityId) || edit.polityId}`;
        const detail = document.createElement('p'); detail.className = 'hint'; detail.textContent = `创建：${edit.createdAt || '未记录'} · 序号 ${edit.sequence}${edit.note ? ` · ${edit.note}` : ''}`;
        const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.removeEdit = edit.id; remove.textContent = '撤销此条'; remove.disabled = !current.writable || busy || loading;
        remove.addEventListener('click', event => { event.stopPropagation(); if (confirm(`撤销“${title.textContent}${window.AtlasUI.text("”？所有局域网客户端都将受影响。")}`)) commit(() => api.remove(edit.id), window.AtlasUI.text('已撤销共享编辑。')); });
        const inspect = document.createElement('button'); inspect.type = 'button'; inspect.dataset.previewEdit = edit.id;
        inspect.setAttribute('aria-label', `查看或隐藏原始保存范围：${title.textContent}`); inspect.setAttribute('aria-describedby', inspectionNotice.id);
        inspect.addEventListener('click', event => { event.stopPropagation(); toggleInspection(edit.id); });
        item.addEventListener('click', event => { if (!event.target.closest('button')) toggleInspection(edit.id); });
        item.append(title, detail, inspect, remove); $('territory-records').append(item);
      });
      syncInspection(current);
      renderDraft();
    }
    async function reload() {
      if (!api || offline || loading || busy) return;
      loading = true; message(window.AtlasUI.text('正在读取共享编辑…')); render();
      try { await api.load(); message(draftRevision !== null && draftRevision !== state().revision ? window.AtlasUI.text('共享记录已改变；手绘草稿已保留。请核对新图，保存时需再次确认重试。') : window.AtlasUI.text('共享编辑已刷新。')); }
      catch (error) { message(error.message, true); }
      finally { loading = false; render(); }
    }
    async function commit(action, success, savedDraft = false) {
      if (busy || loading || !state().writable) return;
      busy = true; message(window.AtlasUI.text('正在保存共享变更，请稍候…')); render();
      try { await action(); if (savedDraft) cancelDraft(); message(success); }
      catch (error) { message(`${error.message} 草稿未丢弃；未显示虚假保存结果。`, true); }
      finally { busy = false; render(); }
    }
    $('territory-offline').hidden = !offline;
    polities.forEach(polity => { const option = document.createElement('option'); option.value = polity.id; option.textContent = polity.name; $('territory-polity').append(option); });
    $('territory-year').value = getYear();
    $('territory-toggle').addEventListener('click', () => setActive(!active));
    $('territory-close').addEventListener('click', () => setActive(false));
    $('territory-find').addEventListener('click', () => { $('city-search').focus(); $('city-search').scrollIntoView({ block: 'nearest' }); });
    ['territory-year', 'territory-polity'].forEach(id => $(id).addEventListener('input', renderDraft));
    $('territory-draw').addEventListener('click', () => {
      if (!place || busy) return;
      clearInspection();
      cancelDraft(); draftRevision = state().revision; drawing = true; doubleClickZoom = map.doubleClickZoom.enabled(); map.doubleClickZoom.disable();
      map.closePopup(); map.getContainer().classList.add('territory-drawing'); map.on('click', addPoint); renderDraft();
      map.getContainer().scrollIntoView({ block: 'nearest' });
      message('正在绘制：单击地图添加顶点；拖动平移、滚轮缩放，完成后点击“完成范围”。');
    });
    $('territory-undo-point').addEventListener('click', () => { points.pop(); renderDraft(); });
    $('territory-finish').addEventListener('click', () => { if (points.length >= 3) { endDrawing(); complete = true; renderDraft(); message('范围已闭合预览，尚未保存。可重新绘制调整。'); } });
    $('territory-cancel').addEventListener('click', () => { cancelDraft(); message(window.AtlasUI.text('已取消临时范围，原有共享记录未改变。')); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && active && !busy) { cancelDraft(); message('已取消临时范围。'); } });
    $('territory-save').addEventListener('click', () => {
      if (!complete || !place || !$('territory-year').reportValidity() || !$('territory-polity').reportValidity()) return;
      if (draftRevision !== state().revision) { draftRevision = state().revision; message(window.AtlasUI.text('共享记录已改变，草稿仍保留。请核对当前地图与预览，再次点击保存以确认重试。'), true); return; }
      const payload = { placeId: place.id, startYear: Number($('territory-year').value), polityId: $('territory-polity').value, note: $('territory-note').value.trim(), geometry: { type: 'Polygon', coordinates: [[...points.map(point => [...point]), [...points[0]]]] } };
      commit(() => api.save(payload), window.AtlasUI.text('共享编辑已保存。切换到生效年或后续年份查看填色；早于生效年的地图不变。'), true);
    });
    $('territory-refresh').addEventListener('click', reload);
    $('territory-clear').addEventListener('click', () => { if (confirm(window.AtlasUI.text('删除全部共享编辑并恢复原始历史图？所有局域网浏览器都会受影响，无法恢复这些编辑。'))) commit(() => api.clear(), window.AtlasUI.text('已清除全部共享编辑，恢复原始历史图。')); });
    window.addEventListener('focus', reload);
    api?.subscribe(() => {
      refresh(); render();
      if (draftRevision !== null && draftRevision !== state().revision && !busy) message(window.AtlasUI.text('共享记录已改变；手绘草稿已保留，请核对新图后重试保存。'), true);
    });
    function setCustomPlaces(customPlaces) {
      for (const id of placeNames.keys()) if (id.startsWith('user-')) placeNames.delete(id);
      for (const item of customPlaces) if (['city', 'county'].includes(item.kind)) placeNames.set(item.id, item.name);
      if (place?.id.startsWith('user-')) {
        const updated = customPlaces.find(item => item.id === place.id);
        if (updated) place = updated;
        else message(window.AtlasUI.text('草稿地点已被其他浏览器删除；草稿保留，但请重新选择有效地点后保存。'), true);
      }
      render();
    }
    render();
    if (offline) message(window.AtlasUI.text('离线浏览模式：请通过局域网链接打开以编辑。'));
    else if (!api) message(state().error, true);
    else reload();
    return { selectPlace, setCustomPlaces, isActive: () => active, isDrawing: () => drawing, yearChanged: render, getState: () => ({ active, drawing, complete, saving: busy, loading, placeId: place?.id || null, pointCount: points.length, draftRevision, startYear: Number($('territory-year').value), polityId: $('territory-polity').value, revision: state().revision, writable: state().writable, effectiveEditCount: state().edits.filter(edit => edit.startYear <= getYear()).length, editCount: state().edits.length, previewId: selectedPreviewId, selectedPreviewId, previewLayerCount: inspection.getLayers().length }) };
  };
})();
