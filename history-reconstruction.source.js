/* WGS84 hand-drawn reconstruction. Drawing cells are NOT historical counties.
 * Sources support events and broad geography, not these exact coordinates.
 * Every exported snapshot contains complete features, never a delta.
 * Coarse base input only. Run build_territories.py to apply the sourced
 * territory-corrections.json; the map must consume generated history-data.js.
 */
(function () {
  'use strict';
  const disclaimer = '疆域概略重建，非精确县界。边界依据历史事件与地理锚点手工绘制，不是原图数字化成果；年份之间沿用上一事件断面，不代表逐年实测。空白表示未覆盖或控制未确认，并非无人地。';
  const S = {
    atlas:'http://guoxue123.com/other/map/zgmap/007.htm',
    zhao:'http://szzy.7lue.cn/read/1a0ee984fa9c5a8c237bd9367a608356/b9071811401584a0bba3fa97c116769e.md',
    guanggu:'https://www.newton.com.tw/wiki/石虎攻廣固之役',
    guangguTexts:'http://www.jrqzw.net/show-10-10376-1.html',
    wei:'http://szzy.7lue.cn/read/1a0ee984fa9c5a8c237bd9367a608356/10906982eda84291b8240d0188e77a91.md',
    northYan:'http://szzy.7lue.cn/read/1a0ee984fa9c5a8c237bd9367a608356/087f483694f48309eb1a2ce8820afef4.md',
    liang:'https://www.dhafund.cn/cms/whhy/226.html',
    campaigns:'https://news.sciencenet.cn/sbhtmlnews/2013/7/274990.shtm',
    tongjian103:'https://dict.hydict.cn/zztj/index/view/vid/103/typeid/3',
    tongjian104:'http://www.millionbook.net/lszl/s/simaguang/zztj/104.htm',
    qinMap:'http://www.pro-classic.com/ethnicgv/cmaps/1974/chts03-41.htm',
    yanMap:'http://www.pro-classic.com/ethnicgv/cmaps/1984/cnws29-1.htm',
    lateMap:'http://www.pro-classic.com/ethnicgv/cmaps/1984/cnws29-2.htm',
    jinMap:'http://www.pro-classic.com/ethnicgv/cmaps/1974/chts03-04.htm'
  };
  const polities = [
    ['western-jin','西晋','#d9a85e'],['eastern-jin','东晋','#dbb15e'],['liu-song','刘宋','#c89b38'],
    ['han-zhao','汉赵（前赵）','#a86e91'],['later-zhao','后赵','#748cc7'],['cheng-han','成汉','#bf7762'],
    ['former-liang','前凉','#89a96b'],['former-qin','前秦','#b48dca'],['later-qin','后秦','#c27687'],
    ['western-qin','西秦','#c98d45'],['murong','慕容部','#7a9fa0'],['former-yan','前燕','#6e9d9b'],
    ['later-yan','后燕','#4fa5ad'],['western-yan','西燕','#8596d3'],['southern-yan','南燕','#75ae83'],
    ['northern-yan','北燕','#71a0c2'],['later-liang','后凉','#90a34f'],['southern-liang','南凉','#bfaa53'],
    ['western-liang','西凉','#78a6ba'],['northern-liang','北凉','#759c69'],['dai','代','#a99d78'],
    ['northern-wei','北魏','#8874b8'],['xia','夏','#be875d'],['ran-wei','冉魏','#ba7d9c'],
    ['qiao-shu','谯蜀','#b88268'],['huan-chu','桓楚','#bca16b'],['qiuchi','仇池','#6fa58d'],
    ['tuyuhun','吐谷浑','#b89c78'],['duan-xianbei','段部鲜卑','#8b9db8'],['rebels','贼','#795b57'],
    ['southern-qi','南齐','#d5a34b'],['liang','梁','#d8ad58'],['chen','陈','#c88e45'],
    ['eastern-wei','东魏','#9477bc'],['western-wei','西魏','#a17a9b'],
    ['northern-qi','北齐','#797db5'],['northern-zhou','北周','#9c6e93'],
    ['western-liang-jingling','西梁（江陵）','#b69468'],['sui','隋','#ad8053'],
    ['hou-jing','侯景势力（后称汉）','#9b7765']
  ].map(([id,name,color]) => ({id,name,color}));
  const names = Object.fromEntries(polities.map(p => [p.id,p.name]));
  // Shared vertices: Qinling/Huai corridors, major basins and city anchors.
  // Peripheral tributaries, Western Regions and ancient coastline changes omitted.
  const cells = {
    south:[[109.5,31.9],[111,31.5],[113,31.7],[114.8,32.2],[116,32.4],[117.5,32.7],[119.3,33],[120.8,32.4],[121.7,31.2],[121.6,29.4],[120.7,27.8],[119.6,25.8],[118,24.3],[116.6,23],[114.3,22.2],[112,21.5],[110.5,20.4],[109.5,21.5],[107.5,21.6],[106,22.4],[104,23.8],[102.6,25.5],[102.6,28],[104,28],[106,28.7],[108,29.6]],
    shuWest:[[102.6,28],[104,28],[105.8,29.2],[105.5,31.2],[104.8,32.6],[103.2,32],[102.3,30]],
    shuEast:[[104,28],[106,28.7],[108,29.6],[109.5,31.9],[108,32.6],[106,32.5],[104.8,32.6],[105.5,31.2],[105.8,29.2]],
    hanzhong:[[104.8,32.6],[106,32.5],[108,32.6],[109.5,31.9],[110,33],[109,33.6],[107,33.8],[105.5,33.8]],
    xiangyang:[[109.5,31.9],[111,31.5],[113,31.7],[114.8,32.2],[114.5,33.4],[113,33.6],[111.8,33.5],[110,33]],
    huai:[[114.8,32.2],[116,32.4],[117.5,32.7],[119.3,33],[120.8,32.4],[120.4,34.3],[118.8,34.6],[117.3,34.4],[115.8,34.3],[114.5,33.4]],
    henan:[[110,33],[111.8,33.5],[113,33.6],[114.5,33.4],[115.8,34.3],[115.2,35.6],[113.8,35.1],[112.5,35.2],[110.4,34.7],[109,33.6]],
    guanzhong:[[105.5,33.8],[107,33.8],[109,33.6],[110.4,34.7],[110.5,35.4],[109,35.7],[107.5,35.7],[106,35.4],[106.4,34.5]],
    longyou:[[103.7,33.7],[105.5,33.8],[106.4,34.5],[106,35.4],[105.5,36.2],[104.2,36.5],[103.3,35.7],[102.8,34.8]],
    longxi:[[102.8,34.8],[103.3,35.7],[104.2,36.5],[103.6,37],[102.6,36.6],[102,35.8],[102.1,35]],
    hehuang:[[100.6,35.4],[102.1,35],[102,35.8],[102.6,36.6],[103.6,37],[102.9,37.4],[101.4,37.6],[100.3,36.7]],
    wuwei:[[102.9,37.4],[103.6,37],[104.2,37.6],[104.5,38.5],[103,39.1],[101.8,38.8],[101.4,37.6]],
    zhangye:[[101.4,37.6],[101.8,38.8],[103,39.1],[101.4,39.8],[99.7,40.3],[98.6,39.6],[99.7,38.5]],
    jiuquan:[[98.6,39.6],[99.7,40.3],[98.6,41.3],[97.4,41.3],[96.9,40.1],[97.6,39.2]],
    dunhuang:[[97.6,39.2],[96.9,40.1],[97.4,41.3],[95.4,41.5],[93.7,40.8],[94.2,39.6],[95.7,39.2]],
    beidiCore:[[107.5,35.7],[109,35.7],[110.5,35.4],[110.7,37.3],[109.8,38.5],[108.4,38.8],[106.7,38],[105.5,36.2],[106.7,36.8],[107.4,36.5]],
    pingliang:[[106,35.4],[107.5,35.7],[107.4,36.5],[106.7,36.8],[105.5,36.2]],
    lingwu:[[104.2,36.5],[105.5,36.2],[106.7,38],[108.4,38.8],[107.5,40.1],[106.1,40.4],[105.4,39.2],[104.5,38.5],[104.2,37.6],[103.6,37]],
    ordos:[[108.4,38.8],[109.8,38.5],[110.7,37.3],[111.2,38.8],[111.1,40.5],[109.5,40.8],[107.5,40.1]],
    hedong:[[110.4,34.7],[112.5,35.2],[112.3,36.5],[111,36.5],[110.5,35.4]],
    fen:[[110.5,35.4],[111,36.5],[112.3,36.5],[111.9,37.5],[110.7,37.3]],
    shangdang:[[112.5,35.2],[113.8,35.1],[114.1,36.8],[113.7,37.9],[111.9,37.5],[112.3,36.5]],
    taiyuan:[[110.7,37.3],[111.9,37.5],[113.7,37.9],[113.8,39.1],[112.3,39.1],[111.2,38.8]],
    dai:[[111.2,38.8],[112.3,39.1],[113.8,39.1],[115,40.1],[115.3,41.3],[113.5,42],[111.3,41.8],[111.1,40.5]],
    hebeiSouth:[[113.8,35.1],[115.2,35.6],[116.6,36.3],[117.4,37.6],[116.7,38.4],[114.8,38.8],[113.7,37.9],[114.1,36.8]],
    hebeiNorth:[[113.7,37.9],[114.8,38.8],[116.7,38.4],[117.7,39.2],[119.5,39.8],[119,40.8],[117.6,41.6],[115.3,41.3],[115,40.1],[113.8,39.1]],
    liaoxi:[[119,40.8],[119.5,39.8],[120.9,40.5],[122,40.9],[122.3,42],[121.4,42.8],[119.6,42.8],[117.6,41.6]],
    liaodong:[[122,40.9],[122.3,42],[123.6,42.2],[124.6,41.4],[124,40],[122.6,39],[121.4,38.8],[121.8,40.1]],
    shandongWest:[[115.8,34.3],[117.3,34.4],[118,35.3],[118.1,36.6],[119,37.1],[119.2,38],[117.4,37.6],[116.6,36.3],[115.2,35.6]],
    shandongEast:[[117.3,34.4],[118.8,34.6],[119.7,35.3],[120.5,36.1],[122.6,37.4],[121.5,37.8],[120,37.7],[119,37.1],[118.1,36.6],[118,35.3]]
  };
  const groups = {beidi:'beidiCore pingliang',shu:'shuWest shuEast',hexi:'dunhuang jiuquan zhangye wuwei hehuang',shanxi:'hedong fen shangdang taiyuan',hebei:'hebeiSouth hebeiNorth',shandong:'shandongWest shandongEast',jinCore:'south xiangyang huai'};
  const owners = {};
  const snapshots = [];
  function snapshot(year,title,description,changes,sourceKeys,notes={}) {
    for (const [polityId,regions] of Object.entries(changes)) {
      for (const key of regions.split(/\s+/).filter(Boolean).flatMap(k => groups[k] ? groups[k].split(' ') : [k])) {
        if (polityId === 'uncovered') delete owners[key];
        else owners[key] = polityId;
      }
    }
    const byPolity = {};
    for (const [key,polityId] of Object.entries(owners)) (byPolity[polityId] ||= []).push([cells[key].concat([cells[key][0]])]);
    snapshots.push({year,title,description:description+' 本断面取所述事件后的概略控制区，非全年每一时点；疆域概略重建，非精确县界。',
      features:Object.entries(byPolity).map(([polityId,coordinates]) => ({type:'Feature',properties:{polityId,name:names[polityId],note:(notes[polityId] || '依据事件与城市位置重建主要控制范围；边缘、坞堡、飞地和短期军事占领未逐一表达。')+' 手绘概略面，不是史料提供的精确经纬界线。'},geometry:{type:'MultiPolygon',coordinates}})),
      sources:[...new Set(['atlas',...sourceKeys].map(key=>S[key]))]});
  }
  snapshot(304,'汉、成兴起：西晋开始解体','刘渊在汾水地区起兵，李雄据成都。张轨所领河西仍属晋，不能把后来的前凉最大范围倒填到304年。',{'western-jin':'south shuEast hanzhong xiangyang huai henan guanzhong longyou longxi hexi beidi hedong shangdang taiyuan hebei shandong','han-zhao':'fen','cheng-han':'shuWest'},['zhao','liang'],{'han-zhao':'仅表达刘渊起兵的汾水西侧核心区，不表示此时已占整个山西。'});
  snapshot(311,'永嘉之乱：洛阳陷落','汉军攻陷洛阳，晋残余尚据长安；河北石勒部仍名义属汉。',{'han-zhao':'henan hedong shangdang hebeiSouth','cheng-han':'shu','dai':'dai','murong':'liaoxi'},['zhao','wei']);
  snapshot(317,'西晋亡后，晋室南渡','316年长安陷落，317年司马睿在建康称晋王。东晋按惯用纪年从317年起；河西张氏另色表示割据，并非否认其奉晋正朔。',{'eastern-jin':'jinCore hanzhong shandong','han-zhao':'guanzhong longyou beidi taiyuan hebeiNorth','former-liang':'hexi longxi','uncovered':'lingwu ordos'},['zhao','liang','wei']);
  snapshot(319,'前赵、后赵分立','刘曜以长安为中心，石勒以襄国为中心分立。中原晋军与坞堡交错；青州曹氏奉晋，不能将全山东先行涂为后赵。',{'later-zhao':'hebei shangdang taiyuan shandongWest','han-zhao':'hedong fen henan'},['zhao']);
  snapshot(323,'后赵攻取广固','石虎攻广固，曹嶷降后被杀，青州主要地区入后赵；事件为323年，不能误写333年。',{'later-zhao':'shandongEast'},['guanggu','guangguTexts']);
  snapshot(327,'前赵、后赵、前凉、成汉并立','以原图组327年为时间参照：前赵据关陇与河东西部，后赵据河北、青齐及中原东部，成汉据蜀。图面另行概略重建，并非原图描摹。',{'later-zhao':'henan fen','cheng-han':'hanzhong'},['zhao','guanggu']);
  snapshot(329,'后赵灭前赵','石勒攻取关中、陇右，前赵灭亡；河西张氏与辽西慕容氏继续存在。',{'later-zhao':'guanzhong longyou beidi hedong'},['zhao']);
  snapshot(337,'后赵盛期与前燕建国','后赵已在323年攻灭青州曹氏；慕容皝337年称燕王。北边段部、宇文部等未强填。',{'former-yan':'liaoxi liaodong'},['zhao','yanMap','guanggu']);
  snapshot(347,'桓温灭成汉，东晋收蜀','成汉灭亡，成都及巴蜀纳入东晋；北方仍以石虎后赵为最大政权。',{'eastern-jin':'shu hanzhong'},['zhao','jinMap']);
  snapshot(350,'后赵内乱与冉魏','石虎349年死后，后赵迅速分裂；冉闵350年据邺建魏。关陇、河南和山东争夺激烈，不把全部后赵旧地强归冉魏。',{'ran-wei':'hebeiSouth','former-yan':'hebeiNorth','uncovered':'guanzhong longyou beidi henan shandong shanxi'},['zhao','yanMap']);
  snapshot(352,'前秦立国，前燕取邺','苻健351年建前秦；352年前燕击败冉闵、取得邺。东晋利用北方崩解恢复河南与部分齐鲁，这些地区随后又为前燕夺取。',{'former-qin':'guanzhong longyou beidi','former-yan':'hebei','eastern-jin':'henan shandong','uncovered':'shangdang taiyuan hedong fen'},['zhao','yanMap','qinMap']);
  snapshot(356,'前燕向山东及并州扩张','前燕逐步占领青齐与并州；洛阳仍属晋，不把365年失守提前。山西西缘秦燕交错，面线仅为地理概括。',{'former-yan':'shandong shangdang taiyuan','former-qin':'hedong fen'},['yanMap','qinMap']);
  snapshot(366,'前凉、前秦、前燕与代','原图组366年时间参照；365年洛阳陷前燕，此时不再属晋。前秦据关陇，前燕据河北青齐及洛阳，代居北部。',{'former-yan':'henan','former-qin':'longxi'},['yanMap','qinMap']);
  snapshot(370,'前秦灭前燕','王猛攻克邺，前秦兼有河北、青齐与山西主要地区；尚未灭前凉和代。',{'former-qin':'hebei shandong shanxi henan liaoxi liaodong'},['qinMap','tongjian103']);
  snapshot(373,'前秦攻取梁、益','前秦进取汉中、成都；374年晋军与蜀地反抗未能恢复成都，不能把恢复晋统治提前到376年。',{'former-qin':'hanzhong shu'},['tongjian103']);
  snapshot(376,'前秦灭前凉与代','前秦兼并河西张氏与代，完成北方主要政权的统一；西域羁属与沙漠北缘未填色。',{'former-qin':'hexi dai lingwu ordos'},['liang','wei','qinMap']);
  snapshot(382,'淝水前夕：前秦与东晋','原图组382年断面。前秦据长安、邺、洛阳、成都、姑臧；379年襄阳陷秦。晋维持建康与江南主体，淮河沿线拉锯，未倒填383年临时推进。',{'former-qin':'xiangyang'},['qinMap','tongjian103','tongjian104'],{'former-qin':'382年成都、襄阳属于前秦。西域、东北远缘、漠北未画，不是最大声索范围。'});
  snapshot(386,'淝水战后分裂，北魏建立','383年淝水后前秦瓦解：后秦据关中、后燕据河北、西燕东迁上党、后凉据河西、西秦起陇西；拓跋珪386年建魏。晋恢复梁益襄阳、进取河南青齐。',{'eastern-jin':'shu hanzhong xiangyang henan shandong','later-qin':'guanzhong beidi','former-qin':'longyou','western-qin':'longxi','later-liang':'hexi','later-yan':'hebei liaoxi liaodong','western-yan':'shanxi','northern-wei':'dai','uncovered':'lingwu ordos'},['wei','liang','yanMap','lateMap'],{'western-yan':'东迁后上党及邻近山西地区总体势力；晋阳、河东年度归属复杂，须结合原图细核。'});
  snapshot(394,'后燕灭西燕，后秦灭前秦','后燕吞西燕并重新进入青齐；后秦灭前秦残余。翟魏等短命势力未单列，不表示全部区域同日转属。',{'later-yan':'shanxi shandong','later-qin':'longyou','northern-wei':'ordos'},['yanMap','lateMap','wei']);
  snapshot(395,'参合陂之战前后','原图组395年时间参照。北魏击败后燕，但不能把396—397年取得河北的成果提前；邺仍为后燕。',{},['wei','yanMap']);
  snapshot(397,'北魏入河北，河西分裂','北魏攻取中山等地，后燕北退龙城；南凉、北凉兴起。慕容德部尚在南部，山东转型期暂用后燕标识，到400年显示定都广固的南燕。',{'northern-wei':'hebei shanxi','southern-liang':'hehuang','northern-liang':'zhangye jiuquan dunhuang'},['wei','liang','yanMap']);
  snapshot(400,'四凉并立，南燕据广固','西凉400年起于敦煌；南燕398年立国、399年迁广固。西秦乞伏乾归败降后秦，400—408年不单列独立西秦。辽东遭高句丽进攻，不再整块涂为后燕。',{'western-liang':'dunhuang jiuquan','southern-yan':'shandong','later-qin':'longxi henan','uncovered':'liaodong'},['liang','yanMap','lateMap']);
  snapshot(403,'后凉亡，桓楚代晋','后凉降后秦，姑臧暂归后秦；桓玄篡晋，403年末以桓楚表示南方朝廷，次年恢复晋室。这是年内事件后断面，不代表全年。',{'later-qin':'wuwei','huan-chu':'jinCore shu hanzhong'},['liang','jinMap']);
  snapshot(405,'晋室恢复，谯纵据蜀','404年晋室恢复；405年谯纵据蜀形成谯蜀。西凉迁都酒泉，河西各国控制交错。',{'eastern-jin':'jinCore hanzhong','qiao-shu':'shu'},['jinMap','liang']);
  snapshot(406,'南凉取得姑臧','后秦将姑臧交给秃发傉檀，南凉向河西扩张；授官、朝贡关系不等于直接郡县统治，南凉单独着色。',{'southern-liang':'wuwei'},['liang']);
  snapshot(409,'后秦、魏与诸凉燕夏西秦','原图组409年参照：赫连勃勃407年建夏；乞伏乾归409年复建西秦；冯跋同年据龙城，北燕成立；南燕仍据广固。',{'xia':'beidi lingwu','western-qin':'longxi','northern-yan':'liaoxi'},['liang','northYan','lateMap'],{'northern-yan':'北燕起年有407年高云即位与409年冯跋即位两说，此断面取409年冯氏掌权。','xia':'统万周边与北地主要活动区；早期部众迁徙及据点变化不伪装成固定精确国界。'});
  snapshot(410,'刘裕灭南燕','晋军攻克广固，南燕灭亡，青齐纳入东晋；并非北魏此时已统治全山东。',{'eastern-jin':'shandong'},['yanMap','campaigns']);
  snapshot(411,'北凉取得姑臧','南凉退回乐都，姑臧入北凉；412年北凉迁都姑臧。西凉仍据酒泉、敦煌。',{'northern-liang':'wuwei'},['liang']);
  snapshot(414,'晋平谯蜀，西秦灭南凉','413年朱龄石平谯蜀；414年西秦乘南凉西征攻克乐都，南凉灭亡。',{'eastern-jin':'shu','western-qin':'hehuang'},['liang','jinMap']);
  snapshot(417,'刘裕灭后秦，晋取长安','416年晋取洛阳，417年攻克长安、灭后秦。关中为短期军事占领，不能延用到418年以后；陇右西缘不按后秦旧疆一概归晋。',{'eastern-jin':'henan guanzhong','western-qin':'longyou'},['campaigns','lateMap'],{'western-qin':'陇右继承仅作概括，天水以西诸城与西秦、夏争夺仍须逐城核验。'});
  snapshot(418,'夏取长安，晋退守河南','刘裕南归后关中守军内讧，赫连勃勃夺长安；晋保有洛阳与青齐，北伐成果不可视为永久疆土。',{'xia':'guanzhong'},['campaigns']);
  snapshot(420,'晋宋禅代，西凉退保敦煌','刘裕代晋建宋，南方疆域延续而政权改变；北凉杀李歆、取酒泉，李恂尚据敦煌，西凉不能提前完全消失。',{'liu-song':'jinCore shu hanzhong henan shandong','northern-liang':'jiuquan'},['campaigns','liang','jinMap']);
  snapshot(421,'北凉灭西凉','沮渠蒙逊攻取敦煌，李恂死，西凉灭亡；其后高昌方向沮渠氏活动不在覆盖范围。',{'northern-liang':'dunhuang'},['liang']);
  snapshot(423,'北魏夺取洛阳一带','422—423年魏宋战争后魏占洛阳、滑台等地；宋保有青齐与淮北据点。河南东部犬牙交错，不可据概略面判定单个县城。',{'northern-wei':'henan'},['wei']);
  snapshot(427,'北魏取统万，北凉入河湟','魏攻取夏都统万；夏仍保有关中和平凉附近地区。北凉从西秦夺西平、乐都，河湟转属北凉。',{'northern-wei':'beidiCore lingwu','northern-liang':'hehuang'},['wei','liang','lateMap']);
  snapshot(428,'北魏取得长安','北魏继续进攻夏，夏失关中，赫连定残部仍据平凉附近；保留夏色至431年，不提前宣告灭国。西部行动范围与堡壁不画成巨大稳固疆域。',{'northern-wei':'guanzhong'},['wei','lateMap'],{'xia':'赫连定平凉附近残余控制区，极为概略；不是夏国最后三年固定不动的精确国界。'});
  snapshot(431,'西秦与夏相继灭亡','赫连定灭西秦后又被吐谷浑俘获，夏亦亡。刚灭西秦的西部不能直接视为魏郡县，西部争夺带留白。',{'northern-wei':'pingliang','uncovered':'longxi longyou'},['wei','lateMap']);
  snapshot(436,'北魏灭北燕','冯弘离龙城东奔高句丽，魏占龙城，北燕亡；辽东与高句丽势力范围未强填魏色。',{'northern-wei':'liaoxi'},['northYan','wei']);
  snapshot(439,'北魏灭北凉，北方主要政权统一','魏取姑臧，沮渠牧犍降，十六国时代通常以此为终点；宋保有江南、青齐与淮河以南主体。河西西端接收及残余势力非同日消失，西域和吐谷浑边缘不画。',{'northern-wei':'wuwei zhangye jiuquan dunhuang hehuang longyou'},['wei','liang'],{'northern-wei':'439年表示灭北凉后的主要河西形势；敦煌酒泉等西端仍有残余抵抗及迁徙，不表示每个城堡同年均归魏直辖；河湟西缘须细核。'});
  window.HISTORY_DATA = {polities,snapshots,disclaimer,
    method:'固定地理绘图分区按事件重分归属，共享边界顶点；不是州郡GIS。34张原图仅作分期史料参照，坐标并非精确矢量化。',
    uncertainties:[
      '所有边线均概略；河南山西青齐的坞堡飞地及短期反复未逐县表达。',
      '早期地方奉晋势力与中央直辖不等同；面色表示主要政治归属。',
      '河湟陇右的西秦、后秦、诸凉、夏边界需结合逐年州郡文献细核，不是现代省界。',
      '北燕起年有407/409两说，采用409年冯氏掌权；西凉保留至421年敦煌失守。',
      '439年统一是主要政权层面，河西西端残部与吐谷浑边缘尚有过渡。',
      '西域漠北、高句丽及东北远缘、吐谷浑腹地、南中更远外围与交州南部未完整覆盖；空白不表示无人或无政权。',
      '原图未地理配准，海岸与河流背景不代表四世纪实测古海岸、古河道。',
      '公开网页含OCR及编辑差错（如后赵350误写305、五凉综述后凉终年不一）；按交叉资料与通鉴校正，未机械复制。'
    ],sources:Object.entries(S).map(([id,url])=>({id,url})),temporalPolicy:'previous-event-snapshot',coverage:{from:304,to:439,annualBorders:false,exactCountyBoundaries:false}};
}());
