(() => {
  'use strict';
  const http = /^https?:$/.test(location.protocol), $ = id => document.getElementById(id);
  const places = new Map((window.GEO_DATA?.places || []).map(place => [place.id, place]));
  const state = { revision: 0, overrides: [], writable: false, loading: false, saving: false, error: '' };
  let records = new Map(), onChange, loading, dialog, draft, draftRevision, retryOp;
  const getState = () => ({ ...state, overrides: state.overrides.map(item => ({ ...item })) });
  const lookup = id => records.get(id) || null;
  function status(message = state.error) {
    if ($('place-period-status')) $('place-period-status').textContent = message;
    $('place-period-summary').textContent = !http ? window.AtlasUI.text('文件模式只读：无法读取或保存共享显示年代，请通过局域网 HTTP 地址打开地图。') : state.loading ? window.AtlasUI.text('正在读取共享显示年代…') : state.error || `用户显示年代：${state.overrides.length} 条（非史料修订）`;
    $('place-period-refresh').disabled = !http || state.loading || state.saving;
    if (!dialog) return;
    $('place-period-fields').disabled = !state.writable || state.loading || state.saving;
    $('place-period-save').disabled = !state.writable || state.loading || state.saving || !!retryOp;
    $('place-period-reset').disabled = !state.writable || state.loading || state.saving || !!retryOp || !records.has(draft?.id);
    $('place-period-retry').hidden = !retryOp;
    $('place-period-retry').disabled = !state.writable || state.loading || state.saving;
    $('place-period-reload').disabled = !http || state.loading || state.saving;
    $('place-period-cancel').disabled = state.saving;
    dialog.setAttribute('aria-busy', String(state.loading || state.saving));
    if (draft) $('place-period-current').textContent = records.has(draft.id) ? `${window.AtlasUI.text("已共享的用户显示年代：")}${records.get(draft.id).begin}—${records.get(draft.id).end}年` : '未设置用户显示年代，沿用原有显示规则。';
  }
  function accept(payload) {
    if (!payload || !Number.isInteger(payload.revision) || payload.revision < 0 || !Array.isArray(payload.overrides) || payload.overrides.length > places.size) throw new Error(window.AtlasUI.text('共享显示年代格式异常，已禁止保存。'));
    const next = new Map();
    for (const item of payload.overrides) {
      if (!item || !places.has(item.placeId) || next.has(item.placeId) || !Number.isInteger(item.begin) || !Number.isInteger(item.end) || item.begin < -5000 || item.end > 9999 || item.begin > item.end || typeof item.updatedAt !== 'string' || !item.updatedAt.endsWith('Z') || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error(window.AtlasUI.text('共享显示年代记录异常，已禁止保存。'));
      next.set(item.placeId, Object.freeze({ placeId: item.placeId, begin: item.begin, end: item.end, updatedAt: item.updatedAt }));
    }
    records = next; state.revision = payload.revision; state.overrides = [...next.values()]; state.writable = http; state.error = '';
  }
  async function request(options) {
    const response = await window.AtlasAPI.fetch('/api/place-periods', { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', ...options });
    let payload;
    try { payload = await response.json(); } catch { throw new Error(window.AtlasUI.text('服务器未返回有效 JSON，未确认保存。')); }
    if (!response.ok) { const error = new Error(payload.error || `请求失败（${response.status}）`); error.status = response.status; throw error; }
    return payload;
  }
  function notify() { onChange?.(getState()); window.dispatchEvent(new CustomEvent('place-periods-change', { detail: getState() })); }
  function load() {
    if (!http) { state.error = window.AtlasUI.text('文件模式只读：无法读取或保存共享显示年代，请通过局域网 HTTP 地址打开地图。'); status(); return Promise.resolve(getState()); }
    if (loading) return loading;
    if (state.saving) return Promise.resolve(getState());
    state.loading = true; state.writable = false; status(window.AtlasUI.text('正在读取共享显示年代；草稿保留。'));
    loading = (async () => {
      try { accept(await request()); }
      catch (error) { state.error = `读取失败：${error.message} 未采用空记录覆盖，保存已禁用。`; state.writable = false; }
      finally { state.loading = false; loading = null; status(state.error || (retryOp ? window.AtlasUI.text('共享版本已刷新，草稿未变。请核对当前共享年代，然后点击“采用最新版本并重试”。') : window.AtlasUI.text('共享显示年代已刷新；未更改草稿或所选年份。'))); notify(); }
      return getState();
    })();
    return loading;
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.id = 'place-period-dialog'; dialog.className = 'place-period-dialog';
    dialog.setAttribute('aria-labelledby', 'place-period-title'); dialog.setAttribute('aria-describedby', 'place-period-warning');
    dialog.innerHTML = window.AtlasUI.text('<form id="place-period-form"><h2 id="place-period-title">编辑显示年代</h2><p id="place-period-identity"></p><p id="place-period-source"></p><p id="place-period-current"></p><p id="place-period-warning" class="reference-note">用户显示年代非史料修订。只改变此 ID 的地图年份筛选，不修改原始年代、来源、行政父级、政治线索或核验报告。同名异地记录不受影响；保存后所有局域网浏览器共享。</p><fieldset id="place-period-fields"><legend>用户显示范围（含起止年）</legend><label for="place-period-begin">起年</label><input id="place-period-begin" type="number" min="-5000" max="9999" step="1" required><label for="place-period-end">止年</label><input id="place-period-end" type="number" min="-5000" max="9999" step="1" required></fieldset><p id="place-period-status" role="status" aria-live="polite"></p><div class="territory-actions"><button id="place-period-save" type="submit">保存显示年代</button><button id="place-period-retry" type="button" hidden>采用最新版本并重试</button><button id="place-period-reset" type="button">恢复原始显示规则</button><button id="place-period-reload" type="button">刷新共享年代</button><button id="place-period-cancel" type="button">取消</button></div></form>');
    document.body.append(dialog);
    $('place-period-form').addEventListener('submit', event => { event.preventDefault(); if (!retryOp) commit('set'); });
    $('place-period-reset').addEventListener('click', () => { if (confirm(`恢复“${draft.name}”（${draft.id}）的原始显示规则？仅删除此 ID 的用户显示年代。`)) commit('reset'); });
    $('place-period-retry').addEventListener('click', () => { const op = retryOp; if (!op || !state.writable) return; draftRevision = state.revision; commit(op); });
    $('place-period-reload').addEventListener('click', load);
    $('place-period-cancel').addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { if (state.saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { draft = null; retryOp = null; if (!document.activeElement || document.activeElement === document.body) $('city-search')?.focus(); });
  }
  async function commit(op) {
    if (!draft || !state.writable || state.saving || state.loading) return;
    const operation = { op, revision: draftRevision, placeId: draft.id };
    if (op === 'set') {
      if (!$('place-period-form').reportValidity()) return;
      operation.begin = $('place-period-begin').valueAsNumber; operation.end = $('place-period-end').valueAsNumber;
      if (!Number.isInteger(operation.begin) || !Number.isInteger(operation.end) || operation.begin > operation.end) { status('请输入整数年份，起年不可晚于止年。'); return; }
    }
    retryOp = null; state.saving = true; status('正在保存，请稍候…');
    try {
      accept(await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation) }));
      state.saving = false; dialog.close(); status(op === 'reset' ? '已恢复原始显示规则。' : window.AtlasUI.text('用户显示年代已共享保存。')); notify();
    } catch (error) {
      state.saving = false; retryOp = op;
      state.error = error.status === 409 ? window.AtlasUI.text('共享版本冲突，未覆盖他人修改。草稿保留，正在读取最新版本。') : `保存未确认：${error.message}${window.AtlasUI.text(" 草稿保留；请核对共享记录后明确重试。")}`;
      state.writable = false; status(); await load();
    }
  }
  function edit(place) {
    if (state.saving || !places.has(place?.id)) return;
    ensureDialog(); draft = places.get(place.id); draftRevision = state.revision; retryOp = null;
    $('place-period-identity').textContent = `${draft.name} · ${draft.id} · ${draft.lat}°N，${draft.lon}°E`;
    $('place-period-source').textContent = `原始资料年代：${draft.period?.begin ?? '起年不明'}—${draft.period?.end ?? '止年不明'}年；来源年代规则：起年 ${draft.period?.['begin rule'] || '未注明'} / 止年 ${draft.period?.['end rule'] || '未注明'}（来源记录及其不确定性不变）。${draft.note || ''}`;
    const current = lookup(draft.id);
    $('place-period-begin').value = current?.begin ?? draft.period?.begin ?? '';
    $('place-period-end').value = current?.end ?? draft.period?.end ?? '';
    status(state.error || '请核对 ID、坐标与原始年代后保存。');
    if (!dialog.open) dialog.showModal();
    (state.writable ? $('place-period-begin') : $('place-period-cancel')).focus();
  }
  window.PlacePeriods = { init(callback) { onChange = callback; $('place-period-refresh')?.addEventListener('click', load); return load(); }, load, getState, lookup, edit };
})();
