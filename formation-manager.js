(() => {
  'use strict';
  window.createFormationManager = ({ getState, commit, focusCharacter, message }) => {
    const $ = id => document.getElementById(id);
    const node = (tag, text = '', cls = '') => { const el = document.createElement(tag); el.textContent = text; el.className = cls; return el; };
    const button = (text, action) => { const el = node('button', text); el.type = 'button'; el.addEventListener('click', action); return el; };
    let draft = null, pending = false, rosterKey = '', notice = '', failed = false, mapSelecting = false;
    const blocked = state => pending || state.busy || !state.writable;
    const getSelectionState = () => ({ active: mapSelecting && !!draft, memberIds: draft ? [...draft.memberIds] : [], commanderId: draft?.commanderId || '', formationId: draft?.id || null });
    const selectionChanged = () => document.dispatchEvent(new CustomEvent('formation-selection-changed', { detail: getSelectionState() }));
    const changed = () => { document.dispatchEvent(new Event('formation-editing-changed')); selectionChanged(); };
    function tell(text, error = false) { notice = text; failed = error; for (const id of ['formation-status', 'formation-map-notice']) { $(id).textContent = text; $(id).classList.toggle('territory-error', error); } }
    function cancel() {
      if (pending) return;
      draft = null; mapSelecting = false; rosterKey = ''; tell(''); render(); changed();
    }
    function open(id = null) {
      const state = getState();
      if (blocked(state) || draft) return;
      const formation = id ? state.formations.find(item => item.id === id) : null;
      if (id && !formation) return;
      draft = { id, name: formation?.name || '', memberIds: new Set(formation?.memberIds || []), commanderId: formation?.commanderId || '', revision: state.revision };
      $('formation-name').value = draft.name; rosterKey = ''; tell(''); render(); changed(); $('formation-name').focus();
    }
    function startMapSelection() {
      if (!draft || blocked(getState())) return;
      mapSelecting = true; tell('地图仅展开未隐藏人物；已隐藏人物可在侧栏勾选管理，不会自动恢复。首位选中人物默认担任主将，可在“指定主将”中修改。'); render(); selectionChanged();
      $('formation-map-controls').scrollIntoView({ block: 'nearest' });
    }
    function toggleMember(id) {
      const state = getState();
      if (!draft || blocked(state)) return;
      if (draft.memberIds.has(id)) {
        draft.memberIds.delete(id);
        if (draft.commanderId === id) draft.commanderId = '';
        tell(draft.commanderId || !draft.memberIds.size ? '' : '请为已选成员重新指定主将。');
      } else {
        const person = state.characters.find(item => item.id === id), owner = state.formations.find(item => item.id !== draft.id && item.memberIds.includes(id));
        if (!person) { tell(window.AtlasUI.text('此人物已不存在，请刷新共享人物。'), true); return; }
        if (owner) { tell(`“${person.name}”已在“${owner.name}”中，不能加入当前编队。`, true); return; }
        if (draft.memberIds.size >= 50) { tell('每队最多50人，请先取消选择一位成员。', true); return; }
        draft.memberIds.add(id);
        if (draft.memberIds.size === 1) { draft.commanderId = id; tell(`已默认指定“${person.name}”为主将，可在主将下拉框中修改。`); }
        else tell('');
      }
      render(); selectionChanged();
    }
    function setCommander(id) {
      if (!draft || blocked(getState()) || (id && !draft.memberIds.has(id))) return;
      draft.commanderId = id; tell(''); render(); selectionChanged();
    }
    function startFromCharacter(id) {
      const state = getState();
      if (blocked(state) || !state.characters.some(item => item.id === id)) return;
      if (!draft) open(state.formations.find(item => item.memberIds.includes(id))?.id || null);
      if (!draft) return;
      startMapSelection();
      if (!draft.memberIds.has(id)) toggleMember(id);
    }
    function finishMapSelection() {
      if (!draft || blocked(getState())) return;
      mapSelecting = false; render(); selectionChanged();
      document.body.classList.remove('sidebar-hidden'); $('toggle-sidebar').setAttribute('aria-expanded', 'true'); $('toggle-sidebar').textContent = '收起侧栏';
      $('formation-name').focus(); $('formation-form').scrollIntoView({ block: 'nearest' });
    }
    function problem(state) {
      if (!draft) return '';
      if (!draft.name.trim() || [...draft.name.trim()].length > 60) return '请输入1—60字的编队名称。';
      if (draft.memberIds.size < 2 || draft.memberIds.size > 50) return '请选择2—50位已保存人物。';
      if (!draft.memberIds.has(draft.commanderId)) return '请从已选成员中指定一位主将。';
      if (draft.id && !state.formations.some(item => item.id === draft.id)) return '此编队已被解散；草稿仍保留，请取消后重新建队。';
      if (!draft.id && state.formations.length >= 100) return '最多保存100支编队，请先解散不再需要的编队。';
      for (const id of draft.memberIds) {
        if (!state.characters.some(item => item.id === id)) return '已选人物已被删除，请取消勾选失效成员。';
        if (state.formations.some(item => item.id !== draft.id && item.memberIds.includes(id))) return '已选人物已加入其他编队，请取消勾选这些成员。';
      }
      return '';
    }
    async function save(retry = false) {
      const state = getState();
      if (!draft || blocked(state)) return;
      const error = problem(state);
      if (error) { tell(error, true); return; }
      if (draft.revision !== state.revision && !retry) { render(); return; }
      if (retry) draft.revision = state.revision;
      const operation = { op: draft.id ? 'formation-update' : 'formation-add', formation: { name: draft.name.trim(), memberIds: [...draft.memberIds], commanderId: draft.commanderId } };
      if (draft.id) operation.id = draft.id;
      pending = true; tell(window.AtlasUI.text('正在共享保存编队…')); render();
      let success = false;
      try { success = await commit(operation, draft.revision); }
      catch (error) { message(`编队保存失败：${error.message}`, true); }
      finally { pending = false; }
      if (success) { draft = null; mapSelecting = false; rosterKey = ''; tell(window.AtlasUI.text('编队已共享保存。')); changed(); }
      else tell(window.AtlasUI.text('保存未成功，草稿已保留。请核对共享人物与编队；若版本已更新，请明确选择采用最新版本并重试。'), true);
      render();
    }
    async function dissolve(id) {
      const state = getState(), formation = state.formations.find(item => item.id === id);
      if (blocked(state) || draft || !formation) return;
      if (!window.confirm(`解散“${formation.name}”？只解除编队，所有人物、资料与当前位置均保留。`)) return;
      pending = true; tell('正在解散编队…'); render();
      let success = false;
      try { success = await commit({ op: 'formation-remove', id }, state.revision); }
      catch (error) { message(`解散失败：${error.message}`, true); }
      finally { pending = false; }
      tell(success ? '编队已解散，人物与位置保留。' : '解散未成功。请核对最新编队，再次点击解散并确认；不会自动重试。', !success); render();
    }
    function renderRoster(state) {
      const owners = new Map();
      for (const formation of state.formations) for (const id of formation.memberIds) if (formation.id !== draft.id) owners.set(id, formation.name);
      const people = [...state.characters];
      for (const id of draft.memberIds) if (!people.some(item => item.id === id)) people.push({ id, name: '已删除的人物（取消勾选以移除）' });
      const key = JSON.stringify(people.map(person => [person.id, person.name, !!person.hidden, owners.get(person.id)]));
      if (key !== rosterKey) {
        rosterKey = key; $('formation-roster').replaceChildren();
        for (const person of people) {
          const label = node('label', '', 'formation-member'), checkbox = node('input');
          checkbox.type = 'checkbox'; checkbox.value = person.id;
          checkbox.addEventListener('change', () => toggleMember(person.id));
          label.append(checkbox, node('span', `${person.name}${person.hidden ? ' · 已隐藏' : ''}${owners.has(person.id) ? ` · 已在“${owners.get(person.id)}”` : ''}`)); $('formation-roster').append(label);
        }
        if (!people.length) $('formation-roster').append(node('p', '尚无已保存人物。请取消草稿，先新增至少两位人物并保存。', 'hint'));
      }
      for (const checkbox of $('formation-roster').querySelectorAll('input')) {
        checkbox.checked = draft.memberIds.has(checkbox.value);
        checkbox.disabled = !checkbox.checked && (owners.has(checkbox.value) || draft.memberIds.size >= 50);
      }
      $('formation-count').textContent = `已选 ${draft.memberIds.size} / 50 人 · 至少2人；灰色人物已在其他编队或已达上限。隐藏人物仍可勾选管理，不会恢复地图显示。`;
      for (const select of [$('formation-commander'), $('formation-map-commander')]) {
        select.replaceChildren();
        const placeholder = node('option', draft.memberIds.size ? '请选择主将' : '请先选择成员'); placeholder.value = ''; select.append(placeholder);
        for (const person of state.characters) if (draft.memberIds.has(person.id)) { const option = node('option', `${person.name}${person.hidden ? ' · 已隐藏' : ''}`); option.value = person.id; select.append(option); }
        select.value = draft.commanderId;
      }
    }
    function render() {
      const state = getState(), unsafe = blocked(state), formations = state.formations;
      $('formation-section').setAttribute('aria-busy', String(!!(pending || state.busy)));
      $('formation-new').disabled = unsafe || !!draft || formations.length >= 100 || state.characters.filter(person => !formations.some(formation => formation.memberIds.includes(person.id))).length < 2;
      $('formation-summary').textContent = `${formations.length} / 100 支编队${!state.writable ? window.AtlasUI.text(' · 当前不可共享保存') : ''}。${!formations.length ? '先保存至少两位人物，再新建编队。' : ''}`;
      $('formation-form').hidden = !draft; $('formation-fields').disabled = unsafe;
      $('formation-map-controls').hidden = !mapSelecting || !draft;
      $('formation-map-select').setAttribute('aria-pressed', String(mapSelecting));
      for (const id of ['formation-map-commander', 'formation-map-done']) $(id).disabled = unsafe;
      $('formation-map-cancel').disabled = pending;
      if (draft) {
        $('formation-form-title').textContent = draft.id ? '编辑编队' : '新建编队'; renderRoster(state);
        const commander = state.characters.find(person => person.id === draft.commanderId);
        $('formation-map-summary').textContent = `地图选人 · 已选 ${draft.memberIds.size} / 50 人（至少2人） · 主将：${commander?.name || '尚未指定'}${commander?.hidden ? '（已隐藏，保存后整队军旗暂不显示）' : ''}`;
        const stale = draft.revision !== state.revision, error = problem(state);
        $('formation-save').disabled = unsafe || stale || !!error;
        $('formation-retry').hidden = !stale; $('formation-retry').disabled = unsafe || !!error;
        $('formation-status').textContent = [notice, commander?.hidden ? '主将已隐藏，整队军旗暂不显示；保存编队不会恢复主将，成员与位置仍保留。' : '', stale ? window.AtlasUI.text('共享版本已变化，草稿未被覆盖。请核对下方最新编队与成员，再采用最新版本重试；这会以本草稿替换该队配置。') : '', error].filter(Boolean).join(' ');
        $('formation-status').classList.toggle('territory-error', failed || stale);
      }
      $('formation-records').replaceChildren();
      const people = new Map(state.characters.map(person => [person.id, person]));
      for (const formation of formations) {
        const item = node('li', '', 'formation-record'), commander = people.get(formation.commanderId);
        item.append(node('strong', formation.name), node('p', `主将：${commander?.name || '人物不可用'} · ${formation.memberIds.length}人`, 'hint'));
        item.append(node('p', formation.memberIds.map(id => `${people.get(id)?.name || '人物不可用'}${id === formation.commanderId ? '（主将）' : ''}${people.get(id)?.hidden ? '（已隐藏）' : ''}`).join('、'), 'hint'));
        if (commander?.hidden) item.append(node('p', '主将已隐藏，整队军旗暂不显示；恢复主将后重新显示。编队、成员与位置保留。', 'reference-note'));
        const actions = node('div', '', 'territory-actions');
        const focus = button(commander?.hidden ? '查看主将' : '定位主将', () => focusCharacter(formation.commanderId)), edit = button('编辑编队', () => open(formation.id)), remove = button('解散编队', () => dissolve(formation.id));
        focus.disabled = !!(pending || state.busy) || !commander; edit.disabled = remove.disabled = unsafe || !!draft;
        actions.append(focus, edit, remove); item.append(actions); $('formation-records').append(item);
      }
    }
    $('formation-new').addEventListener('click', () => open());
    $('formation-name').addEventListener('input', () => { if (draft) { draft.name = $('formation-name').value; tell(''); render(); } });
    $('formation-commander').addEventListener('change', () => setCommander($('formation-commander').value));
    $('formation-map-commander').addEventListener('change', () => setCommander($('formation-map-commander').value));
    $('formation-map-select').addEventListener('click', startMapSelection);
    $('formation-map-done').addEventListener('click', finishMapSelection);
    $('formation-map-cancel').addEventListener('click', () => { cancel(); $('formation-new').focus(); });
    $('formation-form').addEventListener('submit', event => { event.preventDefault(); save(); });
    $('formation-retry').addEventListener('click', () => save(true));
    $('formation-cancel').addEventListener('click', () => { cancel(); $('formation-new').focus(); });
    return { render, cancel, edit: open, isEditing: () => !!draft, startFromCharacter, toggleMember, setCommander, isMapSelecting: () => mapSelecting && !!draft, getSelectionState };
  };
})();
