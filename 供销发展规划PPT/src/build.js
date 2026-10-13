const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const fa = require("react-icons/fa");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { applyTheme } = require(process.env.SKILL + "/scripts/apply_theme.js");

const OUT = process.argv[2] || "deck.pptx";
const IMGDIR = path.join(__dirname, "img");
fs.mkdirSync(IMGDIR, { recursive: true });

const THEME = {
  name: "供销商务蓝",
  headFontFace: "Microsoft YaHei",
  bodyFontFace: "Microsoft YaHei",
  colors: {
    dk1: "1A2433", lt1: "FFFFFF", dk2: "0A2F6B", lt2: "EEF4FC",
    accent1: "1F5FBF", accent2: "3D8BFD", accent3: "D9A441",
    accent4: "5B6B82", accent5: "8FB3E8", accent6: "0E7C86",
    hlink: "1F5FBF", folHlink: "5B6B82",
  },
};
const H = THEME.colors;

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
pres.title = "江苏省供销合作社高质量发展行动方案（2026—2030年）";
pres.author = "江苏省供销合作总社";
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;

// ---------- layouts ----------
const FOOT = "江苏省供销合作社高质量发展行动方案（2026—2030年）";
pres.defineSlideMaster({
  title: "COVER",
  background: { color: H.dk2 },
  objects: [],
});
pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: H.lt1 },
  margin: [0.5, 0.6, 0.6, 0.6],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.38, w: 9.4, h: 0.85, fontSize: 28, bold: true, color: C.text2, align: "left", valign: "middle", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "tag", type: "body", x: 10.1, y: 0.55, w: 2.63, h: 0.5, fontSize: 12, color: C.accent1, align: "right", valign: "middle", margin: 0 }, text: "" } },
    { text: { text: FOOT, options: { x: 0.6, y: 6.95, w: 8, h: 0.35, fontSize: 10, color: C.accent4, margin: 0, valign: "middle" } } },
  ],
  slideNumber: { x: 12.23, y: 6.95, w: 0.5, h: 0.35, fontSize: 10, color: C.accent4, align: "right" },
});

// ---------- helpers ----------
async function icon(Comp, hex, px = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color: "#" + hex, size: px }));
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}
const shadow = () => ({ type: "outer", color: "0A2F6B", opacity: 0.12, blur: 8, offset: 2, angle: 90 });
const slots = [];
function photo(s, id, x, y, w, h, hint) {
  slots.push({ id, w, h, hint });
  s.addImage({ path: path.join(IMGDIR, id + ".png"), x, y, w, h, objectName: "可替换图片_" + id, altText: "可替换图片：" + hint });
}
async function iconCircle(s, Comp, x, y, d, fill = C.accent1, iconHex = "FFFFFF") {
  s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill } });
  const pad = d * 0.26;
  s.addImage({ data: await icon(Comp, iconHex), x: x + pad, y: y + pad, w: d - 2 * pad, h: d - 2 * pad });
}
function card(s, x, y, w, h, fill = C.background2) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: fill }, line: { color: fill }, shadow: shadow() });
}
function txt(s, text, o) { s.addText(text, Object.assign({ isTextBox: true, margin: 0, fontSize: 14, color: C.text1, valign: "top" }, o)); }
function content(sectionTitle, title, tag) {
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle });
  s.addText(title, { placeholder: "title" });
  s.addText(tag, { placeholder: "tag" });
  return s;
}
// list of {h: heading, b: body}
function blocks(items, hs = 16, bs = 14) {
  const runs = [];
  items.forEach((it, i) => {
    runs.push({ text: it.h, options: { bold: true, fontSize: hs, color: C.text2, breakLine: true } });
    runs.push({ text: it.b, options: { fontSize: bs, color: C.text1, breakLine: i < items.length - 1, paraSpaceAfter: 10 } });
  });
  return runs;
}
function bullets(items, size = 14) {
  return items.map((t, i) => ({ text: t, options: { bullet: { indent: 14 }, fontSize: size, color: C.text1, breakLine: i < items.length - 1, paraSpaceAfter: 6 } }));
}
function arrow(s, x, y, w = 0.45, h = 0.4, color = C.accent5) {
  s.addShape(pres.shapes.RIGHT_ARROW, { x, y, w, h, fill: { color }, line: { color } });
}

