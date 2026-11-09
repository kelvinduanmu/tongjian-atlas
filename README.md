# 通鉴地图 · Tongjian Atlas

东晋十六国（304—439）的历史地理阅读与推演工具。提供 **GitHub Pages 个人版** 与 **Python 可信局域网共享版**，不需要自建公网 API 才能使用个人版。

> **数据不是全部开源/商业可用。** 项目原创代码采用 [MIT](LICENSE)，CHGIS 历史地名保留 **CC BY-NC 4.0 非商业条件**，其他资料各守其许可。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。疆域是来源支持的手绘区域概略重建，不是精确古界；不得把代码 MIT 扩展到地图资料、扫描、引用站点或用户内容。

## 两种运行方式

| | Pages / 普通静态 HTTP：个人版 | Python：共享版 |
| --- | --- | --- |
| 保存位置 | 本机浏览器 IndexedDB | 服务器公开目录以外的 JSON 保存目录 |
| 其他访问者 | 各自独立，不会看到你的修改 | 同一服务的用户共同读取和修改 |
| 人物、军阵、隐藏、移动、疆域、地点年代 | 本机保存；人物可手写或保留已有简介 | 共享保存，保留既有 API 行为 |
| 地点检索 | 已随站点提供的真实地点/河湖数据；不调用外部地名 API | 可使用历史资料和现代地点服务 |
| 在线短传 / 自动谱系 | 不可用，明确说明；不伪造检索结果 | 短传可请求真实提供方；谱系需可选本地索引与可用上游 |
| 人工选录 / 已保存谱系 | 可阅读，合法备份可导入 | 可阅读与共享保存 |

`atlas-config.js` 默认个人模式；只有 Python 服务对**精确的 `/atlas-config.js` 路径**返回共享配置（`Cache-Control: no-store`）。共享服务网络失败不会自动切换成个人副本。浏览器中各模块显式使用 `AtlasAPI.fetch`，不替换全局 `fetch`。Pages 的 `/仓库名/` 子路径受支持，个人 API 不请求域名根目录 `/api`。

## 本地使用个人版

要求 Python 3.10+；无需 npm、数据库服务或第三方 Python 包：

```sh
python3 scripts/build_pages.py
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

访问 `http://127.0.0.1:8000/`。双击 `file://` 文件只适合有限的只读浏览；可靠编辑请通过 HTTP 或 HTTPS 打开。

构建使用精确资源白名单，而非复制整个工作目录。输出 `dist/`、`.nojekyll` 与 `dist/build-report.json`（逐文件字节数、SHA-256、排除清单）。HTML 中本地资源使用各自内容哈希，避免版本混装；本地 HTML/CSS 引用必须在白名单中且不能指向域名根路径。单文件上限16 MiB，正文总量上限32 MiB。默认不发布 Python、私有保存、原图、OCR、原始报告或传记摘录。

`scripts/prepare_publication.py` 仅处理它所在的公开副本：移除未分发地形/历史瓦片引用，把地图目录缩减为来源页链接，说明原始报告缺失。已准备好的源码不依赖原部署路径；CI 不读取原项目，也不下载资料或运行私有数据迁移。

### 个人存储、备份与离线边界

页面明确标示 **“本机浏览器个人副本”**。同一来源与页面目录共享同一 IndexedDB，地图与谱系页共享数据；不同仓库子目录隔离。HTTP 与 HTTPS、不同域名/端口、不同浏览器或隐私窗口是不同副本。改站点地址前先导出。

- 使用页面中的“导出个人数据”保存 JSON 备份；其格式标识为 `tongjian-atlas-personal`、版本1，包含人物/军阵、地点标注、疆域编辑、地点年代与已保存谱系。
- 导入需明确确认，严格校验全部内容后一次性替换；无效备份不会部分写入。导入不是合并，导入前先导出当前副本。每个存储的修订号都会推进，旧标签页操作应刷新后重试。
- 浏览器清理站点数据、隐私窗口退出、空间不足或浏览器回收均可能影响保存。存储被禁用/额度不足会显示错误，不会假装已保存到内存。请定期导出，别把浏览器当唯一备份。
- 编辑不需要服务器 API；页面资源加载后可继续使用本地数据。**未提供 Service Worker，不保证断网后首次打开或重新加载 Pages 能成功。** 要可靠离线打开，请保存公开构建包并在本机运行上述 HTTP 服务。外部出处链接仍需联网。
- 导出可能包含私人备注、传记摘录或受限来源数据。不要上传仓库，也不要把“能导出”理解为“可公开再分发”。

## 发布到 GitHub Pages（不需要自定义域名）

1. 在 GitHub 网页创建一个 **public** 空仓库，例如 `tongjian-atlas`。先确认自己有权发布所选材料，并接受资料的非商业条件。不要上传原私有部署目录。
2. 将此公开源码副本提交到仓库的 `main` 分支。`.gitignore` 是默认拒绝的源码白名单：新文件要审查后显式加入；不要使用 `git add -f` 绕过数据排除。不要通过压缩整个工作目录的方式上传，因为忽略文件仍可能留在本地。
3. 仓库 **Settings → Pages → Build and deployment → Source → GitHub Actions**。
4. 推送 `main`，或在 Actions 中手动运行 **Deploy personal atlas to GitHub Pages**。工作流使用官方 checkout/configure-pages/setup-python/upload-pages-artifact/deploy-pages actions，只上传 `dist/`。
5. 等待部署完成，访问 Actions 输出的 `https://<账号>.github.io/<仓库名>/`。无需 CNAME 或域名购买。工作流只需要 `contents: read`、`pages: write`、`id-token: write`，使用 GitHub 自动签发的短期身份，不需要向仓库 Secrets 添加个人 token。

