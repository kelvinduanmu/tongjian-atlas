(() => {
  'use strict';
  window.createCharacterManager = ({ map, polities, getYear, isTerritoryDrawing }) => {
    const personal = window.AtlasUI.personal;
    const $ = id => document.getElementById(id), http = /^https?:$/.test(location.protocol);
    const palette = new Map(polities.map(polity => [polity.id, polity]));
    const node = (tag, value = '', cls = '') => { const el = document.createElement(tag); el.textContent = value; el.className = cls; return el; };
    const button = (label, action) => { const el = node('button', label); el.type = 'button'; el.addEventListener('click', action); return el; };
    const roleName = role => role === 'monarch' ? '君主' : '大臣';
    map.createPane('characters').style.zIndex = 490;
    const previewPane = map.createPane('characterPreview'); previewPane.style.zIndex = 495; previewPane.style.pointerEvents = 'none';
    const layer = L.layerGroup().addTo(map), preview = L.layerGroup().addTo(map), markers = new Map();
    const popup = L.popup({ maxWidth: 320, maxHeight: 360, autoPan: true });
    const banner = node('p', '', 'character-notice'); banner.id = 'character-notice'; banner.hidden = true; banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite'); map.getContainer().parentElement.append(banner);
    let characters = [], revision = 0, loaded = false, writable = false, loading = false, saving = false, dragging = false, placing = false, selectedId = null, draft = null, error = '';
    let formations = [], formationManager = null, activeDrag = null;
    const memberships = new Map();
    const formationOf = id => memberships.get(id);
    const formationEditing = () => !!formationManager?.isEditing();
    const selectionState = () => formationManager?.getSelectionState() || { active: false, memberIds: [], commanderId: null, formationId: null };
    const mapSelecting = () => selectionState().active;
    const anchorId = id => mapSelecting() ? id : formationOf(id)?.commanderId || id;
    const anchorCharacter = character => character.hidden ? character : characters.find(item => item.id === anchorId(character.id)) || character;
    function syncSelection() {
      const selection = selectionState(), container = map.getContainer(), wasActive = container.classList.contains('formation-selecting');
      if (wasActive !== selection.active) container.classList.toggle('formation-selecting', selection.active);
      if (selection.active && !wasActive) { endPlacement(); map.closePopup(); openPanel(); $('layer-characters').checked = true; layer.addTo(map); }
      if (wasActive !== selection.active) { renderMarkers(); map.invalidateSize({ pan: false }); }
      const selected = new Set(selection.memberIds);
      markers.forEach((marker, id) => {
        const el = marker.getElement(); if (!el) return;
        const member = selected.has(id), commander = member && selection.commanderId === id, formation = formationOf(id), blocked = !!formation && formation.id !== selection.formationId;
        el.classList.toggle('formation-selected', selection.active && member);
        el.classList.toggle('formation-selected-commander', selection.active && commander);
        el.classList.toggle('formation-selection-blocked', selection.active && blocked);
        let badge = el.querySelector('.character-selection-badge');
        if (selection.active) {
          el.setAttribute('aria-pressed', String(member)); el.setAttribute('aria-disabled', String(blocked));
          const state = commander ? '已选 · 主将' : member ? '已选成员' : blocked ? '已属其他编队，不可选择' : '点击加入编队';
          el.setAttribute('aria-label', `${marker.options.title}，${state}`);
          if (!badge) { badge = node('span', '', 'character-selection-badge'); el.querySelector('.character-piece').append(badge); }
          badge.textContent = state;
          marker.dragging.disable();
        } else {
          el.removeAttribute('aria-pressed'); el.removeAttribute('aria-disabled'); el.setAttribute('aria-label', marker.options.title + '，按回车查看简介'); badge?.remove();
        }
      });
    }
    function editFormation(id) { if (!writable || locked() || draft) return; openPanel(); formationManager?.edit(id); }
    function removalButton(character, label) {
      const remove = button(label, () => removeCharacter(character.id)); remove.dataset.characterWrite = '';
      if (formationOf(character.id)) { remove.dataset.formationBlocked = ''; remove.title = '请先编辑或解散编队，再删除人物'; }
      remove.disabled = !writable || locked() || formationEditing() || !!formationOf(character.id); return remove;
    }
    function visibilityButton(character) {
      const toggle = button(character.hidden ? '恢复人物' : '隐藏人物', () => setHidden(character.id));
      toggle.dataset.characterWrite = ''; toggle.disabled = !writable || locked() || formationEditing();
      toggle.setAttribute('aria-label', `${character.hidden ? '恢复人物' : '隐藏人物'}：${character.name}`);
      return toggle;
    }
    let biographyLoading = false, biographyCandidates = [], biographyId = null, biographyName = '', biographyTimer = null, biographyController = null, biographySequence = 0;
    const genealogyClient = window.GENEALOGY_CLIENT;
    let genealogySession = null, genealogyLoadError = '';
    function refreshGenealogyPopup() {
      const current = characters.find(item => item.id === selectedId);
      if (current && map.hasLayer(popup)) popup.setContent(popupContent(current));
    }
    async function loadGenealogies() {
      if (!genealogyClient || !http) return;
      try { await genealogyClient.load(); genealogyLoadError = ''; }
      catch (failure) { genealogyLoadError = `${window.AtlasUI.text("共享谱系读取失败：")}${failure.message} 静态参考与已读取数据保留。`; }
      refreshGenealogyPopup();
    }
    function openGenealogy(character, opener) {
      if (personal) return;
      genealogySession?.close();
      const dialog = node('dialog', '', 'genealogy-dialog'), heading = node('h2', `新增家族谱系 · ${character.name}`);
      heading.id = 'genealogy-dialog-title'; dialog.setAttribute('aria-labelledby', heading.id);
      const notice = node('p', '先核对时代、身份和来源，再主动选择候选。网上导入未经过史料交叉核验；用户确认关联不代表历史身份已核实。', 'hint');
      notice.id = 'genealogy-dialog-notice'; dialog.setAttribute('aria-describedby', notice.id);
      const status = node('p'), choices = node('fieldset', '', 'genealogy-choices'), legend = node('legend', '选择真实身份（必选）'), results = node('div');
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); choices.append(legend, results);
      let sequence = 0, controller = null, candidateId = null, busy = false, finished = false, baseRevision = null;
      const session = { id: character.id, name: character.name, close, invalidate };
      const valid = () => genealogySession === session && dialog.open && characters.some(item => item.id === session.id && item.name === session.name);
      const tell = (text, failure = false) => { status.textContent = text; status.classList.toggle('territory-error', failure); };
      function controls() { choices.disabled = busy || finished; retry.disabled = busy || !http || finished; generate.disabled = busy || finished || !candidateId || baseRevision === null || !valid(); dialog.setAttribute('aria-busy', String(busy)); cancel.textContent = busy ? '取消等待并关闭' : '关闭'; }
      function close() {
        sequence++; controller?.abort();
        if (genealogySession === session) genealogySession = null;
        dialog.close(); dialog.remove();
        if (opener?.isConnected) opener.focus(); else { const marker = markers.get(anchorId(session.id))?.getElement(); if (marker) marker.focus(); else $('character-toggle').focus(); }
      }
      function invalidate() { sequence++; controller?.abort(); busy = false; finished = true; tell('当前人物已改名或删除。为避免关联错误，请关闭后从当前人物重新打开。', true); controls(); }
      async function search() {
        if (!valid()) return;
        const token = ++sequence; controller?.abort(); controller = new AbortController(); busy = true; candidateId = null; baseRevision = null; results.replaceChildren(); tell(window.AtlasUI.text('正在读取共享状态并检索人物来源…')); controls();
        try {
          const state = await genealogyClient.load();
          if (token !== sequence || !valid()) return;
          baseRevision = state.revision;
          const response = await genealogyClient.search(session.name, { signal: controller.signal });
          if (token !== sequence || !valid()) return;
          for (const candidate of response.candidates) {
            const item = node('section', '', 'genealogy-candidate'), label = node('label'), radio = node('input');
            radio.type = 'radio'; radio.name = 'genealogy-identity'; radio.value = candidate.candidateId;
            radio.addEventListener('change', () => { candidateId = radio.value; controls(); });
            label.append(radio, document.createTextNode(`${candidate.name} · ${candidate.identity || '来源未提供明确身份，请谨慎核对'}`)); item.append(label);
            let url; try { url = new URL(candidate.source.url); } catch { /* Show unsafe or malformed sources as text. */ }
            if (url && ['https:', 'http:'].includes(url.protocol)) { const link = node('a', `来源：${candidate.source.title}`); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
            else item.append(node('p', `来源：${candidate.source.title}（无可用链接）`));
            if (candidate.existingFamilyId) item.append(node('p', window.AtlasUI.text('已有共享谱系；确认后关联到此人物，不重复生成。'), 'hint'));
            results.append(item);
          }
          tell(`${response.candidates.length ? '请选择并核对一位候选；未选择不会保存。' : '未找到可用身份资料。可重试；没有来源支持时不会编造谱系。'} ${response.warnings.filter(value => typeof value === 'string').join(' ')}`);
        } catch (failure) { if (token === sequence && valid()) tell(`检索未完成：${failure.message} 请重试；现有人物与谱系不变。`, true); }
        finally { if (token === sequence && valid()) { busy = false; controls(); } }
      }
      async function save() {
        if (!valid() || busy || !candidateId || baseRevision === null) return;
        const token = ++sequence; controller = new AbortController(); busy = true; tell(window.AtlasUI.text('正在提取有来源的亲子关系并共享保存，请稍候…关闭只取消等待，服务端可能仍会完成保存。')); controls();
        try {
          const result = await genealogyClient.generate({ revision: baseRevision, characterId: session.id, characterName: session.name, candidateId }, { signal: controller.signal });
          if (token !== sequence || !valid()) return;
          finished = true; const link = node('a', '查看已保存家族谱系（定位当前人物）'); link.href = `genealogy.html?${new URLSearchParams({ family: result.familyId, person: result.personId })}`;
          const family = result.families.find(item => item.id === result.familyId);
          tell(`${window.AtlasUI.text("已共享保存，并建立用户确认关联（非历史身份核验）。 ")}${(family?.warnings || []).filter(value => typeof value === 'string').join(' ')}`); results.append(link); link.focus(); refreshGenealogyPopup();
        } catch (failure) {
          if (token !== sequence || !valid()) return;
          baseRevision = null;
          try { const state = await genealogyClient.load(); if (token === sequence && valid()) baseRevision = state.revision; } catch { /* Keep retry disabled until a successful explicit refresh. */ }
          if (token !== sequence || !valid()) return;
          tell(`${failure.status === 409 ? window.AtlasUI.text('共享版本或人物姓名已改变，未自动重试。') : `生成未确认成功：${failure.message}`} 已保留身份选择。${baseRevision === null ? window.AtlasUI.text('共享状态刷新失败，请重新检索。') : window.AtlasUI.text('已刷新共享版本，请核对人物与候选后再次点击“生成并共享保存”；如已保存，会关联已有谱系。')}`, true);
        } finally { if (token === sequence && valid()) { busy = false; controls(); } }
      }
      const retry = button('重新检索', search), generate = button(window.AtlasUI.text('生成并共享保存'), save), cancel = button('关闭', close), actions = node('div', '', 'territory-actions');
      generate.className = 'genealogy-generate'; actions.append(retry, generate, cancel); dialog.append(heading, notice, status, choices, actions);
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
      document.body.append(dialog); genealogySession = session; dialog.showModal(); cancel.focus(); controls();
      if (!http || !genealogyClient) tell(window.AtlasUI.text('需通过本地服务或局域网地址打开，才能检索并共享保存家族谱系。静态谱系参考仍可查看。'), true); else search();
    }
    const currentName = () => $('character-name').value.trim();
    const searchName = value => value.normalize('NFKC').trim().toLowerCase();
    const matchesName = (character, query) => searchName(character.name).includes(query);
    function sharedSearchState() {
      if (!http) return window.AtlasUI.text('文件模式无法读取共享人物，是否已创建尚未知。');
      if (loading) return loaded ? '正在刷新；以下仅为上次读取的记录，最新状态待确认。' : window.AtlasUI.text('正在读取共享人物，是否已创建尚未知。');
      if (!loaded) return writable ? window.AtlasUI.text('共享人物尚未读取，是否已创建尚未知。') : window.AtlasUI.text('共享人物尚未成功读取，请刷新后核对；是否已创建尚未知。');
      if (!writable) return window.AtlasUI.text('共享同步失败；以下仅为上次读取的记录，最新状态未知，请刷新后核对。');
      return window.AtlasUI.text('仅检索已读取的共享人物；可点击“刷新共享人物”核对最新记录。');
    }
    function renderSharedSearch() {
      const query = searchName($('character-search').value);
      let count = 0;
      $('character-records').querySelectorAll('[data-character-id]').forEach((row, index) => {
        const matches = matchesName(characters[index], query); row.hidden = !matches; if (matches) count++;
      });
      const state = sharedSearchState();
      $('character-search-status').textContent = `${loaded ? `匹配 ${count} / 共 ${characters.length}（已读取） · ` : ''}${state}`;
      $('character-search-clear').disabled = !$('character-search').value;
      const empty = $('character-records-empty');
      if (!empty) return;
      empty.hidden = count > 0;
      empty.textContent = !loaded ? state : loading || !writable ? `上次读取的记录中没有匹配项。${state}` : query ? window.AtlasUI.text('已读取的共享人物中没有姓名匹配项；可刷新核对，或继续新增人物。') : window.AtlasUI.text('尚无共享人物。点击“新增人物”创建。');
    }
    function renderDuplicateNotice() {
      const query = searchName(currentName()), visible = !!draft && !draft.id && !!query;
      $('character-duplicate-notice').hidden = !visible;
      if (!visible) { $('character-duplicate-matches').replaceChildren(); return; }
      const matches = characters.filter(character => matchesName(character, query));
      const exact = matches.filter(character => searchName(character.name) === query).length;
      $('character-duplicate-status').textContent = `${loaded ? `${window.AtlasUI.text("已读取的共享人物中，姓名匹配 ")}${matches.length} 位（同名 ${exact} 位）。` : ''}${sharedSearchState()} 同名不代表同一人，请核对身份；此提示不限制新增，也不替换简介或草稿。`;
      $('character-duplicate-matches').replaceChildren(...matches.map(character => {
        const formation = formationOf(character.id);
        const locate = button(`查看 ${character.name} · ${roleName(character.role)} · ${palette.get(character.polityId).name}${character.hidden ? ' · 已隐藏' : ''}${formation ? ` · ${formation.name}` : ''}`, () => focus(character.id, true));
        locate.disabled = locked() || placing || isTerritoryDrawing() || mapSelecting();
        return locate;
      }));
    }
    const originOf = character => character.biographyOrigin || (character.biographySource ? 'online' : 'legacy');
    const biographyReady = () => !!draft && !!currentName() && [...currentName()].length <= 60 && (draft.biographyMode === 'custom' || (draft.biographyMode === 'online' && !!biographyId && biographyName === currentName()) || (draft.biographyMode === 'keep' && draft.originalName === currentName()));
    function biographyStatus(value, failure = false) {
      $('character-biography-status').textContent = value; $('character-biography-status').classList.toggle('territory-error', failure);
    }
    function stopBiography() {
      clearTimeout(biographyTimer); biographyTimer = null; biographySequence++; biographyController?.abort(); biographyController = null; biographyLoading = false;
      $('character-biography-candidates').setAttribute('aria-busy', 'false');
    }
    function sourceContent(source, origin = 'online') {
      const body = node('div', '', 'character-biography-source');
      if (origin !== 'online' || !source) { body.append(node('p', origin === 'legacy' ? '旧版自填 · 来源未记录' : origin === 'custom' ? '用户自定义/修订（未核验）' : '尚未采用网上资料 · 可选择候选或直接自定义', 'hint')); return body; }
      body.append(node('p', '网上资料摘录', 'hint'));
      const label = [source.provider, source.bookTitle || source.title].filter(Boolean).join(' · ');
      let url; try { url = new URL(source.url); } catch { /* Keep invalid source URLs as plain text. */ }
      if (url && ['https:', 'http:'].includes(url.protocol)) { const link = node('a', `来源：${label || '公开资料'}（原文摘录）`); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link); }
      else body.append(node('p', `来源：${label || '公开资料'}（原文摘录）`));
      if (source.retrievedAt) body.append(node('p', `资料获取：${source.retrievedAt}`, 'hint'));
      body.append(node('p', source.notice || '史料身份及日期未交叉核验；摘要为来源原文摘录。', 'hint')); return body;
    }
    function showBiography(summary, source, origin = 'online') {
      $('character-biography').value = summary || ''; $('character-biography-source').replaceChildren(sourceContent(source, origin));
    }
    function useCustom(edited = false) {
      if (!draft || locked()) return;
      const wasOnline = draft.biographyMode !== 'custom';
      stopBiography(); biographyId = null; biographyName = ''; biographyCandidates = []; $('character-biography-candidates').replaceChildren();
      draft.biographyMode = 'custom';
      if (edited || wasOnline) draft.biographyOrigin = 'custom';
      if (!edited && wasOnline) $('character-biography').value = '';
      $('character-biography-source').replaceChildren(sourceContent(null, draft.biographyOrigin));
      biographyStatus('自定义模式 · 不自动联网；简介可留空，也可自由填写。姓名、角色、势力与选点均保留。'); controls();
    }
    function applyBiography(candidate) {
      if (!draft || biographyName !== currentName() || locked()) return;
      if (draft.biographyMode === 'custom' && $('character-biography').value && !confirm('采用网上候选将覆盖当前自填/修订简介。确认替换？')) return;
      stopBiography(); draft.biographyMode = 'online'; draft.biographyOrigin = 'online';
      biographyId = candidate.candidateId; showBiography(candidate.summary, candidate.source);
      $('character-biography-candidates').querySelectorAll('button').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.candidateId === biographyId)));
      biographyStatus(`已选择：${candidate.title}${candidate.identity ? ` · ${candidate.identity}` : ''}。请自行核对身份；编辑简介即改为用户修订。`); controls();
    }
    function renderBiographyCandidates() {
      $('character-biography-candidates').replaceChildren(...biographyCandidates.map(candidate => {
        const item = node('section', '', 'character-biography-candidate');
        const choose = button(`选择 ${candidate.title}${candidate.identity ? ` · ${candidate.identity}` : ''}`, () => applyBiography(candidate));
        choose.dataset.candidateId = candidate.candidateId; choose.setAttribute('aria-pressed', String(candidate.candidateId === biographyId));
        item.append(choose, node('p', candidate.summary, 'character-biography'), sourceContent(candidate.source)); return item;
      }));
    }
    async function lookupBiography() {
      if (personal || !draft || !http || locked()) return;
      const name = currentName(); stopBiography();
      if (!name || [...name].length > 60) { biographyStatus('请输入1—60字的人物姓名。'); controls(); return; }
      if (/[\p{C}<>\\/]/u.test(name)) { biographyStatus('此姓名不适用于网上检索；可直接选择自定义人物，不影响保存。'); controls(); return; }
      const sequence = biographySequence, controller = new AbortController(); biographyController = controller; biographyName = name; biographyLoading = true;
      $('character-biography-candidates').setAttribute('aria-busy', 'true'); biographyStatus('正在查找公开人物资料并提取短摘要…'); controls();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const response = await window.AtlasAPI.fetch(`/api/character-biographies?name=${encodeURIComponent(name)}`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
        let payload; try { payload = await response.json(); } catch { throw new Error('简介服务未返回有效数据，请重试。'); }
        if (!response.ok) throw new Error(payload.error || `简介查询失败（${response.status}），请稍后重试。`);
        if (!Array.isArray(payload.candidates) || payload.candidates.some(candidate => !candidate.candidateId || !candidate.title || !candidate.summary || !candidate.source)) throw new Error('简介候选格式不正确，请重试。');
        if (sequence !== biographySequence || !draft || currentName() !== name) return;
        biographyCandidates = payload.candidates;
        renderBiographyCandidates();
        biographyStatus(biographyCandidates.length ? `找到 ${biographyCandidates.length} 条资料，同名不代表同一人。请核对时代、身份与来源后主动选择；不匹配可直接自定义。现有简介未改变。` : '未找到可用资料。可直接自定义人物，简介允许留空；不会编造生平。', !biographyCandidates.length);
        const warnings = Array.isArray(payload.warnings) ? payload.warnings.filter(value => typeof value === 'string') : [];
        if (warnings.length) $('character-biography-status').append(document.createTextNode(` ${warnings.join(' ')}`));
      } catch (failure) {
        if (sequence === biographySequence && draft && currentName() === name) biographyStatus(`${controller.signal.aborted ? '简介查询超时，请重试。' : failure.message} 现有文字保留；可直接选择自定义人物，不受检索结果限制。`, true);
      } finally {
        clearTimeout(timeout);
        if (sequence === biographySequence) { biographyLoading = false; biographyController = null; $('character-biography-candidates').setAttribute('aria-busy', 'false'); controls(); }
      }
    }
    function nameChanged(event) {
      stopBiography(); biographyId = null; biographyName = ''; biographyCandidates = []; $('character-biography-candidates').replaceChildren();
      if (draft?.biographyMode === 'custom') { biographyStatus('自定义模式 · 姓名已更新，自填简介与选点保留，不自动联网。'); controls(); return; }
      const unchanged = draft?.id && draft.originalName === currentName();
      if (personal && draft && !unchanged) { draft.biographyMode = 'custom'; draft.biographyOrigin = 'custom'; biographyStatus('姓名已更新；原简介文字保留为用户修订，不联网。'); controls(); return; }
      if (draft) { draft.biographyMode = unchanged ? 'keep' : 'online'; draft.biographyOrigin = 'online'; }
      showBiography(unchanged ? draft.originalBiography : '', unchanged ? draft.originalSource : null);
      biographyStatus(unchanged ? '保留原简介；可直接保存其他修改，或主动检索候选。' : currentName() ? '自动辅助检索中；随时可选择自定义人物。' : '输入姓名可辅助检索，也可直接自定义人物。'); controls();
      if (currentName() && !unchanged && !event?.isComposing) biographyTimer = setTimeout(lookupBiography, 800);
    }
    const locked = () => loading || saving || dragging;
    function message(value, failure = false) {
      error = failure ? value : ''; $('character-status').textContent = value; $('character-status').classList.toggle('territory-error', failure);
      banner.textContent = value; banner.hidden = !value; banner.classList.toggle('territory-error', failure);
    }
    function controls() {
      $('character-name').setCustomValidity(draft && (!currentName() || [...currentName()].length > 60) ? '姓名去除首尾空白后须为1—60字。' : '');
      $('character-biography').setCustomValidity(draft?.biographyMode === 'custom' && [...$('character-biography').value].length > 3000 ? '自定义简介最多3000字。' : '');
      $('character-summary').textContent = !http ? window.AtlasUI.text('人物战棋 · 文件模式不支持共享') : `${loaded ? `${characters.length}${window.AtlasUI.text(" 位共享人物（已隐藏 ")}${characters.filter(character => character.hidden).length} 位） · ${formations.length} 支编队 · 版本 ${revision}` : window.AtlasUI.text('共享人物尚未读取')}${loading ? ' · 正在同步…' : saving ? ' · 正在保存…' : ''}`;
      $('character-fields').disabled = !writable || locked() || formationEditing(); $('character-new').disabled = !writable || locked() || formationEditing() || characters.length >= 500; $('character-refresh').disabled = !http || locked();
      $('character-save').disabled = !draft || draft.lon === null || draft.lat === null || !biographyReady(); $('character-place').hidden = !!draft?.id; $('character-place').disabled = !biographyReady(); $('character-close').disabled = saving;
      $('character-biography-custom').setAttribute('aria-pressed', String(draft?.biographyMode === 'custom'));
      $('character-biography-retry').disabled = personal || !http || !draft || !currentName() || biographyLoading; $('character-biography-retry').textContent = personal ? '个人版不提供在线简介检索' : biographyLoading ? '正在检索候选…' : '主动重新检索候选';
      $('character-biography-candidates').querySelectorAll('button').forEach(el => { el.disabled = biographyLoading; });
      document.querySelectorAll('[data-character-write]').forEach(el => { el.disabled = !writable || locked() || formationEditing() || el.hasAttribute('data-formation-blocked'); });
      markers.forEach(marker => { if (writable && !locked() && !draft && !formationEditing() && !isTerritoryDrawing()) marker.dragging.enable(); else marker.dragging.disable(); });
      formationManager?.render();
      syncSelection();
      renderSharedSearch(); renderDuplicateNotice();
    }
    function openPanel() {
      $('character-panel').hidden = false; $('character-toggle').setAttribute('aria-expanded', 'true'); document.body.classList.remove('sidebar-hidden'); $('toggle-sidebar').setAttribute('aria-expanded', 'true'); $('toggle-sidebar').textContent = '收起侧栏'; map.invalidateSize({ pan: false });
    }
    function endPlacement() { placing = false; preview.clearLayers(); map.getContainer().classList.remove('character-placing'); }
    function cancelDraft() { if (saving) return; stopBiography(); biographyId = null; biographyName = ''; biographyCandidates = []; $('character-biography-candidates').replaceChildren(); endPlacement(); draft = null; $('character-form').hidden = true; controls(); }
    function closePanel() { if (locked()) return; cancelDraft(); formationManager?.cancel(); $('character-panel').hidden = true; $('character-toggle').setAttribute('aria-expanded', 'false'); message(window.AtlasUI.text('未保存草稿已取消；共享记录未改变。')); }
    function readForm() {
      const character = { name: currentName(), role: $('character-role').value, polityId: $('character-polity').value, lon: draft.lon, lat: draft.lat, biographyMode: draft.biographyMode };
      if (draft.biographyMode === 'online') character.biographyId = biographyId;
      else if (draft.biographyMode === 'custom') {
        if (draft.id && draft.originalName === character.name && draft.biographyOrigin === 'legacy' && $('character-biography').value === draft.originalBiography) character.biographyMode = 'keep';
        else character.biography = $('character-biography').value;
      }
      return character;
    }
    function icon(character, formation = null) {
      const host = node('div', '', `character-piece ${formation ? 'character-army-standard' : `character-${character.role}`}`); host.style.setProperty('--character-color', palette.get(character.polityId).color);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 48 56'); svg.setAttribute('aria-hidden', 'true');
      const shape = document.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('class', 'character-shield'); shape.setAttribute('d', formation ? 'M8 8H44L36 20 44 32H8Z' : character.role === 'monarch' ? 'M24 5 44 17 44 40 24 53 4 40 4 17Z' : 'M44 32a20 20 0 1 1-40 0 20 20 0 1 1 40 0');
      const ornament = document.createElementNS(svg.namespaceURI, 'path'); ornament.setAttribute('class', formation ? 'character-standard-pole' : 'character-hat'); ornament.setAttribute('d', formation ? 'M8 4V52M2 52H16' : character.role === 'monarch' ? 'M10 15 8 4 18 9 24 1 30 9 40 4 38 15Z' : 'M14 15V7Q24 0 34 7V15M5 15H43');
      svg.append(shape, ornament); host.append(svg);
      if (!formation) host.append(node('span', character.role === 'monarch' ? '君' : '臣', 'character-role'));
      host.append(node('span', character.name, 'character-name'));
      return L.divIcon({ html: host, className: `character-marker ${formation ? 'formation-marker' : 'individual-character-marker'}`, iconSize: [48, 56], iconAnchor: [24, 48], popupAnchor: [0, -40] });
    }
    function popupContent(character) {
      const body = node('div', '', 'character-popup'); body.dataset.characterId = character.id;
      const formation = formationOf(character.id);
      if (formation) {
        const section = node('section', '', 'character-formation'), roster = node('ul'); section.setAttribute('aria-label', '编队成员');
        section.append(node('h4', `${formation.name} · ${formation.memberIds.length} 人`), node('p', '拖动主将军旗，整队保持队形移动；各自势力与身份不变。点击成员查看个人资料。', 'hint'));
        if (characters.find(member => member.id === formation.commanderId)?.hidden) section.append(node('p', '主将已隐藏，整队军旗暂不显示。编队与成员位置仍保留；恢复主将后军旗重新显示。', 'reference-note'));
        for (const id of formation.memberIds) {
          const member = characters.find(item => item.id === id); if (!member) continue;
          const item = node('li'); item.append(button(`${id === formation.commanderId ? '主将 · ' : ''}${member.name} · ${roleName(member.role)}${member.hidden ? ' · 已隐藏' : ''}`, () => focus(id, true))); roster.append(item);
        }
        const editGroup = button('编辑或解散编队', () => editFormation(formation.id)); editGroup.dataset.characterWrite = ''; editGroup.disabled = !writable || locked() || !!draft || formationEditing();
        section.append(roster, editGroup, node('p', '删除成员前，请先编辑或解散编队。解散不会删除人物。', 'hint')); body.append(section);
      }
      const selectFormation = button(formation ? '从地图编辑编队' : '从地图组建编队', () => formationManager?.startFromCharacter(character.id));
      selectFormation.dataset.characterWrite = ''; selectFormation.disabled = !writable || locked() || !!draft || formationEditing() || isTerritoryDrawing(); body.append(selectFormation);
      body.append(node('h3', character.name), node('p', `${roleName(character.role)} · ${palette.get(character.polityId).name}`), node('p', character.biography || '尚未填写自定义简介', 'character-biography'), node('p', '用户人物 · 位置跨年份固定，不是历史行踪推演。', 'hint'));
      if (character.hidden) body.append(node('p', '已隐藏 · 人物资料与保存位置保留；查看或编辑不会恢复地图显示。', 'reference-note'));
      body.append(sourceContent(character.biographySource, originOf(character)));
      const genealogyMatches = genealogyClient ? genealogyClient.getMatches(character) : typeof window.findGenealogyMatches === 'function' ? window.findGenealogyMatches(character) : [];
      if (genealogyMatches.length) {
        const section = node('section', '', 'character-genealogy'), candidates = node('ul');
        section.setAttribute('aria-label', '人物谱系参考');
        section.append(node('h4', genealogyMatches.length > 1 ? '人物谱系 · 身份候选' : '人物谱系'));
        for (const match of genealogyMatches) {
          const item = node('li'), link = node('a', `${match.familyName} · ${match.name}${match.identity ? ` · ${match.identity}` : ''}`);
          link.href = `genealogy.html?${new URLSearchParams({ family: match.familyId, person: match.personId })}`;
          item.append(link, node('p', match.matchKind === 'user-confirmed' ? '用户确认关联（非历史身份核验）' : '同名谱系参考，需核对身份', 'hint'));
          candidates.append(item);
        }
        section.append(candidates); body.append(section);
      }
      if (genealogyLoadError) body.append(node('p', genealogyLoadError, 'hint'));
      const addGenealogy = button(personal ? '个人版不支持自动生成家族' : '新增家族谱系', () => openGenealogy(character, addGenealogy)); addGenealogy.disabled = personal; body.append(addGenealogy);
      const actions = node('div', '', 'territory-actions'), edit = button('修改人物', () => editCharacter(character.id)), remove = removalButton(character, '删除人物');
      edit.dataset.characterWrite = ''; edit.disabled = !writable || locked() || formationEditing(); actions.append(edit, visibilityButton(character), remove); body.append(actions); return body;
    }
    function focus(id, locate = false) {
      if (placing || dragging || isTerritoryDrawing() || mapSelecting()) return; const character = characters.find(item => item.id === id); if (!character) return;
      const anchor = anchorCharacter(character);
      if (!character.hidden) { $('layer-characters').checked = true; layer.addTo(map); }
      if (locate) map.setView([anchor.lat, anchor.lon], Math.max(map.getZoom(), 6));
      markers.forEach((marker, key) => marker.setZIndexOffset(key === anchor.id ? 1000 : 0));
      selectedId = id; popup.setLatLng([anchor.lat, anchor.lon]).setContent(popupContent(character)).openOn(map);
    }
    function cancelDrag() {
      if (!activeDrag) return;
      const { marker, character } = activeDrag;
      // Disabling Leaflet can emit dragend synchronously; invalidate the move before cleanup.
      activeDrag = null; dragging = false;
      // MarkerDrag detaches its dragend cleanup before disabling the draggable.
      L.Util.cancelAnimFrame(marker.dragging._panRequest);
      marker.dragging.disable();
      marker.setLatLng([character.lat, character.lon]);
      controls(); message(window.AtlasUI.text('人物拖动已取消，已恢复共享保存的位置；可重新拖动。'));
    }
    function renderMarkers() {
      layer.clearLayers(); markers.clear();
      const selecting = mapSelecting();
      for (const character of characters) {
        const formation = formationOf(character.id);
        if (character.hidden || (!selecting && formation && formation.commanderId !== character.id)) continue;
        const tokenFormation = selecting ? null : formation, affiliation = formation ? ` · ${formation.name} · ${formation.commanderId === character.id ? '主将' : '成员'} · ${formation.memberIds.length}人编队` : '';
        const marker = L.marker([character.lat, character.lon], { pane: 'characters', icon: icon(character, tokenFormation), draggable: writable && !locked() && !draft && !formationEditing() && !isTerritoryDrawing(), keyboard: true, zIndexOffset: character.id === anchorId(selectedId) ? 1000 : 0, title: `${character.name} · ${roleName(character.role)} · ${palette.get(character.polityId).name}${affiliation}`, alt: `${character.name}，按回车查看简介和编队`, bubblingMouseEvents: false, autoPan: true });
        marker.on('click', () => { if (mapSelecting()) formationManager.toggleMember(character.id); else focus(character.id); }); marker.on('add', () => { const el = marker.getElement(); el.dataset.characterId = character.id; if (tokenFormation) el.dataset.formationId = tokenFormation.id; el.setAttribute('aria-label', marker.options.title + '，按回车查看简介和编队'); });
        marker.on('dragstart', () => {
          if (!writable || locked() || draft || formationEditing() || isTerritoryDrawing()) { marker.setLatLng([character.lat, character.lon]); marker.dragging.disable(); return; }
          activeDrag = { marker, character, revision };
          dragging = true; map.closePopup(popup); $('character-fields').disabled = true; $('character-new').disabled = true; $('character-refresh').disabled = true; $('character-close').disabled = true;
          document.querySelectorAll('[data-character-write]').forEach(el => { el.disabled = true; }); markers.forEach(other => { if (other !== marker) other.dragging.disable(); }); formationManager?.render();
          if (formation) message(`正在移动“${formation.name}”整队 ${formation.memberIds.length}${window.AtlasUI.text(" 人；松开后一次共享保存。")}`);
        });
        marker.on('dragend', async () => {
          if (activeDrag?.marker !== marker) return;
          const position = marker.getLatLng(), baseRevision = activeDrag.revision; activeDrag = null; dragging = false;
          const saved = await commit({ op: 'move', id: character.id, lon: position.lng, lat: position.lat }, baseRevision);
          if (!saved) render();
        });
        markers.set(character.id, marker); layer.addLayer(marker);
      }
    }
    function render() {
      renderMarkers();
      const records = characters.map(character => {
        const li = node('li'); li.dataset.characterId = character.id; li.append(button(`${character.hidden ? '查看 · ' : ''}${character.name} · ${roleName(character.role)} · ${palette.get(character.polityId).name}`, () => focus(character.id, true)));
        if (character.hidden) li.append(node('span', '已隐藏', 'reference-note'));
        const actions = node('div', '', 'territory-actions'), edit = button('编辑', () => editCharacter(character.id)), remove = removalButton(character, '删除'); edit.dataset.characterWrite = ''; actions.append(edit, visibilityButton(character), remove); li.append(actions);
        const formation = formationOf(character.id);
        if (formation) { const manage = button(`${formation.name} · ${formation.commanderId === character.id ? '主将' : '成员'} · 编辑编队`, () => editFormation(formation.id)); manage.dataset.characterWrite = ''; li.append(manage, node('p', '请先编辑或解散编队，再删除人物。', 'hint')); }
        return li;
      });
      const empty = node('li'); empty.id = 'character-records-empty';
      $('character-records').replaceChildren(...records, empty);
      if (selectedId) { const current = characters.find(item => item.id === selectedId); if (current && map.hasLayer(popup)) { const anchor = anchorCharacter(current); popup.setLatLng([anchor.lat, anchor.lon]).setContent(popupContent(current)); } else if (!current) { selectedId = null; map.closePopup(popup); } } controls();
    }
    function accept(payload) {
      if (!Number.isInteger(payload.revision) || !Array.isArray(payload.characters) || payload.characters.some(item => !palette.has(item.polityId) || !['monarch', 'minister'].includes(item.role)) || !Array.isArray(payload.formations)) throw new Error(window.AtlasUI.text('共享人物响应格式不正确，未替换当前记录。'));
      const nextMemberships = new Map(), ids = new Set(payload.characters.map(item => item.id));
      for (const formation of payload.formations) {
        if (!formation || typeof formation.id !== 'string' || typeof formation.name !== 'string' || !Array.isArray(formation.memberIds) || formation.memberIds.length < 2 || !formation.memberIds.includes(formation.commanderId)) throw new Error(window.AtlasUI.text('共享编队响应格式不正确，未替换当前记录。'));
        for (const id of formation.memberIds) { if (!ids.has(id) || nextMemberships.has(id)) throw new Error(window.AtlasUI.text('共享编队成员不正确，未替换当前记录。')); nextMemberships.set(id, formation); }
      }
      characters = payload.characters; formations = payload.formations; memberships.clear(); nextMemberships.forEach((value, key) => memberships.set(key, value)); revision = payload.revision; loaded = true; writable = true; render();
      if (genealogySession && !characters.some(item => item.id === genealogySession.id && item.name === genealogySession.name)) genealogySession.invalidate();
    }
    async function request(options) {
      const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 25000);
      try {
        const response = await window.AtlasAPI.fetch('/api/characters', { cache: 'no-store', credentials: 'same-origin', ...options, signal: timeout.signal }); let payload;
        try { payload = await response.json(); } catch (failure) { if (timeout.signal.aborted) throw failure; throw new Error(window.AtlasUI.text('人物服务未返回有效数据，请检查服务器后刷新。')); }
        if (!response.ok) { const failure = new Error(typeof payload.error === 'string' ? payload.error : `人物请求失败（${response.status}）`); failure.status = response.status; throw failure; } return payload;
      } catch (failure) {
        if (timeout.signal.aborted) throw new Error('人物请求超时，请检查网络后刷新重试。');
        throw failure;
      } finally { clearTimeout(timer); }
    }
    async function load() {
      if (!http || locked()) return; loading = true; controls(); const previous = revision;
      try { accept(await request()); message(draft ? `${window.AtlasUI.text("共享人物已刷新")}${previous !== revision ? window.AtlasUI.text('，远端版本已改变') : ''}；你的未保存草稿和位置已保留，保存时会核对原版本。` : window.AtlasUI.text('共享人物已同步。')); }
      catch (failure) { writable = false; message(`${failure.message} 已显示人物保留；请刷新重试。`, true); }
      finally { loading = false; controls(); }
    }
    async function commit(operation, baseRevision) {
      if (!writable || locked() || (operation.op.startsWith('formation-') ? !!draft || placing || isTerritoryDrawing() : formationEditing())) { message('请先完成当前编辑或移动，再保存。', true); return false; } saving = true; controls(); message(window.AtlasUI.text('正在保存共享人物，请稍候…'));
      try {
        accept(await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: baseRevision, ...operation }) }));
        if (operation.op === 'add' || operation.op === 'update' || (operation.op === 'remove' && draft?.id === operation.id)) { saving = false; cancelDraft(); } message(window.AtlasUI.text('人物已共享保存。其他浏览器聚焦窗口或点击刷新即可同步。'));
        return true;
      } catch (failure) {
        let synchronized = false; try { accept(await request()); synchronized = true; } catch { writable = false; render(); }
        if (failure.status === 409 && draft && synchronized) {
          draft.revision = revision;
          const current = draft.id ? characters.find(item => item.id === draft.id) : null;
          if (current) { draft.lon = current.lon; draft.lat = current.lat; }
          $('character-position').textContent = `${current ? window.AtlasUI.text('沿用远端最新位置') : '位置草稿保留'}：${draft.lon === null ? '尚未选点' : `${draft.lon.toFixed(5)}°，${draft.lat.toFixed(5)}°`}；姓名和简介选择保留，请核对后重试。`;
        }
        message(failure.status === 409 ? `${window.AtlasUI.text("共享人物已被其他浏览器修改，本次未保存。")}${synchronized ? window.AtlasUI.text('已同步共享记录；姓名与简介选择保留。编辑人物沿用远端最新位置，新建人物保留选点，请核对后再次保存。') : '同步失败；草稿保留，请刷新后重试。'}` : `${failure.message} 本次未确认保存；${synchronized ? window.AtlasUI.text('已同步服务器最新状态。') : window.AtlasUI.text('请刷新核实服务器状态。')}草稿保留。`, true);
        return false;
      } finally { saving = false; controls(); }
    }
    function startDraft(character = null) {
      if (!writable || locked() || formationEditing()) return; if (draft && !confirm('放弃当前未保存的人物草稿？')) return;
      stopBiography(); biographyId = null; biographyName = ''; biographyCandidates = []; $('character-biography-candidates').replaceChildren();
      endPlacement(); draft = { id: character?.id || null, originalName: character?.name || '', originalBiography: character?.biography || '', originalSource: character?.biographySource || null, biographyMode: character ? originOf(character) === 'online' ? 'keep' : 'custom' : personal ? 'custom' : 'online', biographyOrigin: character ? originOf(character) : personal ? 'custom' : 'online', lon: character?.lon ?? null, lat: character?.lat ?? null, revision };
      $('character-name').value = character?.name || ''; $('character-role').value = character?.role || 'monarch'; $('character-polity').value = character?.polityId || ''; $('character-biography').value = character?.biography || '';
      showBiography(draft.originalBiography, draft.originalSource, draft.biographyOrigin); biographyStatus(personal && !character ? '个人版自定义人物，不联网；简介可留空。' : character ? draft.biographyMode === 'custom' ? '自填简介自由编辑，姓名变化不会联网或清除文字。' : '保留网上原简介；直接编辑会改为用户修订。修改角色、势力无需联网。' : '自动检索仅作辅助，同名需核对；未收录或结果不符可直接自定义，简介可留空。');
      $('character-form-title').textContent = character ? `编辑人物 · 保留当前位置${character.hidden ? ' · 已隐藏（保存不会恢复显示）' : ''}` : '新增人物 · 尚未保存'; $('character-form').hidden = false;
      $('character-position').textContent = character ? `保留位置：${character.lon.toFixed(5)}°，${character.lat.toFixed(5)}°；编辑期间暂停拖拽，保存或取消后可移动。` : personal ? '尚未选择位置：输入姓名、选择势力后在地图点选。' : '尚未选择位置：确认网上候选或选择自定义模式，再选择势力并在地图点选。';
      openPanel(); map.closePopup(popup); controls(); $('character-form').scrollIntoView({ block: 'nearest' }); $('character-name').focus();
    }
    function editCharacter(id) { const character = characters.find(item => item.id === id); if (character) startDraft(character); }
    function setHidden(id) {
      if (!writable || locked() || formationEditing()) return;
      const character = characters.find(item => item.id === id); if (!character) return;
      const formation = formationOf(id), hidden = !character.hidden;
      if (hidden && formation?.commanderId === id && !confirm(`隐藏主将“${character.name}”后，“${formation.name}”整队军旗将暂时从地图消失。编队、成员位置与资料不会删除，也不会更换主将；恢复此人物后军旗重新显示。确认隐藏？`)) return;
      commit({ op: 'set-hidden', id, hidden }, revision);
    }
    function removeCharacter(id) {
      if (!writable || locked() || formationEditing()) return; const character = characters.find(item => item.id === id); if (!character) return;
      if (formationOf(id)) { message('请先编辑或解散编队，再删除人物。', true); editFormation(formationOf(id).id); return; }
      if (confirm(`删除人物“${character.name}${window.AtlasUI.text("”？此操作会同步到所有局域网浏览器。")}`)) commit({ op: 'remove', id }, revision);
    }
    function place(event) {
      if (!placing || !draft || locked() || mapSelecting() || !biographyReady() || isTerritoryDrawing()) return;
      const lon = event.latlng.wrap().lng, lat = event.latlng.lat; if (lat < -85 || lat > 85) { message('请选择纬度 -85° 至 85° 内的位置。', true); return; }
      draft.lon = lon; draft.lat = lat; preview.clearLayers(); L.marker([lat, lon], { pane: 'characterPreview', icon: icon(readForm()), interactive: false, keyboard: false, opacity: .7 }).addTo(preview);
      $('character-position').textContent = `未保存预览：${lon.toFixed(5)}°，${lat.toFixed(5)}°。可继续点选调整；确认后才保存。`; controls(); message(window.AtlasUI.text('位置仅为预览。请回到人物表单确认并共享保存，Esc 可取消。'));
    }
    polities.forEach(polity => { const option = node('option', polity.name); option.value = polity.id; $('character-polity').append(option); });
    $('character-toggle').addEventListener('click', () => { if ($('character-panel').hidden) openPanel(); else closePanel(); }); $('character-close').addEventListener('click', closePanel);
    $('character-new').addEventListener('click', () => startDraft()); $('character-refresh').addEventListener('click', load);
    $('character-search').addEventListener('input', renderSharedSearch);
    $('character-search').addEventListener('search', renderSharedSearch);
    $('character-search-clear').addEventListener('click', () => { $('character-search').value = ''; renderSharedSearch(); $('character-search').focus(); });
    $('character-name').addEventListener('input', nameChanged); $('character-name').addEventListener('compositionend', nameChanged);
    $('character-biography-retry').addEventListener('click', lookupBiography);
    $('character-biography-custom').addEventListener('click', () => useCustom());
    $('character-biography').addEventListener('input', () => useCustom(true));
    $('character-cancel').addEventListener('click', () => { cancelDraft(); message(window.AtlasUI.text('已取消人物草稿，未新增或修改共享人物。')); });
    $('character-place').addEventListener('click', () => {
      if (!draft || locked() || mapSelecting() || !$('character-form').reportValidity()) return; if (!biographyReady()) { message('请确认网上候选，或选择自定义人物（简介可留空）。', true); return; }
      if (isTerritoryDrawing()) { message('请先完成或取消疆域绘制，再放置人物。', true); return; }
      placing = true; map.closePopup(); map.getContainer().classList.add('character-placing'); controls(); message('请在地图点击放置预览；可平移缩放，确认保存前不会新增。'); map.getContainer().scrollIntoView({ block: 'nearest' });
    });
    $('character-form').addEventListener('submit', event => {
      event.preventDefault(); if (!draft || draft.lon === null || draft.lat === null || !$('character-form').reportValidity()) return;
      const character = readForm(); if (!character.name || !biographyReady()) { message('请填写姓名，并确认网上候选或选择自定义人物。', true); return; }
      stopBiography();
      commit(draft.id ? { op: 'update', id: draft.id, character } : { op: 'add', character }, draft.revision);
    });
    $('layer-characters').addEventListener('change', () => { if ($('layer-characters').checked) { layer.addTo(map); controls(); } else { map.removeLayer(layer); map.closePopup(popup); } });
    map.on('click', place); map.on('popupclose', event => { if (event.popup === popup) selectedId = null; });
    // A second mouse button resets Leaflet's moved flag, so its dragend may never fire.
    document.addEventListener('mousedown', event => { if (event.button !== 0) cancelDrag(); }, true);
    document.addEventListener('contextmenu', cancelDrag, true);
    document.addEventListener('pointercancel', cancelDrag, true);
    document.addEventListener('touchcancel', cancelDrag, true);
    window.addEventListener('blur', cancelDrag);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !saving) { if (formationEditing()) { formationManager.cancel(); message('已取消编队草稿。'); } else if (draft) { cancelDraft(); message('已取消人物草稿与临时棋子。'); } } });
    $('territory-draw').addEventListener('click', event => { if (mapSelecting()) { event.preventDefault(); event.stopImmediatePropagation(); message('请先完成地图选人或取消编队草稿，再绘制疆域。', true); return; } if (placing) { endPlacement(); if (draft) { draft.lon = null; draft.lat = null; $('character-position').textContent = '人物放置已取消；请结束疆域绘制后重新选点。'; } controls(); message('已取消人物放置，保留文字草稿；疆域绘图优先。'); } }, true);
    new MutationObserver(() => { if (!dragging) controls(); }).observe(map.getContainer(), { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('genealogy-updated', refreshGenealogyPopup);
    formationManager = window.createFormationManager({ getState: () => ({ characters, formations, revision, writable, busy: locked() || !!draft || placing || isTerritoryDrawing() }), commit, focusCharacter: id => focus(id, true), message });
    document.addEventListener('formation-editing-changed', controls);
    document.addEventListener('formation-selection-changed', controls);
    map.on('popupopen', () => { if (mapSelecting()) map.closePopup(); });
    function formationState() {
      const visibleFormationIds = [], visibleIndividualIds = [];
      markers.forEach((marker, id) => { const formation = formationOf(id); if (formation && !mapSelecting()) visibleFormationIds.push(formation.id); else visibleIndividualIds.push(id); });
      return { hiddenCount: characters.reduce((count, character) => count + Number(!!character.hidden), 0), visibleMarkerCount: markers.size, visibleFormationCount: visibleFormationIds.length, visibleIndividualCount: visibleIndividualIds.length, visibleFormationIds, visibleIndividualIds, visibleMarkerIds: [...markers.keys()], formationSelection: selectionState(), formationEditing: formationEditing(), formations: formations.map(formation => ({ ...formation, memberIds: [...formation.memberIds], members: formation.memberIds.map(id => { const member = characters.find(item => item.id === id), position = markers.get(id)?.getLatLng(); return { id, name: member.name, role: member.role, polityId: member.polityId, hidden: !!member.hidden, isCommander: id === formation.commanderId, lon: member.lon, lat: member.lat, markerVisible: markers.has(id), markerLon: position?.lng ?? member.lon, markerLat: position?.lat ?? member.lat }; }) })) };
    }
    window.addEventListener('focus', loadGenealogies); loadGenealogies();
    window.addEventListener('focus', load); $('character-offline').hidden = http; render(); if (http) load(); else message(window.AtlasUI.text('文件模式不读取或写入共享人物，请通过局域网地址打开。'));
    return { getState: () => ({ ...formationState(), loaded, writable, count: characters.length, revision, loading, placing, dragging, saving, selectedId, draftId: draft ? draft.id || 'new' : null, draftRevision: draft?.revision ?? null, biographyMode: draft?.biographyMode ?? null, biographyOrigin: draft?.biographyOrigin ?? null, biographyLoading, biographyCandidateCount: biographyCandidates.length, biographyId, biographyName, biographyReady: biographyReady(), biographyStatus: $('character-biography-status').textContent, draftName: draft ? currentName() : null, draftPosition: draft ? { lon: draft.lon, lat: draft.lat } : null, previewVisible: preview.getLayers().length > 0, layerVisible: map.hasLayer(layer), error, year: getYear(), positions: characters.map(character => ({ id: character.id, name: character.name, hidden: !!character.hidden, lon: character.lon, lat: character.lat, role: character.role, polityId: character.polityId, formationId: formationOf(character.id)?.id ?? null, isCommander: formationOf(character.id)?.commanderId === character.id, biography: character.biography, biographyOrigin: originOf(character), biographySource: originOf(character) === 'online' ? character.biographySource || null : null, color: palette.get(character.polityId).color })) }) };
  };
})();