(async () => {
  // ===== 1 封面 =====
  pres.addSection({ title: "开篇" });
  let s = pres.addSlide({ masterName: "COVER", sectionTitle: "开篇" });
  photo(s, "图01", 7.33, 0, 6.0, 7.5, "封面主图：田野丰收、供销为农服务场景或省供销大楼");
  txt(s, "苏供发〔2026〕42号", { x: 0.8, y: 1.3, w: 6, h: 0.4, fontSize: 14, color: C.accent3 });
  txt(s, "江苏省供销合作社\n高质量发展行动方案", { x: 0.8, y: 1.85, w: 6.3, h: 1.9, fontSize: 40, bold: true, color: C.background1, valign: "top" });
  txt(s, "（2026—2030年）全省供销系统未来五年发展规划", { x: 0.8, y: 3.9, w: 6.3, h: 0.5, fontSize: 18, color: C.accent5 });
  txt(s, "深入推进“一体两业三网”建设", { x: 0.8, y: 4.6, w: 6.3, h: 0.45, fontSize: 16, color: C.background1 });
  txt(s, "汇报人：×××（请修改）    2026年×月", { x: 0.8, y: 6.2, w: 6.3, h: 0.4, fontSize: 14, color: C.accent5 });
  s.addNotes("各位领导、同志们：今年9月，省供销合作总社印发了《江苏省供销合作社高质量发展行动方案（2026—2030年）》。这是指导全省供销系统未来五年发展的纲领性文件。下面，我用大约十分钟时间，就方案的总体思路、五大重点行动和保障措施作简要介绍。");

  // ===== 2 提纲 =====
  s = content("开篇", "汇报提纲", "CONTENTS");
  photo(s, "图02", 0.6, 1.55, 4.9, 5.1, "提纲配图：供销合作社门店、农资服务或乡村风貌");
  const toc = [
    ["01", "总体思路与目标", "制定依据 · “一体两业三网” · 2030年关键指标"],
    ["02", "五大重点行动", "提质 · 提档 · 提升 · 提效 · 提速"],
    ["03", "组织保障与工作要求", "党的领导 · 政策支持 · 安全发展 · 落地落实"],
  ];
  toc.forEach((t, i) => {
    const y = 1.75 + i * 1.65;
    card(s, 6.0, y, 6.73, 1.35);
    txt(s, t[0], { x: 6.3, y: y + 0.2, w: 1.2, h: 0.95, fontSize: 40, bold: true, color: C.accent1, valign: "middle" });
    txt(s, t[1], { x: 7.6, y: y + 0.22, w: 4.9, h: 0.5, fontSize: 22, bold: true, color: C.text2 });
    txt(s, t[2], { x: 7.6, y: y + 0.78, w: 4.9, h: 0.4, fontSize: 14, color: C.accent4 });
  });
  s.addNotes("我的汇报分三个部分：第一，方案的总体思路和目标；第二，方案部署的五大重点行动；第三，组织保障和工作要求。");

  // ===== 3 制定依据 =====
  pres.addSection({ title: "总体思路与目标" });
  s = content("总体思路与目标", "方案制定的背景与依据", "01 总体思路与目标");
  const basis = [
    [fa.FaFlag, "政治引领", "深入贯彻习近平总书记关于供销合作社工作和对江苏工作的重要讲话重要指示精神"],
    [fa.FaBook, "全国规划", "落实《全国供销合作社“十五五”发展规划》部署要求"],
    [fa.FaLandmark, "省级部署", "落实省政府《关于推动供销合作社高质量发展强化为农服务综合平台建设的意见》"],
  ];
  for (let i = 0; i < 3; i++) {
    const x = 0.6 + i * 4.14;
    card(s, x, 1.6, 3.85, 3.6);
    await iconCircle(s, basis[i][0], x + 0.35, 1.9, 0.9);
    txt(s, basis[i][1], { x: x + 0.35, y: 3.0, w: 3.2, h: 0.45, fontSize: 20, bold: true, color: C.text2 });
    txt(s, basis[i][2], { x: x + 0.35, y: 3.55, w: 3.2, h: 1.5, fontSize: 15, color: C.text1 });
  }
  card(s, 0.6, 5.5, 12.13, 1.1, C.text2);
  txt(s, [
    { text: "方案定位  ", options: { bold: true, color: C.accent3 } },
    { text: "经省总社党组会审议通过，2026年9月11日印发，规划期为2026—2030年，是全省供销系统未来五年高质量发展的“施工图”。", options: { color: C.background1 } },
  ], { x: 0.95, y: 5.5, w: 11.5, h: 1.1, fontSize: 16, valign: "middle" });
  s.addNotes("方案的制定有三个依据：一是深入贯彻习近平总书记关于供销合作社工作和对江苏工作的重要讲话重要指示精神；二是落实全国总社“十五五”发展规划；三是落实省政府关于强化为农服务综合平台建设的意见。方案已经省总社党组会审议通过，是我们今后五年工作的施工图。");

  // ===== 4 一体两业三网 =====
  s = content("总体思路与目标", "主线：深入推进“一体两业三网”建设", "01 总体思路与目标");
  const L = 0.6, DW = 7.6;
  card(s, L, 1.55, DW, 1.25, C.text2);
  txt(s, [{ text: "一体  ", options: { bold: true, fontSize: 22, color: C.accent3 } }, { text: "构建全省上下贯通、整体协调、高效运转的现代经营服务体系", options: { fontSize: 16, color: C.background1 } }], { x: L + 0.3, y: 1.55, w: DW - 0.6, h: 1.25, valign: "middle" });
  const two = ["农业社会化服务", "农产品流通"];
  two.forEach((t, i) => {
    const w = (DW - 0.3) / 2, x = L + i * (w + 0.3);
    card(s, x, 3.05, w, 1.05, C.accent1);
    txt(s, [{ text: "两业  ", options: { bold: true, fontSize: 18, color: C.accent3 } }, { text: t, options: { bold: true, fontSize: 18, color: C.background1 } }], { x, y: 3.05, w, h: 1.05, align: "center", valign: "middle" });
  });
  const three = ["农业社会化\n服务网", "农村现代\n流通服务网", "农产品冷链\n物流骨干网"];
  three.forEach((t, i) => {
    const w = (DW - 0.6) / 3, x = L + i * (w + 0.3);
    card(s, x, 4.35, w, 1.45, C.background2);
    txt(s, t, { x, y: 4.35, w, h: 1.45, align: "center", valign: "middle", fontSize: 17, bold: true, color: C.text2 });
  });
  txt(s, "三网：打造覆盖全省的三张服务网络", { x: L, y: 5.95, w: DW, h: 0.4, fontSize: 14, color: C.accent4, align: "center" });
  card(s, 8.6, 1.55, 4.13, 4.8, C.background2);
  await iconCircle(s, fa.FaBullseye, 8.95, 1.85, 0.8, C.accent3);
  txt(s, "2030年总体目标", { x: 8.95, y: 2.85, w: 3.5, h: 0.5, fontSize: 20, bold: true, color: C.text2 });
  txt(s, bullets(["主营业务全面提质增效", "服务农民生产生活作用充分彰显", "促进现代农业发展作用充分彰显"], 16), { x: 8.95, y: 3.5, w: 3.55, h: 2.6 });
  s.addNotes("方案的主线是深入推进“一体两业三网”建设。“一体”，就是构建全省上下贯通、整体协调、高效运转的现代经营服务体系；“两业”，就是聚焦农业社会化服务和农产品流通两大主业；“三网”，就是打造覆盖全省的农业社会化服务网、农村现代流通服务网和农产品冷链物流骨干网。目标是到2030年，主营业务全面提质增效，服务农民生产生活和促进现代农业发展的作用充分彰显。");

  // ===== 5 关键指标 =====
  s = content("总体思路与目标", "到2030年的关键量化指标", "01 总体思路与目标");
  const stats = [
    [fa.FaWarehouse, "70", "个", "农产品配送中心"],
    [fa.FaSeedling, "700", "个", "安全绿色直供产地"],
    [fa.FaSnowflake, "70", "万吨", "系统农产品冷链库容"],
    [fa.FaStore, "≥150", "场/年", "“供销市集”活动"],
  ];
  for (let i = 0; i < 4; i++) {
    const x = 0.6 + i * 3.1, w = 2.83;
    card(s, x, 1.65, w, 3.75);
    await iconCircle(s, stats[i][0], x + (w - 0.85) / 2, 1.95, 0.85);
    txt(s, [{ text: stats[i][1], options: { fontSize: 54, bold: true, color: C.accent1 } }, { text: " " + stats[i][2], options: { fontSize: 18, bold: true, color: C.text2 } }], { x, y: 3.0, w, h: 1.2, align: "center", valign: "middle" });
    txt(s, stats[i][3], { x: x + 0.2, y: 4.3, w: w - 0.4, h: 0.9, fontSize: 16, color: C.text1, align: "center" });
  }
  txt(s, [{ text: "同时：", options: { bold: true, color: C.text2 } }, { text: "打造农资“1+3+N”骨干企业集群，创建一批全国总社示范基层社，完成江苏“供销市集”商标注册。", options: {} }], { x: 0.6, y: 5.75, w: 12.13, h: 0.7, fontSize: 16, valign: "middle" });
  s.addNotes("方案提出了一批硬指标：到2030年，全系统建成农产品配送中心70个、直供产地700个；系统农产品冷链库容达到70万吨；“供销市集”活动每年不少于150场。同时，要打造农资“1+3+N”骨干企业集群，创建一批全国总社示范基层社。这些指标，是我们检验工作成效的重要标尺。");

  // ===== 6 五大行动总览 =====
  pres.addSection({ title: "五大重点行动" });
  s = content("五大重点行动", "五大重点行动总览", "02 五大重点行动");
  const acts = [
    ["提质", "行动一", "农业社会化服务\n提质行动", "农资保供 · 农服网络\n经营服务 · 绿色发展", fa.FaTractor],
    ["提档", "行动二", "农村现代流通服务\n提档行动", "直供配送 · 产销对接\n消费帮扶 · 循环利用", fa.FaTruck],
    ["提升", "行动三", "农产品冷链物流服务\n提升行动", "设施体系 · 专业运营\n一体管理", fa.FaSnowflake],
    ["提效", "行动四", "供销合作社综合改革\n提效行动", "联合社治理 · 社有企业\n基层社建设", fa.FaCogs],
    ["提速", "行动五", "供销新质生产力发展\n提速行动", "数字供销 · 人工智能\n标准品牌", fa.FaMicrochip],
  ];
  for (let i = 0; i < 5; i++) {
    const w = 2.2, x = 0.6 + i * (w + 0.283);
    card(s, x, 1.6, w, 5.0);
    s.addShape(pres.shapes.OVAL, { x: x + (w - 1.3) / 2, y: 1.9, w: 1.3, h: 1.3, fill: { color: C.text2 }, line: { color: C.text2 } });
    txt(s, acts[i][0], { x: x + (w - 1.3) / 2, y: 1.9, w: 1.3, h: 1.3, fontSize: 24, bold: true, color: C.background1, align: "center", valign: "middle" });
    txt(s, acts[i][1], { x, y: 3.4, w, h: 0.4, fontSize: 14, color: C.accent1, bold: true, align: "center" });
    txt(s, acts[i][2], { x: x + 0.1, y: 3.85, w: w - 0.2, h: 0.95, fontSize: 15, bold: true, color: C.text2, align: "center" });
    txt(s, acts[i][3], { x: x + 0.1, y: 4.95, w: w - 0.2, h: 1.0, fontSize: 13, color: C.accent4, align: "center" });
    s.addImage({ data: await icon(acts[i][4], H.accent5), x: x + (w - 0.4) / 2, y: 6.0, w: 0.4, h: 0.4 });
  }
  s.addNotes("围绕这条主线，方案部署了五大重点行动，可以概括为“五个提”：农业社会化服务要提质，农村现代流通服务要提档，农产品冷链物流服务要提升，综合改革要提效，新质生产力发展要提速。下面逐一作介绍。");

  // ===== 7 行动一：农资保供 =====
  s = content("五大重点行动", "强化农资保供能力：打造“1+3+N”骨干企业集群", "行动一 · 农业社会化服务提质");
  const pyr = [["1", "家省级龙头企业", 2.6, C.text2], ["3", "家区域型重点企业", 3.9, C.accent1], ["N", "家县域农资企业", 5.2, C.accent2]];
  pyr.forEach((p, i) => {
    const y = 1.6 + i * 0.95, cx = 3.2;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx - p[2] / 2, y, w: p[2], h: 0.8, rectRadius: 0.1, fill: { color: p[3] }, line: { color: p[3] } });
    txt(s, [{ text: p[0] + " ", options: { fontSize: 24, bold: true, color: C.accent3 } }, { text: p[1], options: { fontSize: 16, bold: true, color: C.background1 } }], { x: cx - p[2] / 2, y, w: p[2], h: 0.8, align: "center", valign: "middle" });
  });
  const chips7 = ["每年发布农资保供企业名单", "新建改造县域农资配送中心", "落实化肥商业储备和省级储备制度", "补齐农资服务“空白县”"];
  chips7.forEach((t, i) => {
    const x = 0.6 + (i % 2) * 2.85, y = 4.6 + Math.floor(i / 2) * 1.05;
    card(s, x, y, 2.65, 0.9);
    txt(s, t, { x: x + 0.15, y, w: 2.35, h: 0.9, fontSize: 14, color: C.text1, valign: "middle" });
  });
  photo(s, "图03", 6.4, 1.6, 6.33, 5.0, "农资仓储配送中心、化肥储备库实景");
  s.addNotes("第一大行动是农业社会化服务提质。首先是强化农资保供能力。我们要实施骨干农资企业集群培育工程，打造“1+3+N”骨干企业集群，也就是1家省级龙头企业、3家区域型重点企业、N家县域农资企业。每年发布保供企业名单，新建改造县域农资配送中心，落实化肥储备制度，补齐“空白县”，切实提高农资应急保供能力。");

  // ===== 8 行动一：农服网络与经营服务 =====
  s = content("五大重点行动", "完善农服网络，提升经营服务水平", "行动一 · 农业社会化服务提质");
  const svc = [[fa.FaBoxOpen, "农资供应"], [fa.FaSeedling, "育秧育苗"], [fa.FaTractor, "农机作业"], [fa.FaChalkboardTeacher, "农技推广"], [fa.FaWarehouse, "烘干仓储"], [fa.FaSnowflake, "冷藏保鲜"], [fa.FaIndustry, "初加工"]];
  for (let i = 0; i < 7; i++) {
    const step = 12.13 / 7, cx = 0.6 + step * i + step / 2;
    await iconCircle(s, svc[i][0], cx - 0.4, 1.55, 0.8, i % 2 ? C.accent2 : C.accent1);
    txt(s, svc[i][1], { x: cx - 0.85, y: 2.45, w: 1.7, h: 0.4, fontSize: 14, bold: true, color: C.text2, align: "center" });
  }
  card(s, 0.6, 3.15, 7.0, 3.45);
  txt(s, "因地制宜发展三类服务模式", { x: 0.9, y: 3.35, w: 6.4, h: 0.45, fontSize: 16, bold: true, color: C.text2 });
  ["单环节", "多环节", "全托管"].forEach((t, i) => {
    const x = 0.9 + i * 2.2;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 3.95, w: 1.7, h: 0.6, rectRadius: 0.1, fill: { color: C.accent1 }, line: { color: C.accent1 } });
    txt(s, t, { x, y: 3.95, w: 1.7, h: 0.6, fontSize: 15, bold: true, color: C.background1, align: "center", valign: "middle" });
    if (i < 2) arrow(s, x + 1.78, 4.06);
  });
  txt(s, bullets(["推广“供销合作社+村集体+农户”“供销合作社+农民专业合作社+农户”", "建设区域性农业综合服务中心，推进“社村共建”", "承接高标准农田建设，推进金坛供销农场等重大项目"], 14), { x: 0.9, y: 4.8, w: 6.5, h: 1.7 });
  photo(s, "图04", 7.9, 3.15, 4.83, 3.45, "农机作业、托管服务或育秧中心现场");
  s.addNotes("其次是完善农服网络、提升服务水平。要健全覆盖全省的农业社会化服务网络，围绕农资供应、育秧育苗、农机作业、农技推广、烘干仓储、冷藏保鲜、初加工等环节完善服务；因地制宜发展单环节、多环节、全托管服务，推广“供销社+村集体+农户”等合作方式，通过订单生产、保价收购，带动农民分享增值收益。");

  // ===== 9 行动一：绿色发展 =====
  s = content("五大重点行动", "助力农业绿色发展", "行动一 · 农业社会化服务提质");
  photo(s, "图05", 0.6, 1.55, 5.3, 5.05, "绿色农田、有机肥施用或农药包装废弃物回收点");
  const green = [
    [fa.FaShieldAlt, "加强农资质量管理", "落实肥药实名制购买、定额制使用政策，积极参与跨部门农资打假"],
    [fa.FaLeaf, "深化“绿色农资”升级行动", "推广水溶肥、有机肥、生物农药、优质种子，扩大绿色农资使用范围和规模"],
    [fa.FaRecycle, "推进废弃物回收处理", "开展肥药集采统配和农业包装废弃物回收，推进减量化、资源化、无害化"],
  ];
  for (let i = 0; i < 3; i++) {
    const y = 1.6 + i * 1.7;
    card(s, 6.2, y, 6.53, 1.45);
    await iconCircle(s, green[i][0], 6.45, y + 0.3, 0.85, C.accent6);
    txt(s, blocks([{ h: green[i][1], b: green[i][2] }]), { x: 7.5, y: y + 0.15, w: 5.0, h: 1.2, valign: "middle" });
  }
  s.addNotes("再次是助力农业绿色发展。要加强农资质量管理，落实肥药实名制购买、定额制使用；深化“绿色农资”升级行动，推广水溶肥、有机肥、生物农药和优质种子；深入开展肥药集采统配和包装废弃物回收，推动农业废弃物减量化、资源化、无害化。");

  // ===== 10 行动二：直供配送 =====
  s = content("五大重点行动", "完善直供配送体系", "行动二 · 农村现代流通服务提档");
  const flow = [[fa.FaDesktop, "运营平台"], [fa.FaWarehouse, "配送中心"], [fa.FaSeedling, "直供产地"]];
  for (let i = 0; i < 3; i++) {
    const x = 0.6 + i * 2.55;
    card(s, x, 1.6, 2.0, 1.75);
    await iconCircle(s, flow[i][0], x + 0.6, 1.8, 0.8);
    txt(s, flow[i][1], { x, y: 2.7, w: 2.0, h: 0.45, fontSize: 16, bold: true, color: C.text2, align: "center" });
    if (i < 2) arrow(s, x + 2.05, 2.25);
  }
  [["70", "个配送中心"], ["700", "个直供产地"]].forEach((t, i) => {
    const x = 0.6 + i * 3.65;
    card(s, x, 3.65, 3.35, 1.3, C.text2);
    txt(s, [{ text: t[0], options: { fontSize: 36, bold: true, color: C.accent3 } }, { text: " " + t[1], options: { fontSize: 16, color: C.background1 } }], { x, y: 3.65, w: 3.35, h: 1.3, align: "center", valign: "middle" });
  });
  txt(s, "2030年目标", { x: 0.6, y: 5.0, w: 7.0, h: 0.35, fontSize: 12, color: C.accent4 });
  txt(s, bullets(["支持苏供优选等拓展学校、机关、部队配送业务", "发展订单农业、产销一体合作，提升联农带农能力", "依托流通设施服务应急保供和市场调控"], 14), { x: 0.6, y: 5.4, w: 7.1, h: 1.25 });
  photo(s, "图06", 8.0, 1.6, 4.73, 5.0, "配送中心分拣、冷链配送车辆或直供基地");
  s.addNotes("第二大行动是农村现代流通服务提档。首先是完善直供配送体系，推广“运营平台+配送中心+直供产地”模式，支持苏供优选等企业拓展学校、机关、部队配送业务。到2030年，全系统建成配送中心70个、直供产地700个，同时发展订单农业，服务应急保供和市场调控。");

  // ===== 11 行动二：产销对接 =====
  s = content("五大重点行动", "优化产销对接机制，打造消费新场景", "行动二 · 农村现代流通服务提档");
  card(s, 0.6, 1.6, 2.9, 2.4, C.text2);
  txt(s, "“供销市集”", { x: 0.6, y: 1.75, w: 2.9, h: 0.45, fontSize: 18, bold: true, color: C.background1, align: "center" });
  txt(s, [{ text: "≥150", options: { fontSize: 44, bold: true, color: C.accent3 } }, { text: " 场/年", options: { fontSize: 16, color: C.background1 } }], { x: 0.6, y: 2.25, w: 2.9, h: 1.0, align: "center", valign: "middle" });
  txt(s, "常态化举办", { x: 0.6, y: 3.3, w: 2.9, h: 0.4, fontSize: 14, color: C.accent5, align: "center" });
  const mk = [["融合模式", "“市集+体育”“市集+景点”"], ["区域协同", "长三角、南京都市圈联展联销"], ["线上线下", "直播带货、私域电商、即时零售"], ["特色直播", "“村播”“田播”、助农直通车进乡村"]];
  mk.forEach((m, i) => {
    const x = 4.1 + (i % 2) * 3.0 * 0 + 0, y = 1.6 + i * 0.6;
    txt(s, [{ text: m[0] + "  ", options: { bold: true, color: C.accent1 } }, { text: m[1], options: {} }], { x: 3.75, y, w: 3.95, h: 0.55, fontSize: 14, valign: "middle" });
  });
  card(s, 0.6, 4.3, 7.1, 2.3);
  await iconCircle(s, fa.FaShoppingBasket, 0.9, 4.6, 0.8, C.accent6);
  txt(s, blocks([{ h: "“鲜丰汇”迭代升级", b: "支持“鲜丰汇”由政采平台向公共平台拓展，扩大农产品电商销售规模，促进农产品双向流通。" }]), { x: 2.0, y: 4.5, w: 5.4, h: 1.9, valign: "middle" });
  photo(s, "图07", 8.0, 1.6, 4.73, 5.0, "“供销市集”活动现场或助农直播间");
  s.addNotes("其次是优化产销对接机制。“供销市集”要常态化举办，全系统每年不少于150场，创新“市集+体育”“市集+景点”等模式；办好长三角、南京都市圈联展联销；大力发展直播带货、即时零售和“村播”“田播”；推动“鲜丰汇”由政采平台向公共平台拓展，扩大农产品电商销售规模。");

  // ===== 12 行动二：消费帮扶与循环利用 =====
  s = content("五大重点行动", "提升消费帮扶水平，畅通循环利用链条", "行动二 · 农村现代流通服务提档");
  const two12 = [
    ["图08", "消费帮扶专馆专区、对口地区特色农产品", "提升消费帮扶水平", ["推进消费帮扶专馆、专柜、专区建设，做好“土特产”文章", "在苏建设农产品前置仓，在帮扶地区建生产基地、源头直采", "支持省级消费帮扶采购平台打造主阵地"]],
    ["图09", "标准化再生资源回收站点或废旧家电回收", "畅通循环利用链条", ["新建改造一批标准化、规范化回收站点", "参与“两新”行动，开展“新三样”和废旧3C电子产品回收", "拓展废旧汽车、新能源废旧电池回收；参与“公物仓”“两网融合”"]],
  ];
  two12.forEach((c, i) => {
    const x = 0.6 + i * 6.215, w = 5.915;
    card(s, x, 1.6, w, 5.0);
    photo(s, c[0], x + 0.2, 1.8, w - 0.4, 1.9, c[1]);
    txt(s, c[2], { x: x + 0.3, y: 3.85, w: w - 0.6, h: 0.45, fontSize: 18, bold: true, color: C.text2 });
    txt(s, bullets(c[3], 14), { x: x + 0.3, y: 4.4, w: w - 0.6, h: 2.1 });
  });
  s.addNotes("同时，要提升消费帮扶水平，推进消费帮扶专馆专柜专区建设，在苏建设农产品前置仓，助力对口地区做好“土特产”文章。还要畅通循环利用链条，新建改造一批标准化回收站点，积极参与大规模设备更新和消费品以旧换新，拓展废旧家电、新能源废旧电池等回收利用业务。");

  // ===== 13 行动三：设施体系 =====
  s = content("五大重点行动", "完善冷链设施体系：“产地仓+销地仓+中转仓”", "行动三 · 农产品冷链物流服务提升");
  const wh = [["产地仓", "田头集货 预冷保鲜"], ["中转仓", "干线集散 区域调度"], ["销地仓", "城市配送 终端直达"]];
  wh.forEach((w3, i) => {
    const x = 0.6 + i * 2.5;
    s.addShape(pres.shapes.OVAL, { x: x + 0.15, y: 1.65, w: 1.7, h: 1.7, fill: { color: i === 1 ? C.text2 : C.accent1 }, line: { color: C.background1, width: 3 } });
    txt(s, w3[0], { x: x + 0.15, y: 1.65, w: 1.7, h: 1.7, fontSize: 18, bold: true, color: C.background1, align: "center", valign: "middle" });
    txt(s, w3[1], { x, y: 3.45, w: 2.0, h: 0.4, fontSize: 13, color: C.accent4, align: "center" });
    if (i < 2) arrow(s, x + 1.95, 2.3, 0.5, 0.4);
  });
  card(s, 0.6, 4.1, 3.0, 2.5, C.text2);
  txt(s, [{ text: "70", options: { fontSize: 50, bold: true, color: C.accent3, breakLine: false } }, { text: " 万吨", options: { fontSize: 18, bold: true, color: C.background1 } }], { x: 0.6, y: 4.3, w: 3.0, h: 1.2, align: "center", valign: "middle" });
  txt(s, "2030年系统农产品\n冷链库容", { x: 0.6, y: 5.5, w: 3.0, h: 0.9, fontSize: 14, color: C.background1, align: "center" });
  txt(s, bullets(["坚持整合为主、新建为辅，采取自建、共建、加盟等方式", "加强重大项目储备，争取中央预算内投资、地方政府专项债等支持", "推行“共享冷库”，盘活闲置仓储资源"], 14), { x: 3.9, y: 4.1, w: 3.9, h: 2.5, valign: "middle" });
  photo(s, "图10", 8.1, 1.6, 4.63, 5.0, "现代化冷库、产地预冷仓实景");
  s.addNotes("第三大行动是农产品冷链物流服务提升。要坚持整合为主、新建为辅，推动形成“产地仓+销地仓+中转仓”三级冷链设施体系，积极争取中央预算内投资和专项债支持，推行“共享冷库”模式。到2030年，系统农产品冷链库容达到70万吨。");

  // ===== 14 行动三：田间到餐桌 =====
  s = content("五大重点行动", "专业运营、一体管理，发展从田间到餐桌的全程冷链", "行动三 · 农产品冷链物流服务提升");
  const chain = ["田头预冷", "分拣包装", "保鲜加工", "冷链运输", "配送到餐桌"];
  chain.forEach((t, i) => {
    const w = 2.55, x = 0.6 + i * 2.395;
    s.addShape(i === 0 ? pres.shapes.PENTAGON : pres.shapes.CHEVRON, { x, y: 1.6, w, h: 0.9, fill: { color: i % 2 ? C.accent2 : C.accent1 }, line: { color: C.background1, width: 1 } });
    txt(s, t, { x: x + (i === 0 ? 0.1 : 0.45), y: 1.6, w: w - 0.9, h: 0.9, fontSize: 16, bold: true, color: C.background1, align: "center", valign: "middle" });
  });
  const ops = [
    [fa.FaHandshake, "推进专业运营", "江苏冷链与市县组建区域冷链运营公司，承接徐州贾汪等项目；推广田头预冷移动库、新能源冷藏车；发展“冷链配送+连锁零售”“生鲜电商+冷链宅配”"],
    [fa.FaNetworkWired, "强化一体管理", "推广“江苏冷链物流智慧综合服务平台”，一网统管、全域调度；苏合冷链与中国供销冷链合作；实现全程可视化、可追溯"],
  ];
  for (let i = 0; i < 2; i++) {
    const x = 0.6 + i * 4.14, w = 3.84;
    card(s, x, 2.85, w, 3.75);
    await iconCircle(s, ops[i][0], x + 0.3, 3.1, 0.75);
    txt(s, ops[i][1], { x: x + 1.2, y: 3.1, w: w - 1.4, h: 0.75, fontSize: 17, bold: true, color: C.text2, valign: "middle" });
    txt(s, ops[i][2], { x: x + 0.3, y: 4.0, w: w - 0.6, h: 2.45, fontSize: 15, lineSpacingMultiple: 1.2, color: C.text1 });
  }
  photo(s, "图11", 8.88, 2.85, 3.85, 3.75, "新能源冷藏车或冷链智慧平台大屏");
  s.addNotes("在运营和管理上，要推动江苏冷链与市县组建区域冷链运营公司，为小农户、家庭农场提供田头预冷、分拣包装、保鲜加工等服务，发展从田间到餐桌的全程冷链。同时推广江苏冷链物流智慧综合服务平台，实现一网统管、全域调度，全程可视化、可追溯，增强农产品应急保供能力。");

  // ===== 15 行动四：治理与社企改革 =====
  s = content("五大重点行动", "完善联合社治理，深化社有企业改革", "行动四 · 综合改革提效");
  const ref = [
    [fa.FaBalanceScale, "完善联合社治理机制", ["严格依照《章程》，健全社员代表大会、理事会、监事会“三会”制度", "建立出资人监管权责清单、投资项目负面清单和主业清单", "构建纪检、巡察、财审、监事会、资产管理协同的联合监督体系", "支持昆山市先行先试，发挥全国总社基层联系点示范作用"]],
    [fa.FaBuilding, "深化社有企业改革", ["明确党组织、董事会、经理层权责边界，压缩管理层级", "深化人事管理、劳动用工、收入分配“三项制度”改革", "支持社有企业跨区域跨层级联合合作，支持天合云商等新三板挂牌", "统筹内部培养和外部引进，打造专业化人才队伍"]],
  ];
  for (let i = 0; i < 2; i++) {
    const x = 0.6 + i * 6.215, w = 5.915;
    card(s, x, 1.6, w, 5.0);
    await iconCircle(s, ref[i][0], x + 0.3, 1.85, 0.85);
    txt(s, ref[i][1], { x: x + 1.35, y: 1.85, w: w - 1.6, h: 0.85, fontSize: 20, bold: true, color: C.text2, valign: "middle" });
    txt(s, bullets(ref[i][2], 16), { x: x + 0.3, y: 2.95, w: w - 0.6, h: 3.5 });
  }
  s.addNotes("第四大行动是综合改革提效。一方面要完善联合社治理机制，健全“三会”制度，建立权责清单、负面清单和主业清单，构建联合监督工作体系，支持昆山先行先试。另一方面要深化社有企业改革，推动党的领导融入公司治理各环节，深化“三项制度”改革，推动社有企业做优做强。");

  // ===== 16 行动四：基层社 =====
  s = content("五大重点行动", "推进基层社建设，夯实为农服务根基", "行动四 · 综合改革提效");
  card(s, 0.6, 1.6, 7.1, 1.2, C.text2);
  txt(s, [{ text: "深入实施  ", options: { color: C.accent5, fontSize: 16 } }, { text: "“千县千社质量提升行动”", options: { bold: true, color: C.background1, fontSize: 22 } }], { x: 0.9, y: 1.6, w: 6.6, h: 1.2, valign: "middle" });
  const ways = [[fa.FaProjectDiagram, "项目建设"], [fa.FaHandshake, "社企联动"], [fa.FaSyncAlt, "整合重组"], [fa.FaHome, "社村共建"]];
  for (let i = 0; i < 4; i++) {
    const x = 0.6 + i * 1.82;
    card(s, x, 3.05, 1.6, 1.5);
    await iconCircle(s, ways[i][0], x + 0.45, 3.2, 0.7, C.accent1);
    txt(s, ways[i][1], { x, y: 3.98, w: 1.6, h: 0.45, fontSize: 15, bold: true, color: C.text2, align: "center" });
  }
  txt(s, bullets(["压实县级社主体责任，统筹基层社资产、财务、业务、人员管理", "以农业社会化服务为重点重构基层社服务体系，创建一批全国总社示范基层社", "支持基层社承担政府购买服务；选聘“新农人”担任基层社负责人"], 14), { x: 0.6, y: 4.8, w: 7.1, h: 1.8 });
  photo(s, "图12", 8.0, 1.6, 4.73, 5.0, "基层供销社门店、为农服务中心外景");
  s.addNotes("基层社是供销合作社的根基。要落实基层社提档升级行动方案，压实县级社主体责任，采取项目建设、社企联动、整合重组、社村共建等方式重构基层社服务体系，深入实施“千县千社质量提升行动”，创建一批全国总社示范基层社，并选聘“新农人”担任基层社负责人。");

  // ===== 17 行动五：数字供销与AI =====
  s = content("五大重点行动", "推进“数字供销”建设，加快人工智能应用", "行动五 · 新质生产力发展提速");
  card(s, 0.6, 1.6, 3.95, 5.0);
  await iconCircle(s, fa.FaDatabase, 0.9, 1.85, 0.8);
  txt(s, "数字供销", { x: 1.85, y: 1.85, w: 2.5, h: 0.8, fontSize: 20, bold: true, color: C.text2, valign: "middle" });
  txt(s, bullets(["农资、农服、流通、再生资源等主营业务数字化转型、智能化改造", "推进省市县“数字供销”平台融合衔接", "依托天合云商打造有影响力的数字科技服务商"], 14), { x: 0.9, y: 2.9, w: 3.4, h: 3.5 });
  card(s, 4.8, 1.6, 3.95, 5.0);
  await iconCircle(s, fa.FaRobot, 5.1, 1.85, 0.8, C.accent3);
  txt(s, "人工智能+", { x: 6.05, y: 1.85, w: 2.5, h: 0.8, fontSize: 20, bold: true, color: C.text2, valign: "middle" });
  ["智慧农服", "智慧电商", "智慧冷链"].forEach((t, i) => {
    const x = 5.1 + i * 1.15;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 2.95, w: 1.05, h: 0.55, rectRadius: 0.1, fill: { color: C.accent1 }, line: { color: C.accent1 } });
    txt(s, t, { x, y: 2.95, w: 1.05, h: 0.55, fontSize: 13, bold: true, color: C.background1, align: "center", valign: "middle" });
  });
  txt(s, bullets(["依托遥感监测、病虫害智能识别、产销大数据预测等技术", "完善精准农事指导、农资智能配供、产销对接服务"], 14), { x: 5.1, y: 3.75, w: 3.4, h: 2.7 });
  photo(s, "图13", 9.0, 1.6, 3.73, 5.0, "智慧农业、无人机植保或数字供销平台界面");
  s.addNotes("第五大行动是新质生产力发展提速。一是推进“数字供销”建设，推动主营业务数字化转型、智能化改造，推进省市县平台融合衔接。二是加快人工智能应用，支持有条件的供销社开展“人工智能+”行动，探索智慧农服、智慧电商、智慧冷链等场景，用遥感监测、病虫害识别、大数据预测等技术提升服务精准度。");

  // ===== 18 行动五：标准与品牌 =====
  s = content("五大重点行动", "加强标准和品牌建设，打造为农服务品牌矩阵", "行动五 · 新质生产力发展提速");
  const brands = [["企业品牌", 0.9, 1.75], ["产品品牌", 3.5, 1.75], ["服务品牌", 2.2, 3.7]];
  brands.forEach((b, i) => {
    s.addShape(pres.shapes.OVAL, { x: b[1], y: b[2], w: 2.3, h: 2.3, fill: { color: [C.accent1, C.accent2, C.text2][i], transparency: 10 }, line: { color: C.background1, width: 3 } });
    txt(s, b[0], { x: b[1], y: b[2], w: 2.3, h: 2.3, fontSize: 18, bold: true, color: C.background1, align: "center", valign: "middle" });
  });
  txt(s, "为农服务品牌矩阵", { x: 0.6, y: 6.1, w: 6.0, h: 0.45, fontSize: 16, bold: true, color: C.text2, align: "center" });
  const br = [
    [fa.FaClipboardCheck, "参与行业标准", "鼓励社有企业、行业协会参与行业标准制定和推广应用，巩固行业地位"],
    [fa.FaAward, "擦亮品牌名片", "鼓励老字号创新发展，积极承接农产品区域公用品牌管理运营"],
    [fa.FaTrademark, "打造“供销市集”IP", "完成江苏“供销市集”商标注册，打造“助农增收、便民消费”品牌IP"],
  ];
  for (let i = 0; i < 3; i++) {
    const y = 1.6 + i * 1.7;
    card(s, 6.9, y, 5.83, 1.45);
    await iconCircle(s, br[i][0], 7.15, y + 0.3, 0.85, C.accent3);
    txt(s, blocks([{ h: br[i][1], b: br[i][2] }]), { x: 8.2, y: y + 0.12, w: 4.35, h: 1.25, valign: "middle" });
  }
  s.addNotes("同时，要加强标准和品牌建设。鼓励社有企业参与行业标准制定，培育企业品牌、产品品牌、服务品牌，形成为农服务品牌矩阵；鼓励老字号创新发展，承接区域公用品牌运营；完成江苏“供销市集”商标注册，打造“助农增收、便民消费”的品牌IP。");

  // ===== 19 组织保障 =====
  pres.addSection({ title: "组织保障" });
  s = content("组织保障", "强化组织保障，确保方案落地落实", "03 组织保障与工作要求");
  const guard = [
    [fa.FaFlag, "坚持党的全面领导", "把党的全面领导贯穿供销合作社改革发展全过程各方面"],
    [fa.FaHandsHelping, "争取政策支持", "主动向党委政府汇报，加强与发改、财政、农业农村、商务等部门沟通协调"],
    [fa.FaFolderOpen, "抓好项目库建设", "做好省级发展项目库建设，入库项目省级专项资金予以重点支持"],
    [fa.FaGraduationCap, "深化产教融合", "发挥江苏商贸职业学院、徐州经贸高职校优势，加强人才培养和成果转化"],
    [fa.FaShieldAlt, "统筹发展和安全", "压实社有企业安全生产主体责任，常态化开展隐患排查整治"],
    [fa.FaBullhorn, "加强宣传引导", "讲好供销合作社故事，营造良好发展环境和社会氛围"],
  ];
  for (let i = 0; i < 6; i++) {
    const x = 0.6 + (i % 3) * 4.14, y = 1.6 + Math.floor(i / 3) * 2.55, w = 3.85;
    card(s, x, y, w, 2.3);
    await iconCircle(s, guard[i][0], x + 0.3, y + 0.3, 0.75, i === 0 ? C.accent3 : C.accent1);
    txt(s, guard[i][1], { x: x + 1.2, y: y + 0.3, w: w - 1.4, h: 0.75, fontSize: 17, bold: true, color: C.text2, valign: "middle" });
    txt(s, guard[i][2], { x: x + 0.3, y: y + 1.2, w: w - 0.6, h: 1.0, fontSize: 14, color: C.text1 });
  }
  s.addNotes("最后，在组织保障上，要坚持党的全面领导，主动向党委政府汇报，争取发改、财政、农业农村、商务等部门的政策支持；做好省级项目库建设，对入库项目给予专项资金重点支持；深化产教融合，统筹发展和安全，加强宣传引导。各地要紧密结合实际，加强衔接和上下协同。");

  // ===== 20 结束 =====
  s = pres.addSlide({ masterName: "COVER", sectionTitle: "组织保障" });
  photo(s, "图14", 7.33, 0, 6.0, 7.5, "结束页配图：丰收田野、乡村振兴或供销人员服务农民");
  txt(s, "以“一体两业三网”建设为牵引", { x: 0.8, y: 1.9, w: 6.3, h: 0.6, fontSize: 22, color: C.accent5 });
  txt(s, "奋力开创全省供销合作社\n高质量发展新局面", { x: 0.8, y: 2.6, w: 6.3, h: 1.9, fontSize: 36, bold: true, color: C.background1 });
  txt(s, "谢  谢！", { x: 0.8, y: 5.0, w: 6.3, h: 0.8, fontSize: 32, bold: true, color: C.accent3 });
  s.addNotes("同志们，未来五年是供销合作社深化改革、加快发展的关键时期。让我们以“一体两业三网”建设为牵引，扎实推进五大行动，确保行动方案落地落实，奋力开创全省供销合作社高质量发展新局面。谢谢大家！");

  // ---------- placeholder images, write, theme ----------
  fs.writeFileSync(path.join(__dirname, "slots.json"), JSON.stringify(slots, null, 1));
  execFileSync("python3", [path.join(__dirname, "ph.py"), path.join(__dirname, "slots.json"), IMGDIR], { stdio: "inherit" });
  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote", OUT, "slots", slots.length);
})().catch((e) => { console.error(e); process.exit(1); });
