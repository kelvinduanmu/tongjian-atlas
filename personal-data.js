(() => {
  'use strict';
  const personal = window.AtlasAPI.mode === 'personal';
  // Only authored UI literals pass through this helper; never user names, notes or imported content.
  const replacements = [
    ['所有局域网浏览器共享', '仅本机浏览器保存'], ['所有局域网浏览器', '本机同站点标签页'],
    ['所有局域网客户端', '本机同站点标签页'], ['无登录，仅限可信局域网。', '仅保存于本机浏览器，不会上传。'],
    ['其他浏览器', '本机同站点其他标签页'], ['局域网 HTTP 地址', 'HTTP/HTTPS 地址'],
    ['局域网地址', 'HTTP/HTTPS 地址'], ['局域网入口', 'HTTP/HTTPS 页面'],
    ['服务器', '本机浏览器存储'], ['服务端', '本机存储事务'], ['远端', '本机存储'],
    ['他人修改', '其他标签页修改'], ['仅限可信局域网使用。', '个人资料不会上传。'], ['共享', '个人副本'],
  ];
  const text = value => personal ? replacements.reduce((result, [from, to]) => result.replaceAll(from, to), value) : value;
  window.AtlasUI = Object.freeze({ personal, text });

  function initialize() {
    // Translate the initial authored markup once, before clients populate user records.
    if (personal) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('script, style')) nodes.push(walker.currentNode);
      for (const node of nodes) node.nodeValue = text(node.nodeValue);
      for (const element of document.querySelectorAll('[aria-label], [title]')) {
        for (const attribute of ['aria-label', 'title']) if (element.hasAttribute(attribute)) element.setAttribute(attribute, text(element.getAttribute(attribute)));
      }
      for (const link of document.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href');
        if (/^(?:image-atlas|audit)\.html(?:[?#]|$)/.test(href)) {
          link.href = href.startsWith('audit') ? 'sources.html#audit' : 'sources.html';
          link.textContent = href.startsWith('audit') ? '核查报告未随公开版发布 · 查看说明' : '原图来源与发布说明';
        }
      }
      for (const id of ['character-offline', 'annotation-offline', 'territory-offline']) {
        const note = document.getElementById(id);
        if (note) note.textContent = 'file:// 仅供只读浏览。请通过 HTTP/HTTPS 打开此站点，以使用本机个人副本；不同地址的浏览器存储不互通。';
      }
      const biographyHint = document.getElementById('character-biography-status');
      if (biographyHint) biographyHint.textContent = '个人版不提供在线简介检索；可直接自定义人物，简介允许留空。';
      const scope = document.getElementById('annotation-scope');
      if (scope) for (const option of scope.options) option.textContent = ({ auto: '内置历史地点与水系', historical: '仅内置历史资料', modern: '仅内置现代水系定位' })[option.value];
      const searchHint = document.querySelector('.annotation-section .reference-note');
      if (searchHint) searchHint.textContent = '仅搜索随站点提供的本地地名资料，不联网补全。选择候选后请核对位置和年代；现代定位不代表古治所。';
    }
    const section = document.createElement('section');
    section.className = 'personal-data'; section.setAttribute('aria-labelledby', 'personal-data-title');
    const heading = document.createElement('h2'); heading.id = 'personal-data-title';
    heading.textContent = personal ? '本机浏览器个人副本' : 'Python 共享版';
    const note = document.createElement('p');
    note.textContent = personal ? '修改仅存于当前浏览器、当前站点，不会上传或自动发布到 GitHub。清除站点数据、无痕窗口关闭或浏览器回收存储会丢失修改，请定期导出备份。在线人物简介与自动家族生成不可用；自定义人物、静态谱系和已导入谱系仍可使用。' : '当前修改由 Python 服务共享保存。个人副本的导入/导出仅在个人版提供，不会自动上传私人数据；请由服务管理员管理共享数据备份。';
    const actions = document.createElement('div'); actions.className = 'personal-data-actions';
    const source = document.createElement('a'); source.href = 'sources.html'; source.textContent = '资料来源与发布范围'; actions.append(source);
    const status = document.createElement('p'); status.id = 'personal-data-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    section.append(heading, note, actions, status);
    document.querySelector('.masthead')?.after(section);
    if (!personal) return;
    const download = document.createElement('button'); download.type = 'button'; download.textContent = '导出个人副本 JSON';
    const label = document.createElement('label'); label.htmlFor = 'personal-import'; label.textContent = '导入备份并替换个人副本';
    const input = document.createElement('input'); input.id = 'personal-import'; input.type = 'file'; input.accept = '.json,application/json'; input.setAttribute('aria-describedby', status.id);
    actions.prepend(download, label, input);
    const unavailable = !/^https?:$/.test(location.protocol);
    const busy = value => { download.disabled = input.disabled = value || unavailable; section.setAttribute('aria-busy', String(value)); };
    const report = (message, error = false) => { status.textContent = message; status.classList.toggle('territory-error', error); };
    busy(false);
    if (unavailable) report('file:// 只读：请通过 HTTP/HTTPS 打开站点后使用个人存储和备份。', true);
    download.addEventListener('click', async () => {
      busy(true); report('正在读取个人副本…');
      try {
        const data = await window.AtlasAPI.exportData();
        const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `tongjian-atlas-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        report('已生成下载文件，请确认浏览器已保存。备份含个人资料，请自行保管，不要提交到公开仓库。');
      } catch (error) { report(`导出失败：${error.message}`, true); }
      finally { busy(false); }
    });
    input.addEventListener('change', async () => {
      const file = input.files[0]; if (!file) return;
      if (file.size > 16 * 1024 * 1024) { report('导入被拒绝：文件不能超过 16 MiB；当前副本未改变。', true); input.value = ''; return; }
      if (!confirm('导入将完整替换当前站点的个人副本（人物、编队、标注、疆域、显示年代、谱系），不是合并。未保存草稿将丢失。建议先导出备份。确认替换？')) { input.value = ''; return; }
      busy(true); report('正在验证并原子替换个人副本，请勿关闭页面…');
      try {
        await window.AtlasAPI.importData(await file.text());
        report('个人副本已替换，正在保留当前地址刷新页面…');
        location.reload();
      } catch (error) { report(`导入失败，当前副本未被替换：${error.message}`, true); }
      finally { input.value = ''; busy(false); }
    });
  }
  // Deferred script executes after markup parsing and before deferred clients.
  initialize();
})();
