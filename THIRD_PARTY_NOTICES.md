# Third-party notices / 第三方材料与许可边界

**代码 MIT 不等于数据 MIT。** 项目不代表任何资料机构；保留各记录中的来源、许可、年代和不确定性信息。公开可访问的网页不自动授予复制、修改或再分发许可。以下说明不是新增的第三方授权。

## 随公开版提供的材料

| 材料 | 来源与条件 | 本项目的处理 |
| --- | --- | --- |
| Leaflet 1.9.4 JavaScript、CSS、图标 | [Leaflet](https://leafletjs.com/)，BSD-2-Clause；Copyright 2010–2023 Volodymyr Agafonkin、2010–2011 CloudMade | 保留 `vendor/LEAFLET-LICENSE.txt`。图标取自该版本官方 npm 分发文件。 |
| polygon-clipping | [上游项目](https://github.com/mfogel/polygon-clipping)，MIT | 保留 `vendor/POLYGON-CLIPPING-LICENSE.txt` 中实际权利人及完整条款。 |
| OpenCC 字符匹配表 | [TSCharacters.txt](https://github.com/BYVoid/OpenCC/blob/master/data/dictionary/TSCharacters.txt)，Apache-2.0 | `biography-normalization.json` 是姓名匹配用途的抽取/转换表，不改写传记引文；保留来源字段及 `vendor/OPENCC-LICENSE.txt`。仅 Python 源码版使用，Pages 不发布此表。 |
| 现代陆地、河湖线面 | [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/)，公有领域 | `geo-data.js` 中 1:50m/1:10m 的概化与裁剪，及历史多边形的现代陆地裁剪。现代河岸、海岸不是古地貌复原；不适合导航。 |
| 现代地形着色与坡向阴影影像 | [Mapzen/AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)；USGS SRTM/GMTED2010、NOAA ETOPO1 | 发布 `terrain/china-relief.webp`，由 Terrarium z5 高程瓦片拼接、着色并计算阴影，覆盖东亚阅读区域；不是古地貌、古海岸或测绘导航产品。SRTM/GMTED2010 data courtesy of the U.S. Geological Survey；ETOPO1 credit: DOC/NOAA/NESDIS/NCEI, U.S. Department of Commerce。保留美国政府数据在美国境内不受版权保护的说明，不将上游全球所有数据或境外权利一概改称 MIT／无条件公有领域。原始数据及再利用条件见[上游署名说明](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)。 |
| 历史州、郡、县治所记录 | CHGIS / China Historical GIS，Harvard University 与 Fudan University；[TGAZ](https://chgis.hudci.org/tgw/)，记录声明 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) | `geo-data.js` 是304—439年九个断面检索的筛选、去重与显示整理，保留逐条 URI、许可、年代及定位警告；不保证全量，不推定各年实控。须署名、标明修改、仅作非商业使用。不得把此部分改标 MIT。 |
| 历史地点/水域采用的现代区域参照点 | 各记录 `source`、`coordinateSource` 中明确的 OpenStreetMap 与 GeoNames | 公开 `geo-data.js` 已包含部分此类坐标，不仅限于运行时检索。OSM 部分署名 OpenStreetMap contributors，保留 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)；GeoNames 部分署名 GeoNames，保留 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。转换说明、原节点/关系链接与现代坐标用途按条目保留；发布源码提供这些记录的可机器读取形式。不得把现代代表点声称为古城/河岸实测，或把这些部分改标 MIT。 |
| 项目整理的历史事实、手绘概略疆域、研究说明和核心谱系 | `history-data.js`、`history-reconstruction.source.js`、`territory-corrections.json`、`curated-evidence.json`、`review-data.js`、`genealogy-data.js` 及个别附出处地点 | 项目整理/概略绘制不等于引用站点的原图或文字授权。保留来源和未决问题；本次代码 MIT 不覆盖这些数据，不授予第三方材料的新许可。对地图作者的原创部分亦不冒充已经取得额外的商业授权。 |

`geo-data.js` 是混合来源集合，不能对整个文件套用 Natural Earth 公有领域声明；CHGIS、OSM 和 GeoNames 部分各自保留许可。OSM 参考点与 Natural Earth 底图线面、手绘历史疆域应分开理解。再分发或改编含 OSM 派生数据的集合时，应核对 ODbL 对相应数据库部分的共享和机器可读提供义务。

## 运行时可选服务与用户数据

- 共享版现代地点检索使用 [Photon](https://photon.komoot.io/) / [OpenStreetMap](https://www.openstreetmap.org/copyright)。OSM 数据由 OpenStreetMap contributors 提供，适用 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)；保留记录中的来源及署名。再分发数据库时还应核对 ODbL 的共享与提供数据库义务，不因个人导出而变为 MIT。
- 共享版实时短传来自[搜韵](https://sou-yun.cn/QueryAllusion.aspx)等逐条注明的站点。引用来源不是再分发许可。源码包不含 `biography-seed.json`（搜韵/辞典摘录）、`biography-reference.json`（教育部辞典参考摘录）；后者的原有 CC BY-ND 3.0 TW 条件不能被用来推定已编辑摘录可再分发。
- 可选 `genealogy-search-index.json` 来自[博雅人物](http://famous.usatour.com.cn/)时代名录。公开源码不附该索引或人物全文；`scripts/fetch_genealogy_index.py` 仅在用户确认来源条件后生成本地姓名与已发现链接。采集命令不构成许可，也不能保证来源准确、可用或完整；不得自动把生成文件提交到公开仓库。
- 用户手写传记、导入资料及 API 获取内容均保留各自权利。导出备份不代表已获公开传播授权，可能包含个人备注或受限摘录。

## 明确未分发的材料

1. 原地图扫描、图册、01—05目录、原始 OCR、图片缓存及完整原始核验报告。历史地图来源目录 `map-data.js` 仅保存标题、年代和来源页面链接，不保存/嵌入扫描文件或扫描图片直链。可从[国学导航地图来源页面](http://guoxue123.com/other/map/zgmap/007.htm)自行查阅；外站条款仍适用。
2. 中研院382年在线地图瓦片。曾用于非商业参照不等于获得再分发许可；公开版已移除请求地址。
3. 任何用户共享保存 JSON、浏览器导出、账号凭证、原部署目录和原始传记/谱系资料快照。

核验报告并非“全部历史事实已经验证”的证明。公开版保留局部证据和不确定性；省略原报告是分发边界，不是消除原有疑点。

## 地形影像的处理与使用限制

本项目对高程数据进行了拼接、分辨率概化、高程配色和坡向阴影渲染；这些显示处理不代表 USGS、NOAA 或 Mapzen 对本项目的认可。数据按现状提供，不保证适合特定用途，不能用于导航或精确工程测量。现代地形只能帮助读史定位，不复原公元304—589年各年的地表、水面及河道。网站底部及来源页面保留署名，影像与历史地图扫描的再分发权限分别处理。