### 首次上传与最小权限 token

可用 Git/SSH 或安装 [GitHub CLI 官方版本](https://cli.github.com/) 后使用 `gh`；Ubuntu 已配置包源时可 `sudo apt install gh`，其他平台遵循[官方安装说明](https://github.com/cli/cli#installation)。本项目不捆绑账号、凭证或工具二进制，也不执行真实发布。

若采用 fine-grained PAT：在 GitHub 网页先创建仓库，再在个人设置创建**仅授予目标仓库**且有短有效期的 token。上传源码需要 **Contents: Read and write**；上传/修改 `.github/workflows/pages.yml` 还需要 **Workflows: Read and write**。只有打算通过 API 配置 Pages 才增加 **Pages: Read and write**，按上面的网页配置时不必增加。Metadata 的只读权限由 GitHub 默认提供。首次通过 API 创建仓库可能需要额外账号权限，所以建议网页创建，避免扩大 token 范围。组织可能还要求审批。

不要把 token 发到聊天、写进代码/README/远程 URL，或作为命令行参数。使用标准输入交给 CLI，例如 Bash：

```sh
read -r -s -p 'GitHub token: ' ATLAS_TOKEN
printf '\n'
printf '%s' "$ATLAS_TOKEN" | gh auth login --hostname github.com --with-token
unset ATLAS_TOKEN
gh auth status
```

检查 `gh` 是否使用系统凭据存储；若环境不支持，CLI 可能以明文保存在本机配置中，应限制权限并按需登出/撤销 token。不要录屏 token 输入或提交 CLI 配置。配置凭据后，可由你自行设置不含密码的远程地址并推送已有的 `main` 提交：

```sh
gh auth setup-git
git remote add origin https://github.com/你的账号/你的仓库.git
git push -u origin main
```

这些命令是假定你已审查并提交源码的操作说明，不会自动创建提交或覆盖已有远程设置。授权只在本机完成；项目工作流无需 PAT。

## Python 可信局域网共享版

从**完整公开源码**运行，不要把 `--directory` 指向只含 Pages 产物的 `dist`：

```sh
python3 atlas_server.py --bind 127.0.0.1 --port 8765 --data-dir "$HOME/.local/share/tongjian-atlas"
```

访问 `http://127.0.0.1:8765/`。若要可信局域网共同使用，把 `--bind` 改成服务器实际局域网 IP，并只给可信设备开放此端口。默认地址是 loopback，不会主动监听全部网卡。服务标准库运行，不需要可选历史研究工具的依赖。

**没有登录、权限分组或 TLS。所有获准访问的局域网用户均可修改共享保存。不要公开端口、做公网反代或当作匿名公共后端。** Host/Origin 检查不是账号认证；HTTP 不提供传输保密。若需要互联网多人服务，应另行设计身份认证、授权、TLS、审计和备份，不能只改监听地址。

服务器强制保存目录在公开资源目录之外；已有保存可通过明确 `--data-dir` 指向自己的合法旧保存目录使用，项目不会自动复制或公开它。迁移前停服务并备份。共享版与个人版没有自动同步，页面个人备份按钮不用于服务器数据迁移。

### 可选在线资料

没有以下文件仍能启动，手写人物、军阵、地点/疆域编辑、人工选录与已保存谱系不依赖它们：

- `biography-seed.json`、`biography-reference.json`：可选传记缓存/参考材料，公开包故意不附；现有提供方在无缓存时尝试实时搜韵查询。网络受限、限流或没有可靠结果时明确提示，不编造人物或短传。
- `genealogy-search-index.json`：可选真实来源姓名索引。缺失时共享版在线谱系检索返回明确503，不导致服务启动失败。用户可自行取得有权使用的数据，或先审查来源条款，再运行：

```sh
python3 scripts/fetch_genealogy_index.py --acknowledge-source-terms
```

该命令从真实晋朝/南北朝/三国名录页发现链接，只提取 `div#tctitle` 的姓名与已发现人物链接，不复制传记全文；最多60页、顺序请求、默认间隔2秒。网络/格式失败不覆盖旧索引，不绕过登录、限流或验证码。可用 `--max-pages 3` 做小范围采集，`--output /合法本地路径/genealogy-search-index.json` 改位置（服务读取 `--directory` 内同名文件）。索引不保证完整或断代准确，后续生成仍需上游可访问；它被 Git 与静态构建排除，**不要提交所得数据**。源码不代表资料站授予抓取或再分发许可。

## 源码与公开内容边界

公开源代码仓库包含完整共享服务模块、个人适配器、允许提供的混合许可数据、资源许可证、发布脚本和工作流。`git archive --format=zip --output=tongjian-atlas-source.zip HEAD` 可从**已审查的提交**生成源码包，避免包含忽略的运行时文件；先确认提交中没有秘密或受限数据。Pages 包仅需 `dist/` 内容。

原图扫描、原OCR、完整原始核验报告（体积较大且依赖未获统一授权的研究材料）、原图图库、地形影像、中研院历史瓦片、传记摘录、在线谱系名录和用户保存均不随公开版提供。页面用 `sources.html` 的明确说明和外部来源页替代缺失报告/图册，不提供虚假“全量已核验”承诺。

`build_territories.py` 是可选研究重建工具，需要 Node.js 与 Shapely，不是启动或 Pages 构建依赖。`audit_territories.py` 保留研究逻辑，但完整原始审计所需的图册/OCR资料不在公开包内，不应把缺少那些输入的重跑称为原报告再现。
