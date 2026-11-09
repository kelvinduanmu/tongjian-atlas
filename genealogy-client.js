(() => {
  'use strict';
  let state = null, pendingLoad = null;
  const http = /^https?:$/.test(location.protocol);
  async function request(path, { signal, timeout = 25000, ...options } = {}) {
    if (!http) throw new Error(window.AtlasUI.text('文件模式无法读取或保存共享谱系，请通过本地服务或局域网地址打开；静态谱系仍可查看。'));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeout);
    try {
      const response = await window.AtlasAPI.fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      let payload;
      try { payload = await response.json(); } catch { throw new Error('谱系服务未返回有效数据，请检查服务后重试。'); }
      if (!response.ok) { const failure = new Error(typeof payload.error === 'string' ? payload.error : `谱系请求失败（${response.status}）`); failure.status = response.status; throw failure; }
      return payload;
    } catch (failure) {
      if (controller.signal.aborted) { const error = new Error(signal?.aborted ? '已取消请求。' : window.AtlasUI.text('谱系请求超时，请刷新共享状态后重试；保存请求可能仍在服务端完成。')); error.name = signal?.aborted ? 'AbortError' : 'TimeoutError'; throw error; }
      throw failure;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function accept(payload) {
    if (!payload || !Number.isInteger(payload.revision) || !Array.isArray(payload.families) || !Array.isArray(payload.links)
      || payload.families.some(family => typeof family.id !== 'string' || !family.id.startsWith('family-') || typeof family.name !== 'string' || !Array.isArray(family.people) || !Array.isArray(family.relationships) || !Array.isArray(family.sources))) throw new Error(window.AtlasUI.text('共享谱系格式不正确，已保留原有数据。'));
    if (!state || payload.revision >= state.revision) {
      state = { revision: payload.revision, families: payload.families, links: payload.links };
      window.dispatchEvent(new CustomEvent('genealogy-updated', { detail: state }));
    }
    return state;
  }
  function load() {
    if (!pendingLoad) pendingLoad = request('/api/genealogies').then(accept).finally(() => { pendingLoad = null; });
    return pendingLoad;
  }
  async function search(name, { signal } = {}) {
    const result = await request(`/api/genealogy-search?${new URLSearchParams({ name })}`, { signal, timeout: 45000 });
    if (!result || result.name !== name || !Array.isArray(result.candidates) || !Array.isArray(result.warnings) || result.candidates.some(candidate => typeof candidate.candidateId !== 'string' || typeof candidate.name !== 'string' || !candidate.source || typeof candidate.source.title !== 'string' || typeof candidate.source.url !== 'string')) throw new Error('谱系候选格式不正确，请重新检索。');
    return result;
  }
  async function generate(payload, { signal } = {}) {
    const result = await request('/api/genealogies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'generate', revision: payload.revision, characterId: payload.characterId, characterName: payload.characterName, candidateId: payload.candidateId }), timeout: 90000, signal });
    if (typeof result.familyId !== 'string' || typeof result.personId !== 'string') throw new Error(window.AtlasUI.text('保存响应缺少谱系定位，请刷新共享数据后确认结果。'));
    accept(result); return result;
  }
  function getMatches(character) {
    const matches = new Map();
    const key = match => `${match.familyId}/${match.personId}`;
    for (const match of window.findGenealogyMatches?.(character) || []) matches.set(key(match), { ...match });
    const name = character.name.normalize('NFC').trim();
    for (const family of state?.families || []) {
      for (const person of family.people) {
        const linked = state.links.some(link => link.characterId === character.id && link.characterName === character.name && link.familyId === family.id && link.personId === person.id);
        if (!linked && ![person.name, ...(person.aliases || [])].some(value => typeof value === 'string' && value.normalize('NFC').trim() === name)) continue;
        const match = { familyId: family.id, familyName: family.name, personId: person.id, name: person.name, identity: person.identity, matchKind: linked ? 'user-confirmed' : 'exact-name' };
        matches.set(key(match), match);
      }
    }
    return [...matches.values()];
  }
  window.GENEALOGY_CLIENT = { load, search, generate, getState: () => state, getMatches };
})();
