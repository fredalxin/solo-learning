import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getDocument, GlobalWorkerOptions, OPS } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { applyDocumentPlan, compactDocumentOutline, compareDocumentTitles, extractMarkdownArchive, MAX_DOCUMENT_IMAGES, parseDocumentOutline } from "./documentArchive.js";
import { scopeSceneSvgStyles } from "./sceneSvg.js";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  GripVertical,
  Link2,
  Menu,
  MessageCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import "./styles.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function fileToDataUrl(file) {
  const image = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}

function selectDocumentImageData(images, names) {
  const entries = (images || []).map((image, index) => typeof image === "string"
    ? { name: "", dataUrl: image, index }
    : { ...image, index });
  if (!Array.isArray(names)) return entries.map((image) => image.dataUrl);
  if (!names.length) return [];
  const wanted = new Set(names.map((name) => String(name).replace(/\\/g, "/")));
  const namedEntries = entries.filter((image) => image.name);
  if (!namedEntries.length) return entries.map((image) => image.dataUrl);
  return namedEntries.filter((image) => {
    const name = String(image.name).replace(/\\/g, "/");
    return wanted.has(name) || [...wanted].some((wantedName) => wantedName.endsWith(`/${name}`) || name.endsWith(`/${wantedName}`));
  }).map((image) => image.dataUrl);
}

async function extractPdfDocument(file) {
  const pdf = await getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  const visualPages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = [];
    let line = "";
    content.items.forEach((item) => {
      line += `${line ? " " : ""}${item.str}`;
      if (item.hasEOL) {
        if (line.trim()) lines.push(line.replace(/\s+/g, " ").trim());
        line = "";
      }
    });
    if (line.trim()) lines.push(line.replace(/\s+/g, " ").trim());
    const text = lines.join("\n");
    if (text) pages.push(`【第 ${pageNumber} 页】\n${text}`);
    const operators = await page.getOperatorList();
    if (operators.fnArray.some((operation) => (
      operation === OPS.paintImageXObject
      || operation === OPS.paintInlineImageXObject
      || operation === OPS.paintImageMaskXObject
    ))) visualPages.push(pageNumber);
  }
  // ponytail: cap rendered pages to bound upload size; raise only if model/image limits increase.
  const candidates = visualPages.length
    ? visualPages
    : Array.from({ length: pdf.numPages }, (_, index) => index + 1);
  const pageNumbers = candidates.length <= MAX_DOCUMENT_IMAGES
    ? candidates
    : Array.from({ length: MAX_DOCUMENT_IMAGES }, (_, index) => (
        candidates[Math.round(index * (candidates.length - 1) / (MAX_DOCUMENT_IMAGES - 1))]
      ));
  const images = [];
  for (const pageNumber of pageNumbers) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.35 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    images.push({ name: `${file.name} · 第 ${pageNumber} 页`, dataUrl: canvas.toDataURL("image/jpeg", 0.78) });
  }
  const text = pages.join("\n\n");
  return { text, images, outline: parseDocumentOutline(text) };
}

/* Solo archive per-node palettes (4 sets from the 22-token color card)
   Each canvas picks one of 4 harmonious 4-color sets drawn from
   Solo's editorial archive tokens. All four sets stay inside the
   warm earth-tone range so canvases feel like one editorial family. */
const palettes = [
  /* default: Terra Cotta / Honey Wheat / Moss Green / Stone Rule */
  ["#D0937F", "#D6B06C", "#88A2B9", "#D9D1C9"],
  /* info: Dusty Mauve / Slate Blue / Moss Green / Sky Tint */
  ["#B6ABBC", "#88A2B9", "#88A2B9", "#DBE5ED"],
  /* warm: Brick Clay / Terra Cotta / Honey Wheat / Terra Tint */
  ["#CF8275", "#D0937F", "#D6B06C", "#F0DED7"],
  /* sage-anchored: Moss Green / Honey Wheat / Slate Blue / Sage Tint */
  ["#88A2B9", "#D6B06C", "#88A2B9", "#DBE5ED"],
];

const DEFAULT_BOARD_HEIGHT = 480;
const ANSWER_COPY_WIDTH = 484;
const DEFAULT_SCENE_ASPECT_RATIO = 1200 / 760;
const DEFAULT_BOARD_WIDTH = Math.round(
  ANSWER_COPY_WIDTH + (DEFAULT_BOARD_HEIGHT - 2) * DEFAULT_SCENE_ASPECT_RATIO + 2,
);
const BOARD_GAP_X = 180;
const BOARD_GAP_Y = 140;
const DEFAULT_CAMERA = { x: 80, y: 60, scale: 0.78 };
const DEFAULT_VISUAL_CONFIG = {
  space: "auto",
  style: "auto",
  tone: "auto",
  domain: "auto",
};
const VISUAL_CONFIG_OPTIONS = {
  space: [
    ["auto", "自动选择"],
    ["2d", "2D 平面"],
    ["isometric", "2.5D 等距"],
    ["pseudo-3d", "伪 3D 透视"],
    ["section", "剖面 / 爆炸图"],
  ],
  style: [
    ["auto", "自动选择"],
    ["realistic", "写实场景"],
    ["technical", "工业制图"],
    ["infographic", "科普信息图"],
    ["line-art", "精细线稿"],
    ["handdrawn", "怪诞手绘"],
    ["minimal", "极简图解"],
  ],
  tone: [
    ["auto", "跟随内容"],
    ["natural", "自然真实"],
    ["bright", "明亮清晰"],
    ["cool", "冷静专业"],
    ["warm", "温暖友好"],
    ["contrast", "高对比"],
  ],
  domain: [
    ["auto", "自动识别"],
    ["technology", "科技电子"],
    ["industry", "工业制造"],
    ["medical", "医疗人体"],
    ["nature", "自然科学"],
    ["business", "商业产业"],
    ["history", "历史文化"],
    ["software", "软件互联网"],
    ["daily", "生活原理"],
  ],
};
const VISUAL_CONFIG_GROUPS = [
  ["space", "空间", "空间表现"],
  ["style", "风格", "视觉风格"],
  ["tone", "色调", "色调"],
  ["domain", "领域", "领域"],
];
const USER_ID_STORAGE_KEY = "fast-learning-user-id";
const SIDEBAR_WIDTH_STORAGE_KEY = "fast-learning-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 230;
const MAX_SIDEBAR_WIDTH = 460;

function clampSidebarWidth(width) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function getStoredSidebarWidth() {
  try {
    const storedValue = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (storedValue === null) return DEFAULT_SIDEBAR_WIDTH;
    const storedWidth = Number(storedValue);
    return Number.isFinite(storedWidth)
      ? clampSidebarWidth(storedWidth)
      : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function getOrCreateUserId() {
  try {
    const stored = localStorage.getItem(USER_ID_STORAGE_KEY);
    if (/^user-[a-zA-Z0-9_-]{16,120}$/.test(stored || "")) return stored;
    const randomId = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const userId = `user-${randomId}`;
    localStorage.setItem(USER_ID_STORAGE_KEY, userId);
    return userId;
  } catch {
    return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
}

const browserUserId = getOrCreateUserId();
if (typeof window !== "undefined") window.__FAST_LEARNING_USER_ID__ = browserUserId;

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Fast-Learning-User-Id", browserUserId);
  return fetch(url, { ...options, headers });
}

const HOME_QUESTION_POOL = [
  "人工智能和传统程序有什么区别？",
  "大模型是怎样理解并生成文字的？",
  "ChatGPT 为什么有时会一本正经地答错？",
  "AI Agent 是什么，它和聊天机器人有什么区别？",
  "机器学习是怎样从数据中学会规律的？",
  "深度学习为什么需要大量显卡？",
  "神经网络为什么叫神经网络？",
  "AI 生成图片的基本原理是什么？",
  "语音助手是怎样听懂人说话的？",
  "推荐算法为什么越来越懂你的喜好？",
  "搜索引擎怎样找到最相关的网页？",
  "人脸识别是怎样确认一个人身份的？",
  "自动驾驶汽车是怎样看懂道路的？",
  "机器人怎样学会走路并保持平衡？",
  "芯片是怎样从沙子变成计算机核心的？",
  "CPU 和 GPU 到底有什么区别？",
  "手机芯片为什么能集成几十亿个晶体管？",
  "晶体管为什么可以表示 0 和 1？",
  "芯片制程中的 3 纳米是什么意思？",
  "光刻机为什么是制造先进芯片的关键？",
  "晶圆厂是怎样在芯片上画出电路的？",
  "芯片为什么会发热，散热器怎样降温？",
  "内存和硬盘有什么区别？",
  "HBM 为什么适合人工智能计算？",
  "固态硬盘为什么比机械硬盘快？",
  "量子计算机和普通计算机有什么区别？",
  "计算机为什么只用 0 和 1 工作？",
  "操作系统在计算机中负责什么？",
  "程序从点击图标到运行经历了什么？",
  "编程语言是怎样变成机器指令的？",
  "一个网站从输入网址到显示经历了什么？",
  "互联网怎样把消息送到地球另一端？",
  "Wi-Fi 是怎样在空气中传输数据的？",
  "5G 和 4G 的核心区别是什么？",
  "蓝牙耳机为什么不用网络也能连接手机？",
  "路由器在家庭网络中起什么作用？",
  "IP 地址和域名分别是什么？",
  "DNS 为什么被称为互联网的电话簿？",
  "网络延迟是怎样产生的？",
  "视频通话怎样保持声音和画面同步？",
  "在线视频为什么可以边下载边播放？",
  "照片和视频是怎样被压缩的？",
  "云计算中的云实际在哪里？",
  "云服务器和普通电脑有什么区别？",
  "数据中心为什么需要大量电力和水？",
  "服务器为什么通常放在专门的机房里？",
  "容器和虚拟机有什么区别？",
  "数据库是怎样快速找到一条数据的？",
  "缓存为什么能让应用运行得更快？",
  "分布式系统为什么需要很多台计算机协作？",
  "网站用户突然暴增时怎样避免崩溃？",
  "软件为什么需要不断更新？",
  "开源软件是什么，开发者为什么免费分享代码？",
  "应用程序为什么会出现 Bug？",
  "软件测试是怎样发现程序问题的？",
  "API 是什么，为什么软件都需要它？",
  "二维码是怎样存储并读取信息的？",
  "密码是怎样被安全保存的？",
  "HTTPS 怎样保护网页中的数据？",
  "黑客通常怎样攻击一个网站？",
  "勒索软件是怎样锁住电脑文件的？",
  "双重验证为什么比密码更安全？",
  "区块链为什么不需要中心数据库？",
  "比特币是怎样防止重复支付的？",
  "电子支付是怎样在几秒内完成的？",
  "手机触摸屏怎样知道手指的位置？",
  "手机相机为什么能拍出清晰照片？",
  "手机是怎样通过 GPS 确定位置的？",
  "降噪耳机怎样抵消外界声音？",
  "无线充电是怎样把电能传给手机的？",
  "OLED 和 LCD 屏幕有什么区别？",
  "高刷新率屏幕为什么看起来更流畅？",
  "电池为什么能储存电能？",
  "锂电池为什么会逐渐老化？",
  "快充为什么能缩短充电时间？",
  "电动汽车和燃油汽车结构有什么区别？",
  "电动汽车为什么需要电池管理系统？",
  "自动驾驶为什么需要激光雷达？",
  "太阳能电池板怎样把阳光变成电？",
  "风力发电机怎样把风转化为电能？",
  "智能电网怎样调度不同来源的电力？",
  "核聚变发电为什么那么难实现？",
  "卫星为什么能绕着地球一直飞行？",
  "火箭为什么要设计成多级结构？",
  "卫星互联网怎样让偏远地区接入网络？",
  "无人机怎样保持悬停和稳定飞行？",
  "3D 打印机是怎样一层层制造物体的？",
  "AR 和 VR 有什么区别？",
  "智能家居设备是怎样互相通信的？",
  "数字孪生是什么，它能解决什么问题？",
];
const STOCK_SECTOR_QUESTION_POOL = [
  "什么是光模块？",
  "MLCC 是什么？",
  "什么是半导体设备？",
  "什么是半导体材料？",
  "晶圆代工是做什么的？",
  "芯片设计公司靠什么赚钱？",
  "封装测试在芯片产业链中做什么？",
  "先进封装为什么受到关注？",
  "存储芯片为什么有明显周期？",
  "模拟芯片和数字芯片有什么区别？",
  "功率半导体主要用在哪里？",
  "碳化硅芯片为什么适合新能源汽车？",
  "氮化镓是什么，主要应用在哪里？",
  "光刻胶在芯片制造中有什么作用？",
  "电子特气为什么是半导体关键材料？",
  "硅片和晶圆有什么区别？",
  "EDA 软件为什么被称为芯片设计工具？",
  "IP 核在芯片设计中是什么？",
  "MCU 芯片主要用在哪些设备中？",
  "射频芯片为什么是手机的重要部件？",
  "AI 服务器和普通服务器有什么区别？",
  "算力产业通常包含哪些环节？",
  "GPU 产业链中有哪些主要公司类型？",
  "光模块为什么与 AI 算力需求相关？",
  "CPO 是什么，为什么受到光通信行业关注？",
  "交换机在数据中心里起什么作用？",
  "液冷为什么会成为数据中心散热方案？",
  "IDC 是什么，它靠什么赚钱？",
  "算力租赁是什么商业模式？",
  "服务器电源为什么受益于算力建设？",
  "PCB 在 AI 服务器中有什么作用？",
  "高速铜连接是什么？",
  "光纤光缆和光模块有什么区别？",
  "运营商建设投入会带动哪些产业需求？",
  "卫星通信产业链包括哪些环节？",
  "6G 概念主要关注哪些技术方向？",
  "边缘计算和云计算有什么区别？",
  "数据要素产业主要解决什么问题？",
  "信创产业通常包含哪些领域？",
  "网络安全公司的主要收入来自哪里？",
  "消费电子领域包括哪些产品？",
  "智能手机产业链有哪些主要环节？",
  "折叠屏会带动哪些零部件需求？",
  "手机摄像头模组是做什么的？",
  "CIS 图像传感器是什么？",
  "手机射频前端包含哪些芯片？",
  "连接器在电子产品中有什么作用？",
  "声学器件主要应用在哪些产品中？",
  "触控显示模组是什么？",
  "OLED 产业链包含哪些环节？",
  "Mini LED 和 Micro LED 有什么区别？",
  "面板行业为什么有周期性？",
  "被动元件包括哪些主要产品？",
  "电感、电容和电阻分别有什么作用？",
  "消费电子代工厂如何获得收入？",
  "AR 眼镜产业链有哪些关键零部件？",
  "智能手表会带动哪些传感器需求？",
  "电子纸主要应用在哪些场景？",
  "机器视觉在工业中有什么作用？",
  "汽车电子为什么持续增长？",
  "新能源汽车产业链包括哪些环节？",
  "动力电池和储能电池有什么区别？",
  "电池正极材料有哪些主要路线？",
  "负极材料在锂电池中有什么作用？",
  "电解液和隔膜分别有什么作用？",
  "锂电池结构件是做什么的？",
  "电池回收行业如何形成商业闭环？",
  "固态电池和液态电池有什么区别？",
  "钠离子电池适合哪些应用场景？",
  "换电模式和充电模式有什么区别？",
  "充电桩产业链包括哪些环节？",
  "汽车热管理系统为什么重要？",
  "智能座舱主要包含哪些产品？",
  "线控底盘是什么？",
  "毫米波雷达和激光雷达有什么区别？",
  "汽车轻量化会带动哪些材料需求？",
  "一体化压铸是什么？",
  "汽车零部件公司如何进入整车厂供应链？",
  "汽车经销商主要靠什么赚钱？",
  "光伏产业链包括哪些环节？",
  "硅料、硅片、电池片和组件是什么关系？",
  "TOPCon 电池是什么？",
  "HJT 电池是什么？",
  "钙钛矿电池为什么受到关注？",
  "光伏逆变器有什么作用？",
  "光伏玻璃和普通玻璃有什么区别？",
  "胶膜在光伏组件中有什么作用？",
  "风电产业链包括哪些环节？",
  "风机大型化会影响哪些零部件？",
  "海上风电和陆上风电有什么区别？",
  "风电塔筒和海缆分别是什么？",
  "储能系统由哪些设备组成？",
  "储能变流器 PCS 是什么？",
  "电化学储能如何参与电力市场？",
  "虚拟电厂是什么？",
  "特高压为什么与新能源消纳相关？",
  "智能电网系统包括哪些设备？",
  "核电产业链包含哪些环节？",
  "氢能源产业链包括哪些部分？",
  "工业自动化主要解决什么问题？",
  "PLC 在工厂中有什么作用？",
  "伺服系统是什么？",
  "变频器为什么能帮助工业设备节能？",
  "工业机器人由哪些核心部件组成？",
  "减速器在机器人中有什么作用？",
  "人形机器人产业链包括哪些环节？",
  "机器人关节模组是什么？",
  "滚珠丝杠为什么与人形机器人相关？",
  "力矩传感器有什么作用？",
  "数控机床为什么被称为工业母机？",
  "机床刀具企业如何提供产品和服务？",
  "激光设备主要应用在哪些制造环节？",
  "工业软件包括哪些类型？",
  "智能制造和传统制造有什么区别？",
  "检测设备为什么是制造业的重要环节？",
  "仪器仪表主要服务哪些行业？",
  "叉车行业的需求来自哪里？",
  "工程机械为什么具有周期性？",
  "专用设备企业如何判断下游需求变化？",
  "航空发动机产业链有哪些环节？",
  "军工电子主要包含哪些产品？",
  "雷达产业链包括哪些核心部件？",
  "卫星制造和卫星应用有什么区别？",
  "商业航天产业链包含哪些环节？",
  "低空经济主要涉及哪些产业？",
  "无人机产业链有哪些关键环节？",
  "船舶制造为什么具有长周期特征？",
  "大飞机产业链包括哪些供应商？",
  "复合材料为什么广泛用于航空航天？",
  "医药产业通常分为哪些细分领域？",
  "创新药和仿制药有什么区别？",
  "CXO 是什么商业模式？",
  "CRO、CDMO 和 CMO 有什么区别？",
  "原料药和制剂有什么区别？",
  "医疗器械领域包括哪些产品？",
  "高值耗材和低值耗材有什么区别？",
  "体外诊断 IVD 是什么？",
  "医学影像设备包括哪些类型？",
  "中药产业的发展动力来自哪些方面？",
  "药店主要靠什么赚钱？",
  "医疗服务公司有哪些商业模式？",
  "医保谈判会怎样影响创新药公司？",
  "集采会怎样影响医药企业？",
  "疫苗公司的业绩为什么波动较大？",
  "生物制药和化学制药有什么区别？",
  "细胞治疗是什么？",
  "基因治疗产业链包括哪些环节？",
  "医美产业链中各环节如何分工？",
  "养老产业包含哪些商业模式？",
  "白酒行业为什么重视批发价格和库存？",
  "啤酒企业的经营表现受哪些因素影响？",
  "乳制品行业如何观察供需变化？",
  "调味品公司为什么通常具有品牌壁垒？",
  "休闲食品行业有哪些销售渠道？",
  "预制菜产业链包括哪些环节？",
  "餐饮连锁公司如何实现扩张？",
  "旅游行业的发展状态可以看哪些指标？",
  "酒店行业为什么关注入住率和房价？",
  "免税行业的商业模式是什么？",
  "家电行业为什么会受到地产和出口影响？",
  "智能家居产业链包括哪些产品？",
  "家具公司的收入为什么与地产相关？",
  "纺织服装产业链如何分工？",
  "化妆品公司的核心竞争力是什么？",
  "宠物经济包括哪些产品和服务？",
  "游戏公司的收入从哪里来？",
  "影视公司的业绩为什么波动较大？",
  "教育行业有哪些主要商业模式？",
  "零售行业的同店增长是什么意思？",
  "种业为什么重视品种审定？",
  "生猪养殖为什么有猪周期？",
  "鸡肉养殖行业如何观察供需变化？",
  "饲料企业的经营表现受哪些因素影响？",
  "动物疫苗行业的需求来自哪里？",
  "农药和化肥有什么区别？",
  "农业机械需求受哪些因素驱动？",
  "粮食价格会影响哪些产业环节？",
  "水产养殖有哪些主要品种？",
  "冷链物流为什么对生鲜行业重要？",
  "化工行业为什么有明显周期？",
  "煤化工和石油化工有什么区别？",
  "精细化工和基础化工有什么区别？",
  "氟化工产品主要应用在哪里？",
  "磷化工为什么与新能源相关？",
  "钛白粉是什么，主要用在哪里？",
  "有机硅是什么，主要应用在哪些行业？",
  "碳纤维为什么属于高性能材料？",
  "玻璃纤维主要用在哪些领域？",
  "可降解塑料产业链包括哪些环节？",
  "钢铁行业为什么关注吨钢收益和成本？",
  "有色金属包括哪些主要品种？",
  "铜价上涨会影响哪些行业？",
  "铝产业链包括哪些加工环节？",
  "锂资源公司和锂电材料公司有什么区别？",
  "稀土为什么被称为工业维生素？",
  "黄金价格通常受哪些因素影响？",
  "煤炭企业的经营表现由什么决定？",
  "油气开采和油服公司有什么区别？",
  "航运行业为什么具有强周期性？",
  "集装箱航运和油轮运输有什么区别？",
];
const STOCK_TOPIC_EXPANSION_SUBJECTS = [
  "先进制程",
  "成熟制程",
  "晶圆制造",
  "半导体封装",
  "半导体测试",
  "光刻设备",
  "刻蚀设备",
  "薄膜沉积设备",
  "离子注入设备",
  "半导体清洗设备",
  "电子特气",
  "光刻胶",
  "硅片",
  "掩膜版",
  "存储芯片",
  "模拟芯片",
  "功率半导体",
  "汽车芯片",
  "AI 芯片",
  "服务器",
  "数据中心",
  "光通信",
  "高速连接器",
  "液冷散热",
  "PCB",
  "消费电子",
  "智能手机",
  "可穿戴设备",
  "智能眼镜",
  "显示面板",
  "被动元件",
  "新能源汽车",
  "动力电池",
  "固态电池",
  "充电桩",
  "智能驾驶",
  "汽车零部件",
  "光伏",
  "风电",
  "储能",
  "氢能源",
  "核电",
  "智能电网",
  "工业机器人",
  "人形机器人",
  "工业母机",
  "工业软件",
  "工程机械",
  "商业航天",
  "低空经济",
  "军工电子",
  "创新药",
  "医疗器械",
  "医疗服务",
  "中药",
  "医美",
  "白酒",
  "食品饮料",
  "家电",
  "游戏",
  "农业",
  "化工",
  "钢铁",
  "铜",
  "铝",
  "锂",
  "稀土",
  "黄金",
  "煤炭",
  "油气",
  "航运",
];
const STOCK_TOPIC_QUESTION_TEMPLATES = [
  (topic) => `${topic}领域的核心产品和服务是什么？`,
  (topic) => `${topic}产业链的上中下游如何分工？`,
  (topic) => `${topic}行业的主要需求由什么驱动？`,
  (topic) => `${topic}企业的成本和经营表现主要受什么影响？`,
  (topic) => `判断${topic}行业发展状态通常看哪些指标？`,
  (topic) => `${topic}企业通常依靠什么建立竞争壁垒？`,
  (topic) => `${topic}行业为什么会出现周期波动？`,
  (topic) => `政策变化会怎样影响${topic}行业？`,
  (topic) => `了解${topic}领域时需要注意哪些挑战？`,
  (topic) => `${topic}行业的技术升级会怎样改变市场格局？`,
];
const STOCK_TOPIC_EXPANSION_POOL = STOCK_TOPIC_EXPANSION_SUBJECTS.flatMap((topic) => (
  STOCK_TOPIC_QUESTION_TEMPLATES.map((template) => template(topic))
));
const ALL_HOME_QUESTIONS = [
  ...HOME_QUESTION_POOL,
  ...STOCK_SECTOR_QUESTION_POOL,
  ...STOCK_TOPIC_EXPANSION_POOL,
];

function pickHomeQuestions(count = 3, excluded = []) {
  const excludedSet = new Set(excluded);
  return ALL_HOME_QUESTIONS
    .filter((question) => !excludedSet.has(question))
    .map((question) => ({ question, order: Math.random() }))
    .sort((a, b) => a.order - b.order)
    .slice(0, count)
    .map((item) => item.question);
}

function normalizeCamera(camera) {
  const x = Number(camera?.x);
  const y = Number(camera?.y);
  const scale = Number(camera?.scale);
  return {
    x: Number.isFinite(x) ? x : DEFAULT_CAMERA.x,
    y: Number.isFinite(y) ? y : DEFAULT_CAMERA.y,
    scale: Number.isFinite(scale) ? Math.min(1.35, Math.max(0.08, scale)) : DEFAULT_CAMERA.scale,
  };
}

function normalizeVisualConfig(config) {
  return Object.fromEntries(Object.entries(DEFAULT_VISUAL_CONFIG).map(([key, fallback]) => {
    const allowed = new Set(VISUAL_CONFIG_OPTIONS[key].map(([value]) => value));
    return [key, allowed.has(config?.[key]) ? config[key] : fallback];
  }));
}

function serializeVisualConfig(config) {
  const normalized = normalizeVisualConfig(config);
  return Object.fromEntries(Object.entries(normalized).map(([key, value]) => {
    const label = VISUAL_CONFIG_OPTIONS[key].find(([option]) => option === value)?.[1] || value;
    return [key, label];
  }));
}

function getVisualConfigLabel(key, value) {
  return VISUAL_CONFIG_OPTIONS[key].find(([option]) => option === value)?.[1] || value;
}

function createWorkspace() {
  const createdAt = new Date().toISOString();
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "新画布",
    nodes: [],
    camera: { ...DEFAULT_CAMERA },
    visualConfig: { ...DEFAULT_VISUAL_CONFIG },
    createdAt,
    updatedAt: createdAt,
  };
}

function getCreatedAtTimestamp(item) {
  const explicit = new Date(item?.createdAt).getTime();
  if (Number.isFinite(explicit)) return explicit;
  const idTimestamp = Number(String(item?.id || "").split("-")[0]);
  if (Number.isFinite(idTimestamp) && idTimestamp > 0) return idTimestamp;
  const firstNode = (item?.nodes || [])
    .map((node) => new Date(node.createdAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  if (Number.isFinite(firstNode)) return firstNode;
  const updated = new Date(item?.updatedAt).getTime();
  return Number.isFinite(updated) ? updated : 0;
}

function sortByCreatedAtDesc(items) {
  return items.slice().sort((a, b) => getCreatedAtTimestamp(b) - getCreatedAtTimestamp(a));
}

function compareNodeOrder(a, b) {
  const aOrder = Number(a?.siblingOrder);
  const bOrder = Number(b?.siblingOrder);
  if (Number.isFinite(aOrder) || Number.isFinite(bOrder)) {
    if (!Number.isFinite(aOrder)) return 1;
    if (!Number.isFinite(bOrder)) return -1;
    if (aOrder !== bOrder) return aOrder - bOrder;
  }
  if (a?.inputMode === "document" && b?.inputMode === "document") {
    const documentOrder = compareDocumentTitles(a, b);
    if (documentOrder) return documentOrder;
  }
  return getCreatedAtTimestamp(b) - getCreatedAtTimestamp(a);
}

function sortNodeSiblings(items) {
  return items.slice().sort(compareNodeOrder);
}

function getNodesInTreeOrder(items) {
  const childrenByParent = new Map();
  items.forEach((node) => {
    const parentId = node.parentId || null;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(node);
  });
  childrenByParent.forEach((children) => children.sort(compareNodeOrder));
  const ordered = [];
  const visit = (node) => {
    ordered.push(node);
    (childrenByParent.get(node.id) || []).forEach(visit);
  };
  (childrenByParent.get(null) || []).forEach(visit);
  return ordered;
}

function wrapConnectionTitle(title, maxLineWidth = 144) {
  const lines = [];
  let line = "";
  let lineWidth = 0;
  Array.from(String(title || "").trim()).forEach((character) => {
    const characterWidth = /[\u2e80-\u9fff\uf900-\ufaff]/i.test(character) ? 12 : 7;
    if (line && lineWidth + characterWidth > maxLineWidth) {
      lines.push({ text: line, width: lineWidth });
      line = "";
      lineWidth = 0;
    }
    line += character;
    lineWidth += characterWidth;
  });
  if (line || !lines.length) lines.push({ text: line || "未命名问题", width: lineWidth || 60 });
  return lines;
}

function normalizeWorkspaceStore(stored) {
  if (!Array.isArray(stored?.workspaces) || !stored.workspaces.length) {
    const workspace = createWorkspace();
    return {
      workspaces: [workspace],
      currentId: workspace.id,
      generationEstimateMs: 42_000,
    };
  }
  const restoredWorkspaces = stored.workspaces.map((item) => ({
    ...item,
    camera: normalizeCamera(item.camera),
    visualConfig: normalizeVisualConfig(item.visualConfig),
    nodes: (item.nodes || []).map((node) => {
      const boardSize = getSvgBoardSize(node.visual?.sceneSvg);
      const migratedNode = node.answerMode === "quick" && !node.visual
        ? {
            ...node,
            textReady: Boolean(node.summary),
            visualLoading: false,
            visualFailed: true,
            visualFailureMessage: "这是旧版快答节点，可点击重新生成补充图解。",
            width: boardSize.width,
            height: boardSize.height,
          }
        : {
            ...node,
            textReady: node.textReady ?? Boolean(node.summary),
            visualLoading: node.visualLoading ?? Boolean(node.loading || node.regenerating),
            visualFailed: node.visualFailed ?? Boolean(node.failed && node.summary),
            width: boardSize.width,
            height: boardSize.height,
          };
      if (
        migratedNode.textTaskId
        || migratedNode.visualTaskId
        || migratedNode.taskId
        || (!migratedNode.loading && !migratedNode.regenerating)
      ) return migratedNode;
      const wasRegenerating = Boolean(migratedNode.regenerating);
      return {
        ...migratedNode,
        loading: false,
        regenerating: false,
        failed: true,
        failureMessage: "页面刷新中断了结果接收，请点击重新生成继续。",
        retryKind: wasRegenerating && migratedNode.visual ? "regenerate" : "create",
      };
    }),
  }));
  return {
    workspaces: restoredWorkspaces,
    currentId: restoredWorkspaces.some((item) => item.id === stored.currentId)
      ? stored.currentId
      : restoredWorkspaces[0].id,
    generationEstimateMs: Number(stored.generationEstimateMs) || 42_000,
  };
}

async function saveStoreToServer(store) {
  const response = await apiFetch("/api/store", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(store),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "服务端保存失败");
  }
}

async function loadStoreFromServer() {
  const response = await apiFetch("/api/store");
  if (!response.ok) throw new Error("无法读取服务端画布数据");
  const remoteStore = await response.json();
  if (Array.isArray(remoteStore.workspaces) && remoteStore.workspaces.length) {
    return normalizeWorkspaceStore(remoteStore);
  }
  const initialStore = normalizeWorkspaceStore(remoteStore);
  await saveStoreToServer(initialStore);
  return initialStore;
}

async function loadShareFromServer(shareId) {
  const response = await fetch(`/api/shares/${encodeURIComponent(shareId)}`);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "分享画布不存在");
  return normalizeWorkspaceStore({
    workspaces: [result.workspace],
    currentId: result.workspace.id,
    generationEstimateMs: 42_000,
  });
}

function getShareIdFromLocation() {
  const legacyShareId = new URLSearchParams(window.location.search).get("share") || "";
  if (/^[a-f0-9]{32}$/.test(legacyShareId)) return legacyShareId;
  return window.location.pathname.match(/^\/share\/([a-f0-9]{32})(?:\/|$)/)?.[1] || "";
}

function startAnimatedFavicon() {
  const favicon = document.querySelector('link[rel="icon"]');
  if (!favicon || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const signalPath = [[32, 32], [27, 28], [22, 23], [17, 19], [32, 32], [27, 37], [22, 42], [17, 47], [32, 32], [38, 28], [44, 25], [49, 22]];
  let frame = 0;
  const render = () => {
    const [x, y] = signalPath[frame++ % signalPath.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#f8f3e8" stroke="#cfc1ad" stroke-width="1.5"/><g fill="none" stroke="#9a6c5f" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M32 32 17 19M32 32 17 47M32 32 49 22"/><circle cx="32" cy="32" r="6.5" fill="#d0937f" stroke="#d0937f"/><circle cx="17" cy="19" r="3.5" fill="#f8f3e8"/><circle cx="17" cy="47" r="3.5" fill="#f8f3e8"/><circle cx="49" cy="22" r="3.5" fill="#f8f3e8"/></g><circle cx="${x}" cy="${y}" r="2.4" fill="#d6b06c"/></svg>`;
    favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  };
  render();
  setInterval(render, 420);
}

function createCanvasExportHtml(title, worldElement, camera) {
  const world = worldElement.cloneNode(true);
  world.classList.remove("first-topic-enter", "is-focused");
  world.querySelectorAll("button, form, input, textarea").forEach((element) => element.remove());
  world.querySelectorAll("[data-camera-target]").forEach((element) => {
    element.removeAttribute("data-camera-target");
  });
  world.querySelectorAll(".generated-scene").forEach((scene) => {
    scene.classList.remove("is-paused");
    scene.classList.add("is-active");
  });
  const safeTitle = String(title || "Solo Learning")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const css = [...document.styleSheets].map((sheet) => {
    try {
      return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
    } catch {
      return "";
    }
  }).join("\n").replace(/@import[^;]+;\s*/g, "");
  const initialCamera = JSON.stringify(normalizeCamera(camera));

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} · Solo Learning</title>
  <style>
${css}
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body { background: var(--canvas); }
#export-viewport { position: fixed; inset: 0; overflow: hidden; touch-action: none; cursor: grab; }
#export-viewport.is-dragging { cursor: grabbing; }
#export-viewport .canvas-world { contain: layout style; }
#export-viewport .knowledge-board { content-visibility: visible; }
#export-viewport button, #export-viewport form { display: none !important; }
.export-title { position: fixed; z-index: 20; left: 18px; top: 18px; max-width: calc(100vw - 180px); padding: 9px 13px; overflow: hidden; border: 1px solid var(--line); background: rgba(255,253,251,.92); box-shadow: var(--shadow-soft); color: var(--ink); font-family: var(--font-display); font-size: 14px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; border-radius: var(--radius-sm); pointer-events: none; }
.export-controls { position: fixed; z-index: 20; right: 18px; bottom: 18px; display: flex; gap: 6px; padding: 5px; border: 1px solid var(--line); background: rgba(255,253,251,.92); box-shadow: var(--shadow-soft); border-radius: var(--radius-sm); }
.export-controls button { width: 34px; height: 34px; border: 0; background: transparent; color: var(--ink); cursor: pointer; font-size: 17px; border-radius: var(--radius-xs); }
.export-controls button:hover { background: var(--primary); }
  </style>
</head>
<body>
  <div class="export-title">${safeTitle}</div>
  <main id="export-viewport">${world.outerHTML}</main>
  <nav class="export-controls" aria-label="画布控制">
    <button type="button" data-action="out" title="缩小">−</button>
    <button type="button" data-action="reset" title="适应全部">⌂</button>
    <button type="button" data-action="in" title="放大">＋</button>
  </nav>
  <script>
    (() => {
      const viewport = document.getElementById("export-viewport");
      const world = viewport.querySelector(".canvas-world");
      let camera = ${initialCamera};
      let drag = null;
      const apply = () => {
        world.style.transform = "translate3d(" + camera.x + "px," + camera.y + "px,0) scale(" + camera.scale + ")";
      };
      const zoom = (factor, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) => {
        const next = Math.min(1.35, Math.max(.08, camera.scale * factor));
        const worldX = (x - camera.x) / camera.scale;
        const worldY = (y - camera.y) / camera.scale;
        camera = { x: x - worldX * next, y: y - worldY * next, scale: next };
        apply();
      };
      const fit = () => {
        const boards = [...world.querySelectorAll(".knowledge-board")];
        if (!boards.length) return;
        const left = Math.min(...boards.map((board) => parseFloat(board.style.left) || 0));
        const top = Math.min(...boards.map((board) => parseFloat(board.style.top) || 0));
        const right = Math.max(...boards.map((board) => (parseFloat(board.style.left) || 0) + (parseFloat(board.style.width) || 1270)));
        const bottom = Math.max(...boards.map((board) => (parseFloat(board.style.top) || 0) + (parseFloat(board.style.height) || 480)));
        const scale = Math.min(1, (viewport.clientWidth - 80) / (right - left), (viewport.clientHeight - 80) / (bottom - top));
        camera = { x: (viewport.clientWidth - (left + right) * scale) / 2, y: (viewport.clientHeight - (top + bottom) * scale) / 2, scale };
        apply();
      };
      viewport.addEventListener("wheel", (event) => {
        event.preventDefault();
        zoom(Math.exp(-Math.max(-160, Math.min(160, event.deltaY)) * .002), event.clientX, event.clientY);
      }, { passive: false });
      viewport.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y };
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add("is-dragging");
      });
      viewport.addEventListener("pointermove", (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        camera.x = drag.cameraX + event.clientX - drag.x;
        camera.y = drag.cameraY + event.clientY - drag.y;
        apply();
      });
      const stopDrag = () => { drag = null; viewport.classList.remove("is-dragging"); };
      viewport.addEventListener("pointerup", stopDrag);
      viewport.addEventListener("pointercancel", stopDrag);
      document.querySelector(".export-controls").addEventListener("click", (event) => {
        const action = event.target.dataset.action;
        if (action === "in") zoom(1.2);
        if (action === "out") zoom(1 / 1.2);
        if (action === "reset") fit();
      });
      apply();
    })();
  </script>
</body>
</html>`;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function summarizeLearningHistory(items) {
  const completed = items
    .filter((node) => Boolean(node.summary))
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-16);
  if (!completed.length) return "这是该画布的第一个问题，推荐问题应适合初学者继续下钻。";
  return completed.map((node, index) => (
    `${index + 1}. ${node.depth > 0 ? `第 ${node.depth + 1} 层追问` : "起始问题"}：${node.question || node.title}`
  )).join("\n");
}

function normalizeRecommendationKey(question) {
  return String(question || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function findRecommendationNode(items, sourceNodeId, question) {
  const recommendationKey = normalizeRecommendationKey(question);
  if (!sourceNodeId || !recommendationKey) return null;
  return items.find((item) => (
    (item.recommendationSourceId === sourceNodeId || item.parentId === sourceNodeId)
    && normalizeRecommendationKey(item.recommendationKey || item.question) === recommendationKey
  )) || null;
}

async function waitForLessonTask(taskId, payload = null, onProgress = null) {
  let response = payload
    ? await apiFetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, ...payload }),
      })
    : await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`);

  while (true) {
    const raw = await response.text();
    if (!raw) throw new Error("本地 API 未返回结果，请重启服务后重试");
    let task;
    try { task = JSON.parse(raw); } catch { throw new Error("本地 API 返回了不完整结果，请重启服务后重试"); }
    if (!response.ok) throw new Error(task.error || "无法恢复生成任务");
    onProgress?.(task);
    if (task.status === "completed") return task.result;
    if (task.status === "failed") throw new Error(task.error || "Agent 生成失败");
    await wait(500);
    response = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`);
  }
}

function getSvgBoardSize(sceneSvg) {
  if (typeof sceneSvg !== "string") {
    return { width: DEFAULT_BOARD_WIDTH, height: DEFAULT_BOARD_HEIGHT };
  }
  const root = sceneSvg.match(/<svg\b([^>]*)>/i)?.[1] || "";
  const viewBox = root.match(/\bviewBox\s*=\s*(["'])(.*?)\1/i)?.[2]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  let sourceWidth = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? Math.abs(viewBox[2]) : 0;
  let sourceHeight = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? Math.abs(viewBox[3]) : 0;
  if (!sourceWidth || !sourceHeight) {
    sourceWidth = Number(root.match(/\bwidth\s*=\s*(["'])([\d.]+)(?:px)?\1/i)?.[2]);
    sourceHeight = Number(root.match(/\bheight\s*=\s*(["'])([\d.]+)(?:px)?\1/i)?.[2]);
  }
  if (!sourceWidth || !sourceHeight) {
    return { width: DEFAULT_BOARD_WIDTH, height: DEFAULT_BOARD_HEIGHT };
  }
  const visualHeight = DEFAULT_BOARD_HEIGHT - 2;
  const visualWidth = visualHeight * (sourceWidth / sourceHeight);
  return {
    width: Math.round(ANSWER_COPY_WIDTH + visualWidth + 2),
    height: DEFAULT_BOARD_HEIGHT,
  };
}

function layoutNodes(items) {
  if (!items.length) return [];
  const childrenMap = new Map();
  const depthWidths = [];
  items.forEach((item) => {
    const key = item.parentId || "__root__";
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key).push(item);
    depthWidths[item.depth] = Math.max(depthWidths[item.depth] || 0, item.width || DEFAULT_BOARD_WIDTH);
  });
  childrenMap.forEach((list) => list.sort(compareNodeOrder));

  const xByDepth = [];
  let x = 520;
  depthWidths.forEach((width, depth) => {
    xByDepth[depth] = x;
    x += width + BOARD_GAP_X;
  });

  const subtreeHeights = new Map();
  const getSubtreeHeight = (node) => {
    if (subtreeHeights.has(node.id)) return subtreeHeights.get(node.id);
    const descendants = childrenMap.get(node.id) || [];
    const childrenHeight = descendants.reduce(
      (total, child, index) => total + getSubtreeHeight(child) + (index ? BOARD_GAP_Y : 0),
      0,
    );
    const height = Math.max(node.height || DEFAULT_BOARD_HEIGHT, childrenHeight);
    subtreeHeights.set(node.id, height);
    return height;
  };

  const positions = new Map();
  const placeNode = (node, top) => {
    const subtreeHeight = getSubtreeHeight(node);
    const nodeHeight = node.height || DEFAULT_BOARD_HEIGHT;
    positions.set(node.id, {
      x: xByDepth[node.depth] || 520,
      y: top + (subtreeHeight - nodeHeight) / 2,
    });
    const descendants = childrenMap.get(node.id) || [];
    const childrenHeight = descendants.reduce(
      (total, child, index) => total + getSubtreeHeight(child) + (index ? BOARD_GAP_Y : 0),
      0,
    );
    let childTop = top + Math.max(0, (subtreeHeight - childrenHeight) / 2);
    descendants.forEach((child) => {
      placeNode(child, childTop);
      childTop += getSubtreeHeight(child) + BOARD_GAP_Y;
    });
  };

  let rootTop = 460;
  (childrenMap.get("__root__") || []).forEach((rootNode) => {
    placeNode(rootNode, rootTop);
    rootTop += getSubtreeHeight(rootNode) + BOARD_GAP_Y * 1.5;
  });
  return items.map((item) => ({ ...item, ...positions.get(item.id) }));
}

function getNodeDescendantIds(items, nodeId) {
  const childrenMap = new Map();
  items.forEach((item) => {
    if (!item.parentId) return;
    if (!childrenMap.has(item.parentId)) childrenMap.set(item.parentId, []);
    childrenMap.get(item.parentId).push(item.id);
  });
  const descendants = new Set();
  const queue = [...(childrenMap.get(nodeId) || [])];
  while (queue.length) {
    const currentId = queue.shift();
    if (descendants.has(currentId)) continue;
    descendants.add(currentId);
    queue.push(...(childrenMap.get(currentId) || []));
  }
  return descendants;
}

function normalizeNodeHierarchy(items) {
  const nodeMap = new Map(items.map((item) => [item.id, item]));
  const parentById = new Map(items.map((item) => [
    item.id,
    item.parentId && item.parentId !== item.id && nodeMap.has(item.parentId)
      ? item.parentId
      : null,
  ]));
  const depthById = new Map();
  const getDepth = (nodeId, trail = new Set()) => {
    if (depthById.has(nodeId)) return depthById.get(nodeId);
    if (trail.has(nodeId)) {
      parentById.set(nodeId, null);
      depthById.set(nodeId, 0);
      return 0;
    }
    const parentId = parentById.get(nodeId);
    if (!parentId) {
      depthById.set(nodeId, 0);
      return 0;
    }
    const nextTrail = new Set(trail);
    nextTrail.add(nodeId);
    const depth = getDepth(parentId, nextTrail) + 1;
    depthById.set(nodeId, depth);
    return depth;
  };
  return items.map((item) => ({
    ...item,
    parentId: parentById.get(item.id),
    depth: getDepth(item.id),
  }));
}

function App({ initialStore, readOnly = false, shareId = "" }) {
  const initialWorkspace = initialStore.workspaces.find(
    (item) => item.id === initialStore.currentId,
  ) || initialStore.workspaces[0];
  const initialNodes = layoutNodes(initialWorkspace.nodes || []);
  const [workspaces, setWorkspaces] = useState(initialStore.workspaces);
  const workspacesRef = useRef(initialStore.workspaces);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace.id);
  const workspaceIdRef = useRef(initialWorkspace.id);
  const [nodes, setNodes] = useState(initialNodes);
  const nodesRef = useRef(initialNodes);
  const [activeId, setActiveId] = useState(initialNodes[0]?.id || null);
  const [query, setQuery] = useState("");
  const [homeMode, setHomeMode] = useState("question");
  const [documentText, setDocumentText] = useState("");
  const [documentName, setDocumentName] = useState("");
  const [documentImages, setDocumentImages] = useState([]);
  const [documentOutline, setDocumentOutline] = useState([]);
  const [documentDetail, setDocumentDetail] = useState("concise");
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentPlanning, setDocumentPlanning] = useState(false);
  const [visualConfig, setVisualConfig] = useState(() => normalizeVisualConfig(initialWorkspace.visualConfig));
  const [visualConfigOpen, setVisualConfigOpen] = useState(null);
  const [visualConfigApplying, setVisualConfigApplying] = useState(false);
  const [homeQuestions, setHomeQuestions] = useState(() => pickHomeQuestions());
  const [homeQuestionsChanging, setHomeQuestionsChanging] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(getStoredSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarLevel, setSidebarLevel] = useState("workspaces");
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState("");
  const [inspector, setInspector] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState("");
  const [selectionSource, setSelectionSource] = useState(null);
  const [selectionAnchor, setSelectionAnchor] = useState(null);
  const [selectionDragging, setSelectionDragging] = useState(false);
  const [followupNodeId, setFollowupNodeId] = useState(null);
  const [drillQuery, setDrillQuery] = useState("");
  const [regenerateTarget, setRegenerateTarget] = useState(null);
  const [regenerateFeedback, setRegenerateFeedback] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteNodeTarget, setDeleteNodeTarget] = useState(null);
  const [draggedNodeId, setDraggedNodeId] = useState(null);
  const [nodeDropTarget, setNodeDropTarget] = useState(null);
  const [firstTopicTransition, setFirstTopicTransition] = useState(null);
  const [createdNodeNotice, setCreatedNodeNotice] = useState(null);
  const [camera, setCamera] = useState(() => normalizeCamera(initialWorkspace.camera));
  const appShellRef = useRef(null);
  const sidebarResizeRef = useRef(null);
  const canvasRef = useRef(null);
  const worldRef = useRef(null);
  const homeQueryRef = useRef(null);
  const panRef = useRef(null);
  const suppressSceneClickUntilRef = useRef(0);
  const cameraRef = useRef(camera);
  const panFrameRef = useRef(null);
  const zoomFrameRef = useRef(null);
  const zoomCommitTimerRef = useRef(null);
  const zoomRestoreTimerRef = useRef(null);
  const pendingZoomCameraRef = useRef(null);
  const cameraAnimationRef = useRef(null);
  const cameraAnimationRestoreTimerRef = useRef(null);
  const shareRootFocusRef = useRef(false);
  const selectionDraggingRef = useRef(false);
  const selectionFrameRef = useRef(null);
  const firstTopicTimerRef = useRef(null);
  const createdNodeNoticeTimerRef = useRef(null);
  const homeQuestionSwapRef = useRef(null);
  const visualConfigRef = useRef(visualConfig);
  const recommendationLocksRef = useRef(new Set());
  const documentGenerationQueueRef = useRef({ active: 0, waiting: [] });
  const generationEstimateRef = useRef(initialStore.generationEstimateMs || 42_000);
  const storeSaveTimerRef = useRef(null);
  const pendingStoreRef = useRef(null);
  const storeSaveQueueRef = useRef(Promise.resolve());

  const acquireDocumentGenerationSlot = () => new Promise((resolveSlot) => {
    const queue = documentGenerationQueueRef.current;
    const start = () => {
      queue.active += 1;
      resolveSlot(() => {
        queue.active = Math.max(0, queue.active - 1);
        queue.waiting.shift()?.();
      });
    };
    if (queue.active < 2) start();
    else queue.waiting.push(start);
  });

  const startSidebarResize = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const resize = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
      width: sidebarWidth,
    };
    const handlePointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== resize.pointerId) return;
      const nextWidth = clampSidebarWidth(
        Math.round(resize.startWidth + moveEvent.clientX - resize.startX),
      );
      resize.width = nextWidth;
      appShellRef.current?.style.setProperty("--sidebar-width", `${nextWidth}px`);
    };
    const finishResize = (finishEvent) => {
      if (finishEvent.pointerId !== resize.pointerId) return;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      sidebarResizeRef.current = null;
      setSidebarWidth(resize.width);
      setSidebarResizing(false);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(resize.width));
      } catch {
        // The current width still applies when browser storage is unavailable.
      }
    };
    resize.cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
    sidebarResizeRef.current = resize;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    setSidebarResizing(true);
  };

  const resizeSidebarWithKeyboard = (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 24 : 12;
    const nextWidth = clampSidebarWidth(
      sidebarWidth + (event.key === "ArrowRight" ? step : -step),
    );
    setSidebarWidth(nextWidth);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
    } catch {
      // The current width still applies when browser storage is unavailable.
    }
  };

  const applyWorldTransform = (nextCamera) => {
    cameraRef.current = nextCamera;
    if (worldRef.current) {
      worldRef.current.style.transform = `translate3d(${nextCamera.x}px, ${nextCamera.y}px, 0) scale(${nextCamera.scale})`;
    }
  };

  const syncCanvasScenePlayback = (allowActiveScene) => {
    const activeScene = canvasRef.current?.querySelector(".generated-scene.is-active");
    if (activeScene) setSceneAnimationPlayback(activeScene, Boolean(allowActiveScene));
  };

  const setCanvasMotionState = (className, moving) => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.classList.contains(className) === moving) return;
    canvas.classList.toggle(className, moving);
    const cameraIsMoving = ["is-panning", "is-zooming", "is-camera-moving"]
      .some((motionClass) => canvas.classList.contains(motionClass));
    syncCanvasScenePlayback(!cameraIsMoving);
  };

  const commitCamera = (nextCamera) => {
    const normalized = normalizeCamera(nextCamera);
    applyWorldTransform(normalized);
    setCamera(normalized);
    const nextWorkspaces = workspacesRef.current.map((item) => item.id === workspaceIdRef.current ? {
      ...item,
      camera: normalized,
      updatedAt: new Date().toISOString(),
    } : item);
    workspacesRef.current = nextWorkspaces;
    saveWorkspaceStore(nextWorkspaces);
  };

  const finishZoomInteraction = (commit = true) => {
    if (zoomFrameRef.current) cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = null;
    if (zoomCommitTimerRef.current) clearTimeout(zoomCommitTimerRef.current);
    zoomCommitTimerRef.current = null;
    if (zoomRestoreTimerRef.current) clearTimeout(zoomRestoreTimerRef.current);
    zoomRestoreTimerRef.current = null;
    const pendingCamera = pendingZoomCameraRef.current;
    pendingZoomCameraRef.current = null;
    if (pendingCamera) {
      if (commit) commitCamera(pendingCamera);
      else applyWorldTransform(pendingCamera);
    }
    if (!commit) {
      setCanvasMotionState("is-zooming", false);
      return;
    }
    zoomRestoreTimerRef.current = setTimeout(() => {
      zoomRestoreTimerRef.current = null;
      setCanvasMotionState("is-zooming", false);
    }, 80);
  };

  const previewZoomCamera = (nextCamera) => {
    const normalized = normalizeCamera(nextCamera);
    pendingZoomCameraRef.current = normalized;
    cameraRef.current = normalized;
    if (zoomRestoreTimerRef.current) clearTimeout(zoomRestoreTimerRef.current);
    zoomRestoreTimerRef.current = null;
    setCanvasMotionState("is-zooming", true);
    if (!zoomFrameRef.current) {
      zoomFrameRef.current = requestAnimationFrame(() => {
        zoomFrameRef.current = null;
        if (pendingZoomCameraRef.current) {
          applyWorldTransform(pendingZoomCameraRef.current);
        }
      });
    }
    if (zoomCommitTimerRef.current) clearTimeout(zoomCommitTimerRef.current);
    zoomCommitTimerRef.current = setTimeout(() => finishZoomInteraction(true), 160);
  };

  const updateVisualConfig = (key, value) => {
    const nextConfig = normalizeVisualConfig({ ...visualConfigRef.current, [key]: value });
    visualConfigRef.current = nextConfig;
    setVisualConfig(nextConfig);
    const nextWorkspaces = workspacesRef.current.map((item) => item.id === workspaceIdRef.current ? {
      ...item,
      visualConfig: nextConfig,
      updatedAt: new Date().toISOString(),
    } : item);
    commitWorkspaces(nextWorkspaces);
  };

  const cancelCameraAnimation = ({ flushZoom = true } = {}) => {
    if (cameraAnimationRestoreTimerRef.current) {
      clearTimeout(cameraAnimationRestoreTimerRef.current);
      cameraAnimationRestoreTimerRef.current = null;
    }
    if (cameraAnimationRef.current) {
      cancelAnimationFrame(cameraAnimationRef.current);
      cameraAnimationRef.current = null;
    }
    worldRef.current?.querySelector('.knowledge-board[data-camera-target="true"]')
      ?.removeAttribute("data-camera-target");
    setCanvasMotionState("is-camera-moving", false);
    if (flushZoom) finishZoomInteraction(true);
  };

  const animateCamera = (nextCamera, duration = 400, targetNodeId = null) => {
    cancelCameraAnimation();
    const target = normalizeCamera(nextCamera);
    const start = { ...cameraRef.current };
    const cameraAlreadySettled = (
      Math.abs(target.x - start.x) < 0.5
      && Math.abs(target.y - start.y) < 0.5
      && Math.abs(target.scale - start.scale) < 0.001
    );
    if (cameraAlreadySettled) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || duration <= 0) {
      commitCamera(target);
      return;
    }
    worldRef.current?.querySelectorAll(".knowledge-board").forEach((board) => {
      if (board.dataset.nodeId === targetNodeId) board.dataset.cameraTarget = "true";
      else board.removeAttribute("data-camera-target");
    });
    setCanvasMotionState("is-camera-moving", true);
    const startedAt = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      applyWorldTransform({
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        scale: start.scale + (target.scale - start.scale) * eased,
      });
      if (progress < 1) {
        cameraAnimationRef.current = requestAnimationFrame(step);
        return;
      }
      cameraAnimationRef.current = null;
      commitCamera(target);
      cameraAnimationRestoreTimerRef.current = setTimeout(() => {
        cameraAnimationRestoreTimerRef.current = null;
        worldRef.current?.querySelector('.knowledge-board[data-camera-target="true"]')
          ?.removeAttribute("data-camera-target");
        setCanvasMotionState("is-camera-moving", false);
      }, 60);
    };
    cameraAnimationRef.current = requestAnimationFrame(step);
  };

  const children = (id) => sortNodeSiblings(nodes.filter((node) => node.parentId === id));
  const draggedNodeDescendants = draggedNodeId
    ? getNodeDescendantIds(nodes, draggedNodeId)
    : new Set();

  const flushWorkspaceStore = () => {
    if (!pendingStoreRef.current) return;
    const payload = pendingStoreRef.current;
    pendingStoreRef.current = null;
    storeSaveQueueRef.current = storeSaveQueueRef.current
      .catch(() => {})
      .then(() => saveStoreToServer(payload))
      .catch(() => setError("画布保存到服务端失败，请检查服务是否正常"));
  };

  const saveWorkspaceStore = (
    nextWorkspaces = workspacesRef.current,
    currentId = workspaceIdRef.current,
    immediate = false,
  ) => {
    if (readOnly) return;
    pendingStoreRef.current = {
      workspaces: nextWorkspaces,
      currentId,
      generationEstimateMs: generationEstimateRef.current,
    };
    if (storeSaveTimerRef.current) clearTimeout(storeSaveTimerRef.current);
    if (immediate) {
      storeSaveTimerRef.current = null;
      flushWorkspaceStore();
      return;
    }
    storeSaveTimerRef.current = setTimeout(() => {
      storeSaveTimerRef.current = null;
      flushWorkspaceStore();
    }, 180);
  };

  const commitWorkspaces = (nextWorkspaces, currentId = workspaceIdRef.current) => {
    workspacesRef.current = nextWorkspaces;
    setWorkspaces(nextWorkspaces);
    saveWorkspaceStore(nextWorkspaces, currentId);
  };

  const updateWorkspaceNodes = (targetWorkspaceId, updater) => {
    if (readOnly) return [];
    const target = workspacesRef.current.find((item) => item.id === targetWorkspaceId);
    if (!target) return [];
    const raw = typeof updater === "function" ? updater(target.nodes || []) : updater;
    const nextNodes = layoutNodes(raw);
    const nextWorkspaces = workspacesRef.current.map((item) => item.id === targetWorkspaceId ? {
      ...item,
      title: nextNodes.length
        ? nextNodes.find((node) => !node.loading)?.title || nextNodes[0]?.question || item.title
        : "新画布",
      nodes: nextNodes,
      updatedAt: new Date().toISOString(),
    } : item);
    commitWorkspaces(nextWorkspaces);
    if (workspaceIdRef.current === targetWorkspaceId) {
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
    }
    return nextNodes;
  };

  const preserveNodeScreenPosition = (targetWorkspaceId, nodeId, beforeNodes, afterNodes) => {
    if (!nodeId || targetWorkspaceId !== workspaceIdRef.current) return;
    const before = beforeNodes.find((item) => item.id === nodeId);
    const after = afterNodes.find((item) => item.id === nodeId);
    if (!before || !after || (before.x === after.x && before.y === after.y)) return;
    cancelCameraAnimation();
    const current = cameraRef.current;
    commitCamera({
      x: current.x + (before.x - after.x) * current.scale,
      y: current.y + (before.y - after.y) * current.scale,
      scale: current.scale,
    });
  };

  const completeTextTask = (targetWorkspaceId, nodeId, result) => {
    const targetWorkspace = workspacesRef.current.find((item) => item.id === targetWorkspaceId);
    const beforeNodes = targetWorkspace?.nodes || [];
    const pendingNode = beforeNodes.find((item) => item.id === nodeId);
    const viewportAnchorId = pendingNode?.preserveViewportAnchorId;
    const completedNodes = updateWorkspaceNodes(targetWorkspaceId, (current) => current.map((item) => {
      if (item.id !== nodeId) return item;
      return {
        ...item,
        kicker: result.kicker,
        title: result.title,
        summary: result.summary,
        facts: result.facts,
        children: result.children,
        id: item.id,
        question: item.question,
        parentId: item.parentId,
        depth: item.depth,
        createdAt: item.createdAt,
        palette: item.palette,
        textReady: true,
        textLoading: false,
        textFailed: false,
        textFailureMessage: "",
        textTaskId: null,
        textAgentStage: null,
        textAgentStageLabel: null,
        textAgentStageStartedAt: null,
        textAgentStageHistory: null,
        loading: Boolean(item.visualLoading),
        failed: false,
      };
    }));
    preserveNodeScreenPosition(targetWorkspaceId, viewportAnchorId, beforeNodes, completedNodes);
  };

  const completeVisualTask = (targetWorkspaceId, nodeId, result) => {
    const boardSize = getSvgBoardSize(result.visual?.sceneSvg);
    const targetWorkspace = workspacesRef.current.find((item) => item.id === targetWorkspaceId);
    const pendingNode = targetWorkspace?.nodes?.find((item) => item.id === nodeId);
    const sourceOutline = pendingNode?.sourceOutline?.length
      ? pendingNode.sourceOutline
      : parseDocumentOutline(pendingNode?.sourceContext);
    const outline = pendingNode?.documentRoot && !pendingNode.documentExpanded
      ? pendingNode.documentDetail === "detailed"
        ? compactDocumentOutline(sourceOutline, "detailed")
        : applyDocumentPlan(sourceOutline, pendingNode.sourcePlan?.length ? pendingNode.sourcePlan : result.outline)
      : [];
    const resolvedVisualConfig = normalizeVisualConfig(result.visualConfig);
    const completedNodes = updateWorkspaceNodes(targetWorkspaceId, (current) => current.map((item) => {
      if (item.id !== nodeId) return item;
      const documentResult = item.inputMode === "document" ? {
        kicker: result.kicker,
        title: item.sourceTitle || result.title,
        summary: result.summary,
        facts: result.facts,
        children: result.children,
        textReady: true,
        textLoading: false,
        textFailed: false,
      } : {};
      return {
        ...item,
        ...documentResult,
        width: boardSize.width,
        height: boardSize.height,
        visual: result.visual,
        resolvedVisualConfig,
        visualLoading: false,
        visualFailed: false,
        visualFailureMessage: "",
        visualTaskId: null,
        visualAgentStage: null,
        visualAgentStageLabel: null,
        visualAgentStageStartedAt: null,
        visualAgentStageHistory: null,
        loading: item.inputMode === "document" ? false : Boolean(item.textLoading),
        regenerating: false,
        failed: false,
        retryKind: null,
        preserveViewportAnchorId: null,
        documentExpanded: item.documentExpanded || outline.length > 0,
      };
    }));
    if (outline.length) {
      const rootNode = completedNodes.find((item) => item.id === nodeId);
      if (rootNode) void expandDocumentTree(targetWorkspaceId, rootNode, outline);
    }
  };

  const failTextTask = (targetWorkspaceId, nodeId, message) => {
    updateWorkspaceNodes(targetWorkspaceId, (current) => current.map((item) => item.id === nodeId ? {
      ...item,
      textLoading: false,
      textFailed: true,
      textFailureMessage: message || "文字答案生成失败，请重试",
      textTaskId: null,
      loading: Boolean(item.visualLoading),
      failed: !item.visual && !item.visualLoading,
    } : item));
  };

  const failVisualTask = (targetWorkspaceId, nodeId, message) => {
    updateWorkspaceNodes(targetWorkspaceId, (current) => current.map((item) => item.id === nodeId ? {
      ...item,
      visualLoading: false,
      visualFailed: true,
      visualFailureMessage: message || "图解生成失败，请重新生成",
      visualTaskId: null,
      loading: Boolean(item.textLoading),
      regenerating: false,
      failed: Boolean(item.textFailed && !item.summary),
      retryKind: "regenerate",
    } : item));
  };

  const syncTaskProgress = (targetWorkspaceId, nodeId, channel, task) => {
    const workspace = workspacesRef.current.find((item) => item.id === targetWorkspaceId);
    const node = workspace?.nodes?.find((item) => item.id === nodeId);
    const prefix = channel === "text" ? "textAgent" : "visualAgent";
    if (
      !node
      || (
        node[`${prefix}Stage`] === task.stage
        && node[`${prefix}StageStartedAt`] === task.stageStartedAt
      )
    ) return;
    updateWorkspaceNodes(targetWorkspaceId, (current) => current.map((item) => item.id === nodeId ? {
      ...item,
      [`${prefix}Stage`]: task.stage,
      [`${prefix}StageLabel`]: task.stageLabel,
      [`${prefix}StageStartedAt`]: task.stageStartedAt,
      [`${prefix}StageHistory`]: task.stageHistory,
    } : item));
  };

  useEffect(() => {
    if (readOnly) return undefined;
    const pendingTasks = workspacesRef.current.flatMap((workspace) => (
      (workspace.nodes || []).flatMap((node) => {
        const tasks = [];
        if (node.textTaskId && node.textLoading) {
          tasks.push({ workspaceId: workspace.id, node, channel: "text", taskId: node.textTaskId });
        }
        if (node.visualTaskId && (node.visualLoading || node.regenerating)) {
          tasks.push({ workspaceId: workspace.id, node, channel: "visual", taskId: node.visualTaskId });
        }
        if (node.taskId && (node.loading || node.regenerating)) {
          tasks.push({
            workspaceId: workspace.id,
            node,
            channel: node.answerMode === "quick" ? "text" : "visual",
            taskId: node.taskId,
          });
        }
        return tasks;
      })
    ));
    pendingTasks.forEach(async ({ workspaceId: targetWorkspaceId, node, channel, taskId }) => {
      setPendingCount((count) => count + 1);
      try {
        const result = await waitForLessonTask(
          taskId,
          null,
          (task) => syncTaskProgress(targetWorkspaceId, node.id, channel, task),
        );
        if (channel === "text") completeTextTask(targetWorkspaceId, node.id, result);
        else completeVisualTask(targetWorkspaceId, node.id, result);
      } catch (requestError) {
        if (channel === "text") {
          failTextTask(targetWorkspaceId, node.id, requestError.message || "无法恢复文字任务，请重试");
        } else {
          failVisualTask(targetWorkspaceId, node.id, requestError.message || "无法恢复图解任务，请重新生成");
        }
      } finally {
        setPendingCount((count) => Math.max(0, count - 1));
      }
    });
  }, [readOnly]);

  const persistWorkspace = (
    nextNodes = nodesRef.current,
    targetWorkspaceId = workspaceIdRef.current,
  ) => {
    const nextWorkspaces = workspacesRef.current.map((item) => item.id === targetWorkspaceId ? {
      ...item,
      title: nextNodes.find((node) => !node.loading)?.title || nextNodes[0]?.question || item.title,
      nodes: nextNodes,
      updatedAt: new Date().toISOString(),
    } : item);
    commitWorkspaces(nextWorkspaces);
  };

  useEffect(() => {
    if (!workspaceId) return;
    const targetWorkspaceId = workspaceId;
    const targetNodes = nodes;
    const timer = setTimeout(() => persistWorkspace(targetNodes, targetWorkspaceId), 250);
    return () => clearTimeout(timer);
  }, [nodes, workspaceId]);

  useEffect(() => {
    if (!activeId) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector(`.tree-row[data-node-id="${CSS.escape(activeId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeId, expanded]);

  useEffect(() => {
    if (nodes.length || firstTopicTransition) return undefined;
    const interval = setInterval(() => {
      setHomeQuestionsChanging(true);
      if (homeQuestionSwapRef.current) clearTimeout(homeQuestionSwapRef.current);
      homeQuestionSwapRef.current = setTimeout(() => {
        setHomeQuestions((current) => pickHomeQuestions(3, current));
        requestAnimationFrame(() => setHomeQuestionsChanging(false));
        homeQuestionSwapRef.current = null;
      }, 320);
    }, 8000);
    return () => {
      clearInterval(interval);
      if (homeQuestionSwapRef.current) clearTimeout(homeQuestionSwapRef.current);
      homeQuestionSwapRef.current = null;
      setHomeQuestionsChanging(false);
    };
  }, [workspaceId, nodes.length, firstTopicTransition]);

  const revealNodeInTree = (nodeId) => {
    const nodeMap = new Map(nodesRef.current.map((item) => [item.id, item]));
    const ancestors = [];
    let current = nodeMap.get(nodeId);
    while (current) {
      ancestors.push(current.id);
      current = current.parentId ? nodeMap.get(current.parentId) : null;
    }
    setActiveId(nodeId);
    setExpanded((currentExpanded) => new Set([...currentExpanded, ...ancestors]));
    setSidebarLevel("questions");
  };

  const createBlankWorkspace = () => {
    cancelCameraAnimation();
    if (firstTopicTimerRef.current) clearTimeout(firstTopicTimerRef.current);
    firstTopicTimerRef.current = null;
    setFirstTopicTransition(null);
    const savedWorkspaces = workspacesRef.current.map((item) => item.id === workspaceIdRef.current ? {
      ...item,
      title: nodesRef.current.find((node) => !node.loading)?.title || nodesRef.current[0]?.question || item.title,
      nodes: nodesRef.current,
      camera: normalizeCamera(cameraRef.current),
      updatedAt: new Date().toISOString(),
    } : item);
    const workspace = createWorkspace();
    const nextWorkspaces = [...savedWorkspaces, workspace];
    workspacesRef.current = nextWorkspaces;
    setWorkspaces(nextWorkspaces);
    workspaceIdRef.current = workspace.id;
    setWorkspaceId(workspace.id);
    setNodes([]);
    nodesRef.current = [];
    setActiveId(null);
    setExpanded(new Set());
    setInspector(null);
    setSelectedDetail("");
    setSelectionSource(null);
    setSelectionAnchor(null);
    setFollowupNodeId(null);
    setRegenerateTarget(null);
    setRegenerateFeedback("");
    setDeleteNodeTarget(null);
    setDraggedNodeId(null);
    setNodeDropTarget(null);
    setQuery("");
    const nextVisualConfig = normalizeVisualConfig(workspace.visualConfig);
    visualConfigRef.current = nextVisualConfig;
    setVisualConfig(nextVisualConfig);
    setVisualConfigOpen(null);
    setHomeQuestions(pickHomeQuestions());
    setHomeQuestionsChanging(false);
    setSidebarLevel("questions");
    const initialCamera = { ...DEFAULT_CAMERA };
    setCamera(initialCamera);
    applyWorldTransform(initialCamera);
    saveWorkspaceStore(nextWorkspaces, workspace.id);
  };

  const switchWorkspace = (nextId) => {
    if (nextId === workspaceIdRef.current) return;
    cancelCameraAnimation();
    if (firstTopicTimerRef.current) clearTimeout(firstTopicTimerRef.current);
    firstTopicTimerRef.current = null;
    setFirstTopicTransition(null);
    const savedWorkspaces = workspacesRef.current.map((item) => item.id === workspaceIdRef.current ? {
      ...item,
      title: nodesRef.current.find((node) => !node.loading)?.title || nodesRef.current[0]?.question || item.title,
      nodes: nodesRef.current,
      camera: normalizeCamera(cameraRef.current),
      updatedAt: new Date().toISOString(),
    } : item);
    const nextWorkspace = savedWorkspaces.find((item) => item.id === nextId);
    if (!nextWorkspace) return;
    const restoredNodes = layoutNodes(nextWorkspace.nodes || []);
    workspacesRef.current = savedWorkspaces;
    setWorkspaces(savedWorkspaces);
    workspaceIdRef.current = nextId;
    setWorkspaceId(nextId);
    setNodes(restoredNodes);
    nodesRef.current = restoredNodes;
    setActiveId(restoredNodes[0]?.id || null);
    setExpanded(new Set(restoredNodes.map((item) => item.id)));
    setInspector(null);
    setSelectedDetail("");
    setSelectionSource(null);
    setSelectionAnchor(null);
    setFollowupNodeId(null);
    setRegenerateTarget(null);
    setRegenerateFeedback("");
    setDeleteNodeTarget(null);
    setDraggedNodeId(null);
    setNodeDropTarget(null);
    setQuery("");
    const restoredVisualConfig = normalizeVisualConfig(nextWorkspace.visualConfig);
    visualConfigRef.current = restoredVisualConfig;
    setVisualConfig(restoredVisualConfig);
    setVisualConfigOpen(null);
    if (!restoredNodes.length) {
      setHomeQuestions(pickHomeQuestions());
      setHomeQuestionsChanging(false);
    }
    const restoredCamera = normalizeCamera(nextWorkspace.camera);
    setCamera(restoredCamera);
    applyWorldTransform(restoredCamera);
    saveWorkspaceStore(savedWorkspaces, nextId);
  };

  const openWorkspaceQuestions = (nextId) => {
    if (nextId !== workspaceIdRef.current) switchWorkspace(nextId);
    setSidebarLevel("questions");
  };

  const deleteWorkspace = (targetId) => {
    const target = workspacesRef.current.find((item) => item.id === targetId);
    if (!target) return;
    setDeleteTarget(null);
    if (targetId === workspaceIdRef.current) {
      cancelCameraAnimation();
      if (firstTopicTimerRef.current) clearTimeout(firstTopicTimerRef.current);
      firstTopicTimerRef.current = null;
      setFirstTopicTransition(null);
    }

    const syncedWorkspaces = workspacesRef.current.map((item) => item.id === workspaceIdRef.current ? {
      ...item,
      title: nodesRef.current.find((node) => !node.loading)?.title || nodesRef.current[0]?.question || item.title,
      nodes: nodesRef.current,
      camera: normalizeCamera(cameraRef.current),
      updatedAt: new Date().toISOString(),
    } : item);
    const targetIndex = syncedWorkspaces.findIndex((item) => item.id === targetId);
    let nextWorkspaces = syncedWorkspaces.filter((item) => item.id !== targetId);

    if (targetId !== workspaceIdRef.current) {
      commitWorkspaces(nextWorkspaces);
      return;
    }

    if (!nextWorkspaces.length) nextWorkspaces = [createWorkspace()];
    const nextWorkspace = nextWorkspaces[Math.min(targetIndex, nextWorkspaces.length - 1)];
    const restoredNodes = layoutNodes(nextWorkspace.nodes || []);
    workspacesRef.current = nextWorkspaces;
    setWorkspaces(nextWorkspaces);
    workspaceIdRef.current = nextWorkspace.id;
    setWorkspaceId(nextWorkspace.id);
    nodesRef.current = restoredNodes;
    setNodes(restoredNodes);
    setActiveId(restoredNodes[0]?.id || null);
    setExpanded(new Set(restoredNodes.map((item) => item.id)));
    setInspector(null);
    setSelectedDetail("");
    setSelectionSource(null);
    setSelectionAnchor(null);
    setFollowupNodeId(null);
    setRegenerateTarget(null);
    setRegenerateFeedback("");
    setQuery("");
    const restoredVisualConfig = normalizeVisualConfig(nextWorkspace.visualConfig);
    visualConfigRef.current = restoredVisualConfig;
    setVisualConfig(restoredVisualConfig);
    setVisualConfigOpen(null);
    const restoredCamera = normalizeCamera(nextWorkspace.camera);
    setCamera(restoredCamera);
    applyWorldTransform(restoredCamera);
    saveWorkspaceStore(nextWorkspaces, nextWorkspace.id);
  };

  const moveNode = (nodeId, nextParentId, position = "inside", referenceId = null) => {
    if (readOnly) return;
    const currentNodes = nodesRef.current;
    const node = currentNodes.find((item) => item.id === nodeId);
    if (!node || nodeId === nextParentId) return;
    const descendants = getNodeDescendantIds(currentNodes, nodeId);
    if (nextParentId && descendants.has(nextParentId)) return;
    const parent = nextParentId
      ? currentNodes.find((item) => item.id === nextParentId)
      : null;
    if (nextParentId && !parent) return;
    const targetParentId = nextParentId || null;
    const reorderedNodes = currentNodes.map((item) => item.id === nodeId ? {
      ...item,
      parentId: targetParentId,
      recommendationSourceId: targetParentId,
    } : item);
    const siblings = sortNodeSiblings(reorderedNodes.filter((item) => (
      item.id !== nodeId && (item.parentId || null) === targetParentId
    )));
    let insertIndex = siblings.length;
    if (position !== "inside" && referenceId) {
      const referenceIndex = siblings.findIndex((item) => item.id === referenceId);
      if (referenceIndex >= 0) insertIndex = referenceIndex + (position === "after" ? 1 : 0);
    }
    siblings.splice(insertIndex, 0, reorderedNodes.find((item) => item.id === nodeId));
    const siblingOrder = new Map(siblings.map((item, index) => [item.id, index]));
    const nextNodes = updateWorkspaceNodes(workspaceIdRef.current, normalizeNodeHierarchy(
      reorderedNodes.map((item) => siblingOrder.has(item.id) ? {
        ...item,
        siblingOrder: siblingOrder.get(item.id),
      } : item),
    ));
    setExpanded((current) => {
      const next = new Set(current);
      next.add(nodeId);
      if (targetParentId) next.add(targetParentId);
      return next;
    });
    preserveNodeScreenPosition(workspaceIdRef.current, activeId, currentNodes, nextNodes);
  };

  const deleteNode = (nodeId, mode) => {
    if (readOnly) return;
    const currentNodes = nodesRef.current;
    const target = currentNodes.find((item) => item.id === nodeId);
    if (!target) return;
    const descendants = getNodeDescendantIds(currentNodes, nodeId);
    const removedIds = mode === "branch"
      ? new Set([nodeId, ...descendants])
      : new Set([nodeId]);
    const nextNodes = normalizeNodeHierarchy(currentNodes
      .filter((item) => !removedIds.has(item.id))
      .map((item) => mode === "single" && item.parentId === nodeId ? {
        ...item,
        parentId: target.parentId || null,
        recommendationSourceId: target.parentId || null,
      } : item));
    updateWorkspaceNodes(workspaceIdRef.current, nextNodes);
    const nextActiveId = removedIds.has(activeId)
      ? target.parentId && !removedIds.has(target.parentId)
        ? target.parentId
        : nextNodes[0]?.id || null
      : activeId;
    setActiveId(nextActiveId);
    if (removedIds.has(inspector?.nodeId)) setInspector(null);
    if (removedIds.has(selectionSource?.nodeId)) {
      window.getSelection()?.removeAllRanges();
      setSelectedDetail("");
      setSelectionSource(null);
      setSelectionAnchor(null);
    }
    if (removedIds.has(followupNodeId)) {
      setFollowupNodeId(null);
      setDrillQuery("");
    }
    if (removedIds.has(regenerateTarget)) {
      setRegenerateTarget(null);
      setRegenerateFeedback("");
    }
    if (removedIds.has(createdNodeNotice?.nodeId)) setCreatedNodeNotice(null);
    setExpanded((current) => new Set([...current].filter((id) => !removedIds.has(id))));
    setDeleteNodeTarget(null);
    setDraggedNodeId(null);
    setNodeDropTarget(null);
  };

  const exportCurrentWorkspace = async () => {
    if (!activeWorkspace || !nodes.length || !worldRef.current) return;
    if (inspector) {
      setInspector(null);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    const html = createCanvasExportHtml(
      activeWorkspace.title,
      worldRef.current,
      cameraRef.current,
    );
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${String(activeWorkspace.title || "solo-learning").replace(/[\\/:*?"<>|]/g, "-")}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  useEffect(() => {
    if (!deleteTarget && !deleteNodeTarget) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      setDeleteTarget(null);
      setDeleteNodeTarget(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [deleteTarget, deleteNodeTarget]);

  const createTopic = async (question, parent = null, elementLabel = "", options = {}) => {
    const clean = question.trim();
    if (!clean) return;
    const originWorkspaceId = options.workspaceId || workspaceIdRef.current;
    const recommendationSourceId = options.recommendationSourceId || null;
    const recommendationKey = recommendationSourceId
      ? normalizeRecommendationKey(options.recommendationKey || clean)
      : null;
    const recommendationLockKey = recommendationSourceId && recommendationKey
      ? `${originWorkspaceId}:${recommendationSourceId}:${recommendationKey}`
      : null;
    if (recommendationLockKey) {
      const workspaceNodes = workspacesRef.current.find((item) => item.id === originWorkspaceId)?.nodes || [];
      const existing = findRecommendationNode(workspaceNodes, recommendationSourceId, recommendationKey);
      if (existing || recommendationLocksRef.current.has(recommendationLockKey)) return existing;
      recommendationLocksRef.current.add(recommendationLockKey);
    }
    const depth = parent ? parent.depth + 1 : 0;
    const currentNodes = workspacesRef.current.find((item) => item.id === originWorkspaceId)?.nodes || [];
    const taskVisualConfig = normalizeVisualConfig(options.visualConfig || parent?.resolvedVisualConfig || visualConfigRef.current);
    const isFirstQuestion = !parent && currentNodes.length === 0;
    if (isFirstQuestion) {
      if (firstTopicTimerRef.current) clearTimeout(firstTopicTimerRef.current);
      setFirstTopicTransition({ workspaceId: originWorkspaceId, question: clean });
      firstTopicTimerRef.current = setTimeout(() => {
        setFirstTopicTransition((current) => current?.workspaceId === originWorkspaceId ? null : current);
        firstTopicTimerRef.current = null;
      }, 1150);
    }
    const placeholderId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const textTaskId = `answer-${placeholderId}`;
    const visualTaskId = `visual-${placeholderId}`;
    const isDocumentTask = options.inputMode === "document";
    const sharedPayload = {
      question: clean,
      learningHistory: summarizeLearningHistory(currentNodes),
      inputMode: options.inputMode || "question",
      documentRoot: options.documentRoot ?? (options.inputMode === "document" && !parent),
      images: options.images || [],
      context: options.context || (parent
        ? `父主题名称：${parent.title}${elementLabel ? `；被点击对象：${elementLabel}` : ""}。仅用于消歧，不要复述或沿用父主题内容。`
        : ""),
    };
    const placeholder = {
      id: placeholderId,
      question: clean,
      title: clean,
      summary: "",
      parentId: parent?.id || null,
      depth,
      createdAt: new Date(),
      palette: palettes[depth % palettes.length],
      x: 520,
      y: 460,
      width: DEFAULT_BOARD_WIDTH,
      height: DEFAULT_BOARD_HEIGHT,
      answerMode: "container",
      loading: true,
      loadingStartedAt: Date.now(),
      estimatedMs: generationEstimateRef.current,
      textReady: false,
      textLoading: !isDocumentTask,
      textFailed: false,
      textTaskId: isDocumentTask ? null : textTaskId,
      textAgentStage: isDocumentTask ? null : "queued",
      textAgentStageLabel: isDocumentTask ? null : "正在准备文字答案",
      textAgentStageStartedAt: isDocumentTask ? null : Date.now(),
      visualLoading: true,
      visualFailed: false,
      visualTaskId,
      visualAgentStage: "queued",
      visualAgentStageLabel: "正在准备图解",
      visualAgentStageStartedAt: Date.now(),
      preserveViewportAnchorId: parent && options.preserveViewport !== false ? parent.id : null,
      recommendationSourceId,
      recommendationKey,
      siblingOrder: Number.isFinite(options.siblingOrder) ? options.siblingOrder : undefined,
      inputMode: options.inputMode || "question",
      documentRoot: options.documentRoot ?? (options.inputMode === "document" && !parent),
      documentExpanded: false,
      sourceDocumentNodeId: options.inputMode === "document" ? options.sourceDocumentNodeId || placeholderId : null,
      sourceFocus: options.inputMode === "document" ? options.sourceFocus || "" : "",
      sourceSection: options.inputMode === "document" ? options.sourceSection || "" : "",
      sourceTitle: options.inputMode === "document" ? options.sourceTitle || "" : "",
      sourceImageNames: options.inputMode === "document" ? options.sourceImageNames || [] : [],
      sourceOutline: options.inputMode === "document" && !options.sourceDocumentNodeId ? options.sourceOutline || [] : [],
      sourcePlan: options.inputMode === "document" && !options.sourceDocumentNodeId ? options.sourcePlan || [] : [],
      documentDetail: options.inputMode === "document" ? options.documentDetail || "concise" : "",
      sourceContext: options.inputMode === "document" && !options.sourceDocumentNodeId ? options.context : "",
      sourceImages: options.inputMode === "document" && !options.sourceDocumentNodeId
        ? options.imageEntries || options.images
        : [],
    };
    setError("");
    const withPlaceholder = updateWorkspaceNodes(originWorkspaceId, [...currentNodes, placeholder]);
    preserveNodeScreenPosition(
      originWorkspaceId,
      placeholder.preserveViewportAnchorId,
      currentNodes,
      withPlaceholder,
    );
    if (isFirstQuestion && originWorkspaceId === workspaceIdRef.current) {
      requestAnimationFrame(() => focusNode(placeholderId, 1));
    } else {
      revealNodeInTree(placeholderId);
      if (originWorkspaceId === workspaceIdRef.current) {
        if (createdNodeNoticeTimerRef.current) clearTimeout(createdNodeNoticeTimerRef.current);
        setCreatedNodeNotice({
          nodeId: placeholderId,
          question: clean,
          anchor: options.noticeAnchor || null,
        });
        createdNodeNoticeTimerRef.current = setTimeout(() => {
          setCreatedNodeNotice((current) => current?.nodeId === placeholderId ? null : current);
          createdNodeNoticeTimerRef.current = null;
        }, 6500);
      }
    }
    setQuery("");
    setSidebarOpen(false);
    setPendingCount((count) => count + (isDocumentTask ? 1 : 2));
    const releaseDocumentSlot = isDocumentTask
      ? await acquireDocumentGenerationSlot()
      : () => {};
    const queuedNodeExists = workspacesRef.current
      .find((item) => item.id === originWorkspaceId)?.nodes
      ?.some((item) => item.id === placeholderId);
    if (!queuedNodeExists) {
      releaseDocumentSlot();
      setPendingCount((count) => Math.max(0, count - (isDocumentTask ? 1 : 2)));
      if (recommendationLockKey) recommendationLocksRef.current.delete(recommendationLockKey);
      return null;
    }
    const textPromise = isDocumentTask
      ? Promise.resolve()
      : waitForLessonTask(textTaskId, {
          ...sharedPayload,
          answerMode: "quick",
        }, (task) => syncTaskProgress(originWorkspaceId, placeholderId, "text", task))
          .then((result) => completeTextTask(originWorkspaceId, placeholderId, result))
          .catch((requestError) => {
            failTextTask(originWorkspaceId, placeholderId, requestError.message || "文字答案生成失败，请重试");
          })
          .finally(() => setPendingCount((count) => Math.max(0, count - 1)));

    const visualStartedAt = performance.now();
    const visualPromise = waitForLessonTask(visualTaskId, {
      ...sharedPayload,
      answerMode: "visual",
      visualConfig: serializeVisualConfig(taskVisualConfig),
    }, (task) => syncTaskProgress(originWorkspaceId, placeholderId, "visual", task))
      .then((result) => {
        const actualMs = performance.now() - visualStartedAt;
        const nextEstimate = Math.round(generationEstimateRef.current * 0.35 + actualMs * 0.65);
        generationEstimateRef.current = Math.min(300_000, Math.max(12_000, nextEstimate));
        saveWorkspaceStore();
        completeVisualTask(originWorkspaceId, placeholderId, result);
      })
      .catch((requestError) => {
        failVisualTask(originWorkspaceId, placeholderId, requestError.message || "图解生成失败，请重新生成");
      })
      .finally(() => setPendingCount((count) => Math.max(0, count - 1)));

    try {
      await Promise.allSettled([textPromise, visualPromise]);
    } finally {
      releaseDocumentSlot();
      if (recommendationLockKey) recommendationLocksRef.current.delete(recommendationLockKey);
    }
    return workspacesRef.current.find((item) => item.id === originWorkspaceId)?.nodes?.find((item) => item.id === placeholderId) || placeholder;
  };

  const expandDocumentTree = async (targetWorkspaceId, rootNode, outline) => {
    const created = new Map();
    outline.forEach((item, index) => {
      const parent = item.parent < 0 ? rootNode : created.get(item.parent) || rootNode;
      const images = selectDocumentImageData(rootNode.sourceImages, item.imageNames || []);
      void createTopic(`梳理：${item.title}`, parent, "", {
        workspaceId: targetWorkspaceId,
        inputMode: "document",
        documentRoot: false,
        sourceDocumentNodeId: rootNode.id,
        sourceFocus: item.scope,
        sourceSection: item.content,
        sourceTitle: item.sourceTitle || item.title,
        sourceImageNames: item.imageNames || [],
        context: `【原文章节】${item.title}\n保持原章节标题、顺序和层级。只梳理以下原文，不要扩展到其他章节。\n\n${item.content || item.scope}`,
        images,
        visualConfig: rootNode.resolvedVisualConfig || workspacesRef.current.find((workspace) => workspace.id === targetWorkspaceId)?.visualConfig,
        preserveViewport: false,
        recommendationSourceId: parent.id,
        recommendationKey: item.title,
        siblingOrder: index,
      });
      const child = findRecommendationNode(
        workspacesRef.current.find((workspace) => workspace.id === targetWorkspaceId)?.nodes || [],
        parent.id,
        item.title,
      );
      if (child) created.set(index, child);
    });
  };

  const regenerateNode = async (node, feedback, options = {}) => {
    const cleanFeedback = feedback.trim()
      || "请保留核心知识结论，重新设计一版结构更清晰、视觉表达更直观且动画更自然的完整 SVG 图解。";
    const originWorkspaceId = options.workspaceId || workspaceIdRef.current;
    const workspace = workspacesRef.current.find((item) => item.id === originWorkspaceId);
    const workspaceNodes = workspace?.nodes || [];
    const liveNode = workspaceNodes.find((item) => item.id === node?.id) || node;
    if (!liveNode || liveNode.visualLoading || liveNode.regenerating) return;
    const parent = workspaceNodes.find((item) => item.id === liveNode.parentId);
    const sourceNode = workspaceNodes.find((item) => item.id === liveNode.sourceDocumentNodeId) || liveNode;
    const sourceContext = sourceNode === liveNode
      ? sourceNode.sourceContext || ""
      : `【原文章节】${liveNode.sourceTitle || liveNode.question}\n只梳理这个范围，不要重新概括整份资料。\n\n${liveNode.sourceSection || liveNode.sourceFocus || ""}`;
    const sourceImages = selectDocumentImageData(sourceNode.sourceImages, sourceNode === liveNode ? undefined : liveNode.sourceImageNames);
    const documentRoot = liveNode.inputMode === "document" && !liveNode.parentId;
    const documentExpanded = documentRoot && workspaceNodes.some((item) => item.parentId === liveNode.id);
    const visualTaskId = `visual-${liveNode.id}-${Date.now()}`;
    const taskVisualConfig = normalizeVisualConfig(
      options.visualConfig || sourceNode?.resolvedVisualConfig || workspace?.visualConfig || visualConfigRef.current,
    );
    setRegenerateTarget(null);
    setRegenerateFeedback("");
    setPendingCount((count) => count + 1);
    setError("");
    updateWorkspaceNodes(originWorkspaceId, (current) => current.map((item) => item.id === liveNode.id ? {
      ...item,
      regenerating: true,
      failed: false,
      visualFailed: false,
      visualFailureMessage: "",
      visualLoading: true,
      loadingStartedAt: Date.now(),
      estimatedMs: generationEstimateRef.current,
      visualTaskId,
      visualAgentStage: "queued",
      visualAgentStageLabel: "正在重新生成图解",
      visualAgentStageStartedAt: Date.now(),
      documentRoot,
      documentExpanded,
    } : item));
    try {
      const requestStartedAt = performance.now();
      const result = await waitForLessonTask(visualTaskId, {
          question: liveNode.question,
          answerMode: "visual",
          inputMode: liveNode.inputMode || "question",
          documentRoot,
          images: sourceImages,
          learningHistory: summarizeLearningHistory(workspaceNodes.filter((item) => item.id !== liveNode.id)),
          visualConfig: serializeVisualConfig(taskVisualConfig),
          context: sourceContext || (parent
            ? `父主题名称：${parent.title}。仅用于消歧，不要复述或沿用父主题内容。`
            : ""),
          revision: cleanFeedback,
          existingLesson: {
            title: liveNode.title,
            summary: liveNode.summary,
            visual: liveNode.visual,
          },
      }, (task) => syncTaskProgress(originWorkspaceId, liveNode.id, "visual", task));
      const actualMs = performance.now() - requestStartedAt;
      const nextEstimate = Math.round(generationEstimateRef.current * 0.35 + actualMs * 0.65);
      generationEstimateRef.current = Math.min(300_000, Math.max(12_000, nextEstimate));
      saveWorkspaceStore();
      completeVisualTask(originWorkspaceId, liveNode.id, result);
    } catch (requestError) {
      failVisualTask(originWorkspaceId, liveNode.id, requestError.message || "重新生成失败，请稍后重试");
    } finally {
      setPendingCount((count) => Math.max(0, count - 1));
    }
  };

  const retryTextNode = async (node) => {
    const originWorkspaceId = workspaceIdRef.current;
    const workspace = workspacesRef.current.find((item) => item.id === originWorkspaceId);
    const workspaceNodes = workspace?.nodes || [];
    const liveNode = workspaceNodes.find((item) => item.id === node?.id);
    if (!liveNode || liveNode.textLoading) return;
    const parent = workspaceNodes.find((item) => item.id === liveNode.parentId);
    const sourceNode = workspaceNodes.find((item) => item.id === liveNode.sourceDocumentNodeId) || liveNode;
    const sourceContext = sourceNode === liveNode
      ? sourceNode.sourceContext || ""
      : `【原文章节】${liveNode.sourceTitle || liveNode.question}\n只梳理这个范围，不要重新概括整份资料。\n\n${liveNode.sourceSection || liveNode.sourceFocus || ""}`;
    const sourceImages = selectDocumentImageData(sourceNode.sourceImages, sourceNode === liveNode ? undefined : liveNode.sourceImageNames);
    const textTaskId = `answer-${liveNode.id}-${Date.now()}`;
    setPendingCount((count) => count + 1);
    updateWorkspaceNodes(originWorkspaceId, (current) => current.map((item) => item.id === liveNode.id ? {
      ...item,
      textLoading: true,
      textFailed: false,
      textFailureMessage: "",
      textTaskId,
      textAgentStage: "queued",
      textAgentStageLabel: "正在重新组织文字答案",
      textAgentStageStartedAt: Date.now(),
    } : item));
    try {
      const result = await waitForLessonTask(textTaskId, {
        question: liveNode.question,
        answerMode: "quick",
        inputMode: liveNode.inputMode || "question",
        images: sourceImages,
        learningHistory: summarizeLearningHistory(workspaceNodes.filter((item) => item.id !== liveNode.id)),
        context: sourceContext || (parent ? `父主题名称：${parent.title}。仅用于消歧。` : ""),
      }, (task) => syncTaskProgress(originWorkspaceId, liveNode.id, "text", task));
      completeTextTask(originWorkspaceId, liveNode.id, result);
    } catch (requestError) {
      failTextTask(originWorkspaceId, liveNode.id, requestError.message || "文字答案生成失败，请重试");
    } finally {
      setPendingCount((count) => Math.max(0, count - 1));
    }
  };

  const applyVisualConfigToAll = async () => {
    if (visualConfigApplying) return;
    const targetWorkspaceId = workspaceIdRef.current;
    const targetWorkspace = workspacesRef.current.find((item) => item.id === targetWorkspaceId);
    const targetNodes = (targetWorkspace?.nodes || []).filter((node) => (
      !node.visualLoading && !node.regenerating
    ));
    if (!targetNodes.length) {
      setVisualConfigOpen(null);
      return;
    }
    const targetConfig = normalizeVisualConfig(visualConfigRef.current);
    let cursor = 0;
    setVisualConfigApplying(true);
    setVisualConfigOpen(null);
    const workers = Array.from({ length: Math.min(2, targetNodes.length) }, async () => {
      while (cursor < targetNodes.length) {
        const node = targetNodes[cursor];
        cursor += 1;
        await regenerateNode(
          node,
          "请保持知识结论不变，按照当前画布统一视觉配置重新设计这张完整 SVG 图解。",
          { workspaceId: targetWorkspaceId, visualConfig: targetConfig },
        );
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      setVisualConfigApplying(false);
    }
  };

  const focusNode = (nodeId, scale = camera.scale) => {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    const viewport = canvasRef.current;
    if (!node || !viewport) return;
    const boardWidth = node.width || DEFAULT_BOARD_WIDTH;
    const boardHeight = node.height || DEFAULT_BOARD_HEIGHT;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    const contentTop = 64;
    const contentBottom = viewport.clientHeight - 24;
    const availableHeight = Math.max(120, contentBottom - contentTop);
    const fitScale = Math.min(
      (viewport.clientWidth - 72) / boardWidth,
      availableHeight / boardHeight,
    );
    const nextScale = Math.min(1, Math.max(0.08, Math.min(scale, fitScale)));
    revealNodeInTree(nodeId);
    animateCamera({
      x: viewport.clientWidth / 2 - (node.x + boardWidth / 2) * nextScale,
      y: contentTop + availableHeight / 2 - (node.y + boardHeight / 2) * nextScale,
      scale: nextScale,
    }, 520, nodeId);
  };

  useEffect(() => {
    const navigateCards = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']"))
      ) return;
      const currentNodes = getNodesInTreeOrder(nodesRef.current);
      if (!currentNodes.length) return;
      const currentIndex = currentNodes.findIndex((node) => node.id === activeId);
      const nextIndex = event.key === "ArrowRight"
        ? Math.min(currentNodes.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex < 0 ? 0 : currentIndex - 1);
      if (nextIndex === currentIndex) return;
      event.preventDefault();
      setInspector(null);
      focusNode(currentNodes[nextIndex].id, 1);
    };
    window.addEventListener("keydown", navigateCards);
    return () => window.removeEventListener("keydown", navigateCards);
  }, [activeId, nodes]);

  const getNodeVisibleRatio = (nodeId) => {
    const viewportRect = canvasRef.current?.getBoundingClientRect();
    const nodeElement = worldRef.current?.querySelector(
      `.knowledge-board[data-node-id="${CSS.escape(nodeId)}"]`,
    );
    if (!viewportRect || !nodeElement) return 0;
    const nodeRect = nodeElement.getBoundingClientRect();
    const visibleWidth = Math.max(
      0,
      Math.min(nodeRect.right, viewportRect.right) - Math.max(nodeRect.left, viewportRect.left),
    );
    const visibleHeight = Math.max(
      0,
      Math.min(nodeRect.bottom, viewportRect.bottom) - Math.max(nodeRect.top, viewportRect.top),
    );
    const nodeArea = Math.max(1, nodeRect.width * nodeRect.height);
    return (visibleWidth * visibleHeight) / nodeArea;
  };

  const focusLinkEndpoint = (leftNode, rightNode) => {
    const leftRatio = getNodeVisibleRatio(leftNode.id);
    const rightRatio = getNodeVisibleRatio(rightNode.id);
    const target = Math.abs(leftRatio - rightRatio) < 0.001
      ? (leftNode.x > rightNode.x ? leftNode : rightNode)
      : (leftRatio < rightRatio ? leftNode : rightNode);
    focusNode(target.id, 1);
  };

  useEffect(() => {
    if (!readOnly || !shareId || shareRootFocusRef.current || !nodes.length) return undefined;
    const rootNode = sortNodeSiblings(nodesRef.current.filter((node) => !node.parentId))[0]
      || nodesRef.current[0];
    if (!rootNode) return undefined;
    shareRootFocusRef.current = true;
    let focusFrame = null;
    const layoutFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => focusNode(rootNode.id, 1));
    });
    return () => {
      cancelAnimationFrame(layoutFrame);
      if (focusFrame) cancelAnimationFrame(focusFrame);
    };
  }, [readOnly, shareId, nodes.length]);

  const getNoticeAnchor = (event) => {
    const viewport = canvasRef.current;
    if (!viewport) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const submitter = event?.nativeEvent?.submitter;
    const target = submitter instanceof Element ? submitter : event?.currentTarget;
    const targetRect = target instanceof Element ? target.getBoundingClientRect() : null;
    const clientX = Number.isFinite(event?.clientX) && event.clientX > 0
      ? event.clientX
      : targetRect
        ? targetRect.left + targetRect.width / 2
        : viewportRect.left + viewportRect.width / 2;
    const clientY = Number.isFinite(event?.clientY) && event.clientY > 0
      ? event.clientY
      : targetRect
        ? targetRect.top + targetRect.height / 2
        : viewportRect.top + viewportRect.height / 2;
    const pointX = clientX - viewportRect.left;
    const pointY = clientY - viewportRect.top;
    const noticeWidth = 86;
    const noticeHeight = 34;
    const left = pointX + noticeWidth + 24 <= viewportRect.width
      ? pointX + 12
      : pointX - noticeWidth - 12;
    const top = pointY - noticeHeight - 12 >= 12
      ? pointY - noticeHeight - 12
      : pointY + 12;
    return {
      left: Math.min(Math.max(12, viewportRect.width - noticeWidth - 12), Math.max(12, left)),
      top: Math.min(Math.max(12, viewportRect.height - noticeHeight - 12), Math.max(12, top)),
    };
  };

  const openInspector = (node, selection) => {
    revealNodeInTree(node.id);
    setInspector({
      nodeId: node.id,
      ...selection,
      detail: normalizeInspectorDetail(selection.detail),
      questions: normalizeQuestionsForInspector(
        selection.questions || node.children || []
      ).slice(0, 3),
    });
    setSelectedDetail("");
    setSelectionSource(null);
    setSelectionAnchor(null);
    setFollowupNodeId(null);
    setDrillQuery("");
    focusNode(node.id, 1);
  };

  const openNodeFromTree = (nodeId) => {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) return;
    focusNode(node.id, 1);
    setSidebarOpen(false);
  };

  const captureInspectorSelection = () => {
    if (panRef.current) return;
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
    const anchorNode = selection?.anchorNode;
    const anchor = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const selectionArea = anchor?.closest(".selectable-answer");
    if (!text || selection?.isCollapsed || !selectionArea || !range) {
      setSelectedDetail("");
      setSelectionSource(null);
      setSelectionAnchor(null);
      return;
    }
    const rect = range?.getBoundingClientRect();
    setSelectedDetail(text.slice(0, 500));
    setSelectionSource({
      nodeId: selectionArea.dataset.nodeId,
      label: selectionArea.dataset.selectionLabel || "",
    });
    if (rect?.width || rect?.height) {
      setSelectionAnchor({
        x: Math.min(window.innerWidth - 96, Math.max(8, rect.right + 8)),
        y: Math.min(window.innerHeight - 18, Math.max(18, rect.top + rect.height / 2)),
      });
    }
  };

  useEffect(() => {
    const scheduleSelectionCapture = () => {
      if (selectionDraggingRef.current || panRef.current) return;
      if (selectionFrameRef.current) cancelAnimationFrame(selectionFrameRef.current);
      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = requestAnimationFrame(() => {
          selectionFrameRef.current = null;
          captureInspectorSelection();
        });
      });
    };
    const finishSelection = () => {
      if (!selectionDraggingRef.current) return;
      selectionDraggingRef.current = false;
      setSelectionDragging(false);
      scheduleSelectionCapture();
    };
    const cancelSelection = () => {
      selectionDraggingRef.current = false;
      setSelectionDragging(false);
      setSelectedDetail("");
      setSelectionSource(null);
      setSelectionAnchor(null);
    };
    const handleSelection = () => scheduleSelectionCapture();
    document.addEventListener("selectionchange", handleSelection);
    document.addEventListener("pointerup", finishSelection);
    document.addEventListener("pointercancel", cancelSelection);
    return () => {
      document.removeEventListener("selectionchange", handleSelection);
      document.removeEventListener("pointerup", finishSelection);
      document.removeEventListener("pointercancel", cancelSelection);
      if (selectionFrameRef.current) cancelAnimationFrame(selectionFrameRef.current);
      selectionFrameRef.current = null;
    };
  }, []);

  const askAboutSelection = (event) => {
    const parent = nodesRef.current.find((item) => item.id === selectionSource?.nodeId);
    const liveSelection = window.getSelection()?.toString().replace(/\s+/g, " ").trim() || "";
    const selectedText = (liveSelection || selectedDetail).slice(0, 500);
    if (!parent || !selectedText) return;
    const question = `请详细解释这段内容：“${selectedText}”`;
    createTopic(question, parent, selectionSource?.label || parent.title, {
      noticeAnchor: getNoticeAnchor(event),
    });
    window.getSelection()?.removeAllRanges();
    setInspector(null);
    setSelectedDetail("");
    setSelectionSource(null);
    setSelectionAnchor(null);
    setFollowupNodeId(null);
  };

  const findRecommendedTask = (sourceNodeId, question) => {
    return findRecommendationNode(nodesRef.current, sourceNodeId, question);
  };

  const askRecommendedQuestion = (question, event) => {
    const parent = nodesRef.current.find((item) => item.id === inspector?.nodeId);
    const recommendationKey = normalizeRecommendationKey(question);
    if (!parent || !recommendationKey) return;
    const existing = findRecommendedTask(parent.id, question);
    if (existing) {
      if (existing.summary) {
        openNodeFromTree(existing.id);
      } else {
        revealNodeInTree(existing.id);
      }
      return;
    }
    createTopic(question, parent, inspector.label, {
      preserveViewport: true,
      recommendationSourceId: parent.id,
      recommendationKey,
      noticeAnchor: getNoticeAnchor(event),
    });
    setSelectedDetail("");
    setSelectionSource(null);
    setSelectionAnchor(null);
    setDrillQuery("");
  };

  useEffect(() => () => {
    if (firstTopicTimerRef.current) clearTimeout(firstTopicTimerRef.current);
    if (createdNodeNoticeTimerRef.current) clearTimeout(createdNodeNoticeTimerRef.current);
    sidebarResizeRef.current?.cleanup?.();
    finishZoomInteraction(false);
    if (storeSaveTimerRef.current) clearTimeout(storeSaveTimerRef.current);
    flushWorkspaceStore();
    cancelCameraAnimation({ flushZoom: false });
  }, []);

  const isFirstTopicTransition = firstTopicTransition?.workspaceId === workspaceId;
  const activeWorkspace = workspaces.find((item) => item.id === workspaceId);
  const orderedWorkspaces = sortByCreatedAtDesc(workspaces);
  const activeTreePath = (() => {
    const path = new Set();
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    let current = nodeMap.get(activeId);
    while (current) {
      path.add(current.id);
      current = current.parentId ? nodeMap.get(current.parentId) : null;
    }
    return path;
  })();

  return (
    <div
      ref={appShellRef}
      className={`app-shell ${sidebarResizing ? "is-resizing-sidebar" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` }}
    >
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""} ${readOnly ? "is-read-only" : ""}`}>
        <div className="sidebar-title">
          <div>
            <div className="sidebar-brand">
              <span className="sidebar-learning-mode" aria-label="Solo" tabIndex={0}>
                <svg className="solo-logo-icon" viewBox="0 0 64 64" aria-hidden="true">
                  <path className="solo-logo-lines" d="M32 32 17 19M32 32 17 47M32 32 49 22" />
                  <circle className="solo-logo-core" cx="32" cy="32" r="7" />
                  <circle className="solo-logo-node solo-logo-node-a" cx="17" cy="19" r="4" />
                  <circle className="solo-logo-node solo-logo-node-b" cx="17" cy="47" r="4" />
                  <circle className="solo-logo-node solo-logo-node-c" cx="49" cy="22" r="4" />
                </svg>
                <span role="tooltip">Solo</span>
              </span>
              <div className="sidebar-brand-copy">
                <h2>Solo Learning</h2>
                <p>对知识产生好奇心</p>
              </div>
            </div>
          </div>
          <div className="sidebar-title-actions">
            <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} title="关闭">
              <X size={19} />
            </button>
          </div>
        </div>
        <div className="tree-scroll">
          {readOnly ? (
            <div className="sidebar-level sidebar-questions">
              <div className="question-navigation-header shared-navigation-header">
                <div className="question-navigation-title">
                  <HoverFullTitle as="strong" text={activeWorkspace?.title || "分享画布"} />
                  <span>{nodes.length} 个节点 · 只读分享</span>
                </div>
              </div>
              <div className="question-tree">
                {sortNodeSiblings(nodes.filter((node) => !node.parentId)).map((node) => (
                  <TreeNode
                    key={node.id}
                    node={node}
                    activeId={activeId}
                    activePath={activeTreePath}
                    children={children}
                    expanded={expanded}
                    readOnly
                    onSelect={openNodeFromTree}
                    onToggle={(id) => setExpanded((current) => {
                      const next = new Set(current);
                      next.has(id) ? next.delete(id) : next.add(id);
                      return next;
                    })}
                  />
                ))}
              </div>
            </div>
          ) : sidebarLevel === "workspaces" ? (
            <div className="sidebar-level sidebar-workspaces">
              <div className="sidebar-section-heading">
                <span>学习问题</span>
                <div className="sidebar-section-actions">
                  <small>{workspaces.length}</small>
                  <button
                    className="sidebar-create-button"
                    onClick={createBlankWorkspace}
                    title="新建空白画布"
                    aria-label="新建空白画布"
                  >
                    <Plus size={21} strokeWidth={2} />
                  </button>
                </div>
              </div>
              <div className="workspace-list">
                {orderedWorkspaces.map((item) => {
                  const itemNodes = item.nodes || [];
                  const status = itemNodes.some((node) => (
                    node.textFailed && node.visualFailed
                  ))
                    ? "生成失败"
                    : itemNodes.some((node) => node.visualFailed)
                      ? "图解待重试"
                      : itemNodes.some((node) => node.textFailed)
                        ? "文字待重试"
                    : itemNodes.some((node) => (
                        node.textLoading || node.visualLoading || node.regenerating
                      ))
                      ? "正在生成"
                      : `${itemNodes.length} 个节点`;
                  const isPending = status === "正在生成" || status.includes("生成中");
                  const isFailed = status.includes("失败") || status.includes("待重试");
                  return (
                    <div key={item.id} className={`workspace-item ${item.id === workspaceId ? "active" : ""}`}>
                      <button className="workspace-open" onClick={() => openWorkspaceQuestions(item.id)}>
                        <HoverFullTitle text={item.title || "新问题"} />
                        <small className={`${isPending ? "pending" : ""} ${isFailed ? "failed" : ""}`}>
                          {status}
                        </small>
                        <ChevronRight size={15} />
                      </button>
                      <button
                        className="workspace-delete"
                        title="删除画布"
                        aria-label={`删除画布：${item.title || "新画布"}`}
                        onClick={() => setDeleteTarget(item.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="sidebar-level sidebar-questions">
              <div className="question-navigation-header">
                <button
                  className="question-navigation-back"
                  onClick={() => setSidebarLevel("workspaces")}
                >
                  <ArrowLeft size={16} />
                  <span>所有问题</span>
                </button>
                <div className="question-navigation-title-row">
                  <div className="question-navigation-title">
                    <HoverFullTitle as="strong" text={activeWorkspace?.title || "新问题"} />
                  </div>
                  <span className="workspace-node-count">{nodes.length} 个节点</span>
                  <button
                    type="button"
                    className="workspace-export"
                    title="导出演示 HTML"
                    aria-label="导出演示 HTML"
                    disabled={!nodes.length}
                    onClick={exportCurrentWorkspace}
                  >
                    <Download size={14} />
                    <span>Export</span>
                  </button>
                </div>
              </div>
              <div className="question-tree">
                {!nodes.length ? (
                  <div className="tree-empty">
                    <Sparkles size={18} />
                    <span>从中间提出第一个问题</span>
                  </div>
                ) : (
                  <>
                    <div
                      className={`tree-root-dropzone ${draggedNodeId ? "is-visible" : ""} ${nodeDropTarget === "__root__" ? "is-over" : ""}`}
                      onDragOver={(event) => {
                        if (!draggedNodeId) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setNodeDropTarget("__root__");
                      }}
                      onDragLeave={(event) => {
                        if (event.currentTarget.contains(event.relatedTarget)) return;
                        setNodeDropTarget((current) => current === "__root__" ? null : current);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (draggedNodeId) moveNode(draggedNodeId, null);
                        setDraggedNodeId(null);
                        setNodeDropTarget(null);
                      }}
                    >
                      <GripVertical size={13} />
                      <span>移到根级问题</span>
                    </div>
                    {sortNodeSiblings(nodes.filter((node) => !node.parentId)).map((node) => (
                      <TreeNode
                        key={node.id}
                        node={node}
                        activeId={activeId}
                        activePath={activeTreePath}
                        children={children}
                        expanded={expanded}
                        draggedNodeId={draggedNodeId}
                        dropTarget={nodeDropTarget}
                        canDrop={(targetId) => {
                          if (!draggedNodeId || draggedNodeId === targetId) return false;
                          return !draggedNodeDescendants.has(targetId);
                        }}
                        onDragStart={(id, event) => {
                          setDraggedNodeId(id);
                          setNodeDropTarget(null);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", id);
                        }}
                        onDragEnd={() => {
                          setDraggedNodeId(null);
                          setNodeDropTarget(null);
                        }}
                        onDropNode={(targetId, position) => {
                          if (draggedNodeId) {
                            const target = nodesRef.current.find((item) => item.id === targetId);
                            moveNode(
                              draggedNodeId,
                              position === "inside" ? targetId : target?.parentId || null,
                              position,
                              targetId,
                            );
                          }
                          setDraggedNodeId(null);
                          setNodeDropTarget(null);
                        }}
                        onDropTargetChange={setNodeDropTarget}
                        onDelete={setDeleteNodeTarget}
                        onSelect={openNodeFromTree}
                        onToggle={(id) => setExpanded((current) => {
                          const next = new Set(current);
                          next.has(id) ? next.delete(id) : next.add(id);
                          return next;
                        })}
                      />
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="sidebar-footer">
          {readOnly ? <Link2 size={16} /> : <Clock3 size={16} />}
          <span>{readOnly ? "分享画布 · 仅供查看" : "探索内容自动保存到服务端"}</span>
        </div>
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label="调整导航栏宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          title="拖动调整导航栏宽度"
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
        >
          <GripVertical className="sidebar-resize-grip" size={15} strokeWidth={1.8} />
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏" />}

      <main className="main canvas-main">
        <button className="icon-button canvas-menu" title="打开学习画布" onClick={() => setSidebarOpen(true)}>
          <Menu size={20} />
        </button>
        {!readOnly && nodes.length > 0 && <CanvasVisualConfigBar config={visualConfig} />}
        {!readOnly && (!nodes.length || isFirstTopicTransition) && (
          <form
            className={`canvas-search is-home ${homeMode === "document" ? "is-document" : ""} ${isFirstTopicTransition ? "is-leaving" : ""} ${visualConfigOpen === "home" ? "has-visual-config" : ""}`}
            onSubmit={async (event) => {
              event.preventDefault();
              setVisualConfigOpen(null);
              if (homeMode === "document") {
                const title = documentName || documentText.split("\n").find(Boolean)?.slice(0, 30) || "粘贴文本";
                const imageIndex = documentImages.length
                  ? `\n\n【图片附件顺序】\n${documentImages.map((image, index) => `${index + 1}. ${image.name}`).join("\n")}`
                  : "";
                const parsedOutline = parseDocumentOutline(documentText);
                const sourceOutline = parsedOutline.length ? parsedOutline : documentOutline;
                const outlineIndex = sourceOutline.length
                  ? `\n\n【拆解模式】${documentDetail === "detailed" ? "详细" : "精简"}\n【原文章节索引】\n${sourceOutline.map((item) => {
                      let level = 1;
                      let parent = item.parent;
                      while (parent >= 0) {
                        level += 1;
                        parent = sourceOutline[parent]?.parent ?? -1;
                      }
                      const parentId = item.parent >= 0 ? sourceOutline[item.parent]?.sourceId || sourceOutline[item.parent]?.number : "-";
                      return `${item.sourceId || item.number}\tL${level}\t父级:${parentId}\t${item.title}`;
                    }).join("\n")}`
                  : "";
                const context = `${documentText.slice(0, 100_000 - imageIndex.length - outlineIndex.length)}${imageIndex}${outlineIndex}`;
                setDocumentPlanning(true);
                setError("");
                try {
                  const sourcePlan = documentDetail === "concise" && sourceOutline.length
                    ? (await waitForLessonTask(`plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, {
                        question: `规划：${title}`,
                        context,
                        inputMode: "document",
                        documentRoot: true,
                        answerMode: "plan",
                      })).outline
                    : [];
                  if (sourcePlan.length) applyDocumentPlan(sourceOutline, sourcePlan, true);
                  await createTopic(`拆解：${title}`, null, "", {
                    inputMode: "document",
                    context: `${context}\n\n【教学结构已预规划】`,
                    images: documentImages.map((image) => image.dataUrl),
                    imageEntries: documentImages,
                    sourceOutline,
                    sourcePlan,
                    documentDetail,
                  });
                } catch (planError) {
                  setError(planError.message || "教学结构检查失败，请重试");
                } finally {
                  setDocumentPlanning(false);
                }
                return;
              }
              void createTopic(query);
            }}
          >
            {!isFirstTopicTransition && (
              <div className="home-mode-tabs" aria-label="学习方式">
                <button type="button" className={homeMode === "question" ? "is-active" : ""} onClick={() => setHomeMode("question")}>
                  <Search size={14} />提问
                </button>
                <button type="button" className={homeMode === "document" ? "is-active" : ""} onClick={() => setHomeMode("document")}>
                  <FileText size={14} />拆资料
                </button>
              </div>
            )}
            {homeMode === "document" ? (
              <>
                <textarea
                  value={documentText}
                  onChange={(event) => {
                    setDocumentText(event.target.value);
                    setDocumentOutline(parseDocumentOutline(event.target.value));
                    setDocumentName("");
                  }}
                  placeholder="粘贴文章正文，或上传 PDF / Markdown ZIP…"
                  aria-label="粘贴文章或上传 PDF、Markdown ZIP"
                />
                <div className="document-meta">
                  <div className="document-detail-tabs" aria-label="拆解详细程度">
                    <button type="button" aria-pressed={documentDetail === "concise"} className={documentDetail === "concise" ? "is-active" : ""} onClick={() => setDocumentDetail("concise")} title="按学习目标重组原文，合并重复内容并把低优先级内容收入附录">精简</button>
                    <button type="button" aria-pressed={documentDetail === "detailed"} className={documentDetail === "detailed" ? "is-active" : ""} onClick={() => setDocumentDetail("detailed")} title="完整保留原著标题、层级和顺序">详细</button>
                  </div>
                  <span className="document-status">{documentLoading ? "正在识别页面与图片…" : documentPlanning ? "正在自检教学结构（尚未出图）…" : `${documentName || `${documentText.length.toLocaleString()} 字符`}${documentImages.length ? ` · ${documentImages.length} 张图` : ""}`}</span>
                </div>
                <label className="document-upload">
                  <Upload size={15} />
                  <span>PDF / ZIP / 图片</span>
                  <input
                    type="file"
                    accept="application/pdf,.pdf,application/zip,application/x-zip-compressed,.zip,image/png,image/jpeg,image/webp"
                    multiple
                    onChange={async (event) => {
                      const files = [...(event.target.files || [])];
                      if (!files.length) return;
                      setDocumentLoading(true);
                      setError("");
                      try {
                        const pdfFile = files.find((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
                        const zipFile = files.find((file) => /\.zip$/i.test(file.name));
                        if (pdfFile && zipFile) throw new Error("一次请选择一个 PDF 或 ZIP");
                        const imageFiles = files.filter((file) => file.type.startsWith("image/"));
                        const uploadedImages = await Promise.all(imageFiles.slice(0, MAX_DOCUMENT_IMAGES).map(async (file) => ({
                          name: file.name,
                          dataUrl: await fileToDataUrl(file),
                        })));
                        if (zipFile) {
                          const result = extractMarkdownArchive(await zipFile.arrayBuffer());
                          const archiveImages = await Promise.all(result.images.map(async (image) => ({
                            name: image.name,
                            dataUrl: await fileToDataUrl(new Blob([image.bytes], { type: image.type })),
                          })));
                          setDocumentText(result.text);
                          setDocumentOutline(result.outline);
                          setDocumentName(zipFile.name.replace(/\.zip$/i, ""));
                          setDocumentImages([...archiveImages, ...uploadedImages].slice(0, MAX_DOCUMENT_IMAGES));
                        } else if (pdfFile) {
                          const result = await extractPdfDocument(pdfFile);
                          setDocumentText(result.text);
                          setDocumentOutline(result.outline);
                          setDocumentName(pdfFile.name.replace(/\.pdf$/i, ""));
                          setDocumentImages([...result.images, ...uploadedImages].slice(0, MAX_DOCUMENT_IMAGES));
                        } else {
                          if (imageFiles[0]) setDocumentName(imageFiles[0].name.replace(/\.[^.]+$/, ""));
                          setDocumentImages((current) => [...current, ...uploadedImages].slice(0, MAX_DOCUMENT_IMAGES));
                        }
                      } catch (pdfError) {
                        setError(pdfError.message || "资料读取失败");
                      } finally {
                        setDocumentLoading(false);
                        event.target.value = "";
                      }
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <Search size={20} />
                <input
                  ref={homeQueryRef}
                  value={isFirstTopicTransition ? firstTopicTransition.question : query}
                  onChange={(event) => {
                    if (!isFirstTopicTransition) setQuery(event.target.value);
                  }}
                  placeholder="问一个你真正好奇的问题…"
                  aria-label="输入学习问题"
                />
              </>
            )}
            <VisualConfigControl
              config={visualConfig}
              open={visualConfigOpen === "home"}
              applying={visualConfigApplying}
              nodeCount={nodes.filter((node) => node.visual && !node.regenerating).length}
              onToggle={() => setVisualConfigOpen((current) => current === "home" ? null : "home")}
              onClose={() => setVisualConfigOpen(null)}
              onChange={updateVisualConfig}
              onApply={applyVisualConfigToAll}
              triggerLabel="视觉"
            />
            <button type="submit" disabled={homeMode === "document" ? documentLoading || documentPlanning || (!documentText.trim() && !documentImages.length) : !query.trim()} title={homeMode === "document" ? "开始梳理" : pendingCount ? "继续提交新问题" : "开始探索"}>
              <ArrowRight size={19} />
            </button>
            {!isFirstTopicTransition && homeMode === "question" && (
              <div
                className={`home-question-suggestions ${homeQuestionsChanging ? "is-changing" : ""}`}
                aria-label="推荐问题"
              >
                {homeQuestions.map((question, index) => (
                  <button
                    type="button"
                    key={question}
                    style={{ "--suggestion-index": index }}
                    onClick={() => {
                      setQuery(question);
                      requestAnimationFrame(() => homeQueryRef.current?.focus());
                    }}
                  >
                    <Sparkles size={12} />
                    <span>{question}</span>
                  </button>
                ))}
              </div>
            )}
          </form>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")} title="关闭"><X size={17} /></button>
          </div>
        )}
        <div
          className="infinite-canvas"
          ref={canvasRef}
          onClickCapture={(event) => {
            if (
              performance.now() < suppressSceneClickUntilRef.current
              && event.target.closest(".generated-scene")
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onWheel={(event) => {
            if (
              event.target.closest(".answer-left-panel, button, input, textarea, form")
            ) return;
            event.preventDefault();
            cancelCameraAnimation({ flushZoom: false });
            const rect = event.currentTarget.getBoundingClientRect();
            const px = event.clientX - rect.left;
            const py = event.clientY - rect.top;
            const current = cameraRef.current;
            const deltaMultiplier = event.deltaMode === 1
              ? 16
              : event.deltaMode === 2
                ? rect.height
                : 1;
            const boundedDelta = Math.max(-160, Math.min(160, event.deltaY * deltaMultiplier));
            const zoomSensitivity = event.ctrlKey ? 0.006 : 0.002;
            const nextScale = Math.min(
              1.35,
              Math.max(0.08, current.scale * Math.exp(-boundedDelta * zoomSensitivity)),
            );
            const worldX = (px - current.x) / current.scale;
            const worldY = (py - current.y) / current.scale;
            previewZoomCamera({
              x: px - worldX * nextScale,
              y: py - worldY * nextScale,
              scale: nextScale,
            });
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const dragSurface = event.target.closest(
              ".generated-scene, .scene-skeleton, .text-answer-skeleton",
            );
            if (
              event.target.closest("button, input, textarea, form")
              || (event.target.closest(".knowledge-board") && !dragSurface)
            ) return;
            if (dragSurface) {
              window.getSelection()?.removeAllRanges();
              selectionDraggingRef.current = false;
              setSelectionDragging(false);
              setSelectedDetail("");
              setSelectionSource(null);
              setSelectionAnchor(null);
            }
            cancelCameraAnimation();
            const current = cameraRef.current;
            panRef.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              cameraX: current.x,
              cameraY: current.y,
              scale: current.scale,
              nextX: current.x,
              nextY: current.y,
              startedOnScene: Boolean(event.target.closest(".generated-scene")),
              dragging: false,
            };
          }}
          onPointerMove={(event) => {
            if (!panRef.current) return;
            const deltaX = event.clientX - panRef.current.x;
            const deltaY = event.clientY - panRef.current.y;
            if (!panRef.current.dragging) {
              if (Math.hypot(deltaX, deltaY) < 5) return;
              panRef.current.dragging = true;
              window.getSelection()?.removeAllRanges();
              event.currentTarget.setPointerCapture(event.pointerId);
              setCanvasMotionState("is-panning", true);
            }
            panRef.current.nextX = panRef.current.cameraX + deltaX;
            panRef.current.nextY = panRef.current.cameraY + deltaY;
            if (panFrameRef.current) return;
            panFrameRef.current = requestAnimationFrame(() => {
              panFrameRef.current = null;
              if (!panRef.current) return;
              applyWorldTransform({
                x: panRef.current.nextX,
                y: panRef.current.nextY,
                scale: panRef.current.scale,
              });
            });
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (panFrameRef.current) cancelAnimationFrame(panFrameRef.current);
            panFrameRef.current = null;
            if (panRef.current?.dragging) {
              commitCamera({
                x: panRef.current.nextX,
                y: panRef.current.nextY,
                scale: panRef.current.scale,
              });
              if (panRef.current.startedOnScene) {
                suppressSceneClickUntilRef.current = performance.now() + 250;
              }
            }
            const wasDragging = Boolean(panRef.current?.dragging);
            panRef.current = null;
            if (wasDragging) setCanvasMotionState("is-panning", false);
          }}
          onPointerCancel={() => {
            const wasDragging = Boolean(panRef.current?.dragging);
            panRef.current = null;
            if (panFrameRef.current) cancelAnimationFrame(panFrameRef.current);
            panFrameRef.current = null;
            if (wasDragging) setCanvasMotionState("is-panning", false);
          }}
          onDoubleClick={(event) => {
            if (event.target.closest(".knowledge-board, button, input")) return;
            if (activeId) focusNode(activeId, 1);
          }}
        >
          {(!nodes.length || isFirstTopicTransition) && (
            <div className={`home-transition ${isFirstTopicTransition ? "is-leaving" : ""}`}>
              <HomeDemo />
            </div>
          )}
          <div
            className={`canvas-world ${isFirstTopicTransition ? "first-topic-enter" : ""} ${inspector ? "is-focused" : ""}`}
            ref={worldRef}
            style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }}
          >
            <svg className="board-links" width="8000" height="6000" aria-label="问题关联连线">
              {nodes.filter((node) => node.parentId).map((node) => {
                const parent = nodes.find((item) => item.id === node.parentId);
                if (!parent) return null;
                const x1 = parent.x + (parent.width || DEFAULT_BOARD_WIDTH);
                const y1 = parent.y + (parent.height || DEFAULT_BOARD_HEIGHT) / 2;
                const x2 = node.x;
                const y2 = node.y + (node.height || DEFAULT_BOARD_HEIGHT) / 2;
                const mid = (x1 + x2) / 2;
                const path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
                const fullTitle = node.title || node.question || "未命名问题";
                const labelLines = wrapConnectionTitle(fullTitle);
                const labelBoxWidth = Math.max(
                  72,
                  Math.min(168, Math.max(...labelLines.map((line) => line.width)) + 20),
                );
                const labelLineHeight = 17;
                const labelBoxHeight = labelLines.length * labelLineHeight + 12;
                const labelX = mid;
                const labelY = (y1 + y2) / 2;
                const openEndpoint = (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  focusLinkEndpoint(parent, node);
                };
                return (
                  <g
                    className="board-link-group"
                    key={node.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看关联节点：${parent.title} 与 ${fullTitle}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={openEndpoint}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") openEndpoint(event);
                    }}
                  >
                    <path className="board-link-visible" d={path} />
                    <path className="board-link-hit" d={path} />
                    <g
                      className="board-link-label"
                      transform={`translate(${labelX} ${labelY})`}
                    >
                      <title>{fullTitle}</title>
                      <rect
                        x={-labelBoxWidth / 2}
                        y={-labelBoxHeight / 2}
                        width={labelBoxWidth}
                        height={labelBoxHeight}
                        rx="4"
                      />
                      <text
                        textAnchor="middle"
                        y={-((labelLines.length - 1) * labelLineHeight) / 2}
                      >
                        {labelLines.map((line, index) => (
                          <tspan
                            key={`${index}-${line.text}`}
                            x="0"
                            dy={index === 0 ? 0 : labelLineHeight}
                          >
                            {line.text}
                          </tspan>
                        ))}
                      </text>
                    </g>
                  </g>
                );
              })}
            </svg>
            {nodes.map((node) => (
              <KnowledgeBoard
                key={node.id}
                node={node}
                active={node.id === activeId}
                focused={node.id === inspector?.nodeId}
                onSelect={() => focusNode(node.id, 1)}
                onInspect={(selection) => openInspector(node, selection)}
                onExplore={(question, elementLabel) => createTopic(question, node, elementLabel)}
                readOnly={readOnly}
                onRegenerate={() => {
                  setRegenerateTarget(node.id);
                  setRegenerateFeedback("");
                }}
                onRetryText={() => retryTextNode(node)}
                followupOpen={followupNodeId === node.id}
                followupLabel={node.id === inspector?.nodeId ? inspector.label : node.title}
                followupQuery={followupNodeId === node.id ? drillQuery : ""}
                onSelectionStart={() => {
                  selectionDraggingRef.current = true;
                  setSelectionDragging(true);
                  setSelectedDetail("");
                  setSelectionSource(null);
                  setSelectionAnchor(null);
                }}
                onOpenFollowup={() => {
                  setFollowupNodeId(node.id);
                  setDrillQuery("");
                }}
                onFollowupQueryChange={setDrillQuery}
                onCancelFollowup={() => {
                  setFollowupNodeId(null);
                  setDrillQuery("");
                }}
                onSubmitFollowup={(label = node.title, event) => {
                  const question = drillQuery.trim();
                  if (!question) return;
                  createTopic(question, node, label, {
                    noticeAnchor: getNoticeAnchor(event),
                  });
                  setInspector(null);
                  setFollowupNodeId(null);
                  setDrillQuery("");
                }}
                inspectorPanel={node.id === inspector?.nodeId ? (
                  <IntegratedInspector
                    nodeId={node.id}
                    inspector={inspector}
                    questions={inspector.questions}
                    getLinkedTask={(question) => findRecommendedTask(inspector.nodeId, question)}
                    onSelectionStart={() => {
                      selectionDraggingRef.current = true;
                      setSelectionDragging(true);
                      setSelectedDetail("");
                      setSelectionSource(null);
                      setSelectionAnchor(null);
                    }}
                    readOnly={readOnly}
                    onAskRecommended={askRecommendedQuestion}
                    onClose={() => {
                      setInspector(null);
                      setSelectedDetail("");
                      setSelectionSource(null);
                      setSelectionAnchor(null);
                    }}
                  />
                ) : null}
              />
            ))}
          </div>
        </div>
        {!readOnly && createdNodeNotice && (
          <button
            type="button"
            className="created-node-notice"
            role="status"
            style={createdNodeNotice.anchor || undefined}
            title={`去查看：${createdNodeNotice.question}`}
            onClick={() => {
              focusNode(createdNodeNotice.nodeId, 1);
              setCreatedNodeNotice(null);
            }}
          >
            <span>去查看</span>
            <ArrowRight size={13} />
          </button>
        )}
        {!readOnly && !selectionDragging && selectedDetail && selectionAnchor && (
          <button
            type="button"
            className="selection-question"
            style={{ left: selectionAnchor.x, top: selectionAnchor.y }}
            onPointerDown={(event) => event.preventDefault()}
            onClick={askAboutSelection}
          >
            <Search size={13} />详细介绍
          </button>
        )}
        {!readOnly && regenerateTarget && (() => {
          const targetNode = nodes.find((item) => item.id === regenerateTarget);
          if (!targetNode) return null;
          return (
            <div
              className="regenerate-backdrop"
              role="presentation"
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                setRegenerateTarget(null);
                setRegenerateFeedback("");
              }}
            >
              <form
                className="regenerate-dialog"
                onSubmit={(event) => {
                  event.preventDefault();
                  regenerateNode(targetNode, regenerateFeedback);
                }}
              >
                <div className="regenerate-dialog-header">
                  <div>
                    <strong>修正图解</strong>
                    <span>{targetNode.title}</span>
                  </div>
                  <button
                    type="button"
                    title="关闭"
                    onClick={() => {
                      setRegenerateTarget(null);
                      setRegenerateFeedback("");
                    }}
                  >
                    <X size={17} />
                  </button>
                </div>
                <textarea
                  autoFocus
                  value={regenerateFeedback}
                  onChange={(event) => setRegenerateFeedback(event.target.value)}
                  placeholder="可选：说明哪里不满意；留空将自动重新设计整幅图解"
                  maxLength={500}
                />
                <div className="regenerate-dialog-actions">
                  <span>{regenerateFeedback.length}/500</span>
                  <button type="submit">
                    <RefreshCw size={14} />重新生成
                  </button>
                </div>
              </form>
            </div>
          );
        })()}
        {!readOnly && deleteTarget && (() => {
          const targetWorkspace = workspaces.find((item) => item.id === deleteTarget);
          if (!targetWorkspace) return null;
          return (
            <div
              className="delete-backdrop"
              role="presentation"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setDeleteTarget(null);
              }}
            >
              <section
                className="delete-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-dialog-title"
                aria-describedby="delete-dialog-description"
              >
                <div className="delete-dialog-icon" aria-hidden="true">
                  <Trash2 size={18} />
                </div>
                <div className="delete-dialog-copy">
                  <strong id="delete-dialog-title">删除这个学习问题？</strong>
                  <span>{targetWorkspace.title || "新问题"}</span>
                  <p id="delete-dialog-description">对应的问题目录和所有图解都会被删除，此操作无法撤销。</p>
                </div>
                <div className="delete-dialog-actions">
                  <button type="button" className="delete-cancel" onClick={() => setDeleteTarget(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="delete-confirm"
                    autoFocus
                    onClick={() => deleteWorkspace(deleteTarget)}
                  >
                    <Trash2 size={14} />删除
                  </button>
                </div>
              </section>
            </div>
          );
        })()}
        {!readOnly && deleteNodeTarget && (() => {
          const targetNode = nodes.find((item) => item.id === deleteNodeTarget);
          if (!targetNode) return null;
          const descendantCount = getNodeDescendantIds(nodes, targetNode.id).size;
          return (
            <div
              className="delete-backdrop"
              role="presentation"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setDeleteNodeTarget(null);
              }}
            >
              <section
                className="delete-dialog node-delete-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-node-dialog-title"
                aria-describedby="delete-node-dialog-description"
              >
                <div className="delete-dialog-icon" aria-hidden="true">
                  <Trash2 size={18} />
                </div>
                <div className="delete-dialog-copy">
                  <strong id="delete-node-dialog-title">删除这个节点？</strong>
                  <span>{targetNode.title}</span>
                  <p id="delete-node-dialog-description">
                    {descendantCount
                      ? `这个节点下还有 ${descendantCount} 个问题，请选择如何处理。`
                      : "节点对应的回答和图解都会被删除，此操作无法撤销。"}
                  </p>
                </div>
                <div className="delete-dialog-actions node-delete-actions">
                  <button type="button" className="delete-cancel" onClick={() => setDeleteNodeTarget(null)}>
                    取消
                  </button>
                  {descendantCount > 0 && (
                    <button
                      type="button"
                      className="delete-reparent"
                      onClick={() => deleteNode(targetNode.id, "single")}
                    >
                      仅删当前节点
                    </button>
                  )}
                  <button
                    type="button"
                    className="delete-confirm"
                    autoFocus
                    onClick={() => deleteNode(targetNode.id, "branch")}
                  >
                    <Trash2 size={14} />{descendantCount ? "删除整个分支" : "删除"}
                  </button>
                </div>
              </section>
            </div>
          );
        })()}
      </main>
    </div>
  );
}

function HomeDemo() {
  return (
    <section className="home-demo" aria-label="知识场景正在等待构建">
      <div className="home-skeleton-floor" />
      <svg className="home-skeleton-draft" viewBox="0 35 760 370" role="img">
        <defs>
          <linearGradient id="home-draft-face" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity=".58" />
            <stop offset="1" stopColor="var(--accent-strong)" stopOpacity=".08" />
          </linearGradient>
          <filter id="home-draft-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g className="home-draft-horizon">
          <path d="M52 277 L380 116 L708 277 L380 354 Z" />
          <path d="M134 277 L380 156 L626 277 L380 330 Z" />
          <path d="M216 277 L380 196 L544 277 L380 307 Z" />
          <path d="M298 277 L380 236 L462 277 L380 284 Z" />
          <path d="M134 237 L462 76 M216 317 L544 156 M298 354 L626 196" />
          <path d="M626 237 L298 76 M544 317 L216 156 M462 354 L134 196" />
        </g>
        <g className="home-draft-object home-object-left">
          <path className="home-draft-face" d="M126 198 L218 153 L282 184 L190 230 Z" />
          <path d="M126 198 L126 270 L190 302 L190 230 Z" />
          <path d="M190 230 L282 184 L282 255 L190 302 Z" />
          <path d="M151 220 L190 240 L254 208 M151 245 L190 265 L254 233" />
        </g>
        <g className="home-draft-object home-object-center">
          <path className="home-draft-face" d="M304 143 L392 99 L474 140 L386 185 Z" />
          <path d="M304 143 L304 259 L386 301 L386 185 Z" />
          <path d="M386 185 L474 140 L474 256 L386 301 Z" />
          <path d="M330 163 L386 191 L448 160 M330 193 L386 221 L448 190 M330 223 L386 251 L448 220" />
          <path className="home-draft-energy" d="M386 118 L386 278" />
        </g>
        <g className="home-draft-object home-object-right">
          <path className="home-draft-face" d="M502 204 L570 170 L644 207 L576 241 Z" />
          <path d="M502 204 L502 267 L576 305 L576 241 Z" />
          <path d="M576 241 L644 207 L644 270 L576 305 Z" />
          <path d="M523 226 L576 253 L623 229 M523 250 L576 277 L623 253" />
        </g>
        <g className="home-draft-connections">
          <path d="M282 218 C313 202 329 199 353 207" />
          <path d="M421 211 C460 204 481 215 502 235" />
        </g>
      </svg>
    </section>
  );
}

function VisualConfigControl({
  config,
  open,
  applying = false,
  nodeCount = 0,
  onToggle,
  onClose,
  onChange,
  onApply,
  compact = false,
  triggerLabel = "",
  footerText = "",
  showApply = true,
}) {
  const controlRef = useRef(null);
  const [popoverPosition, setPopoverPosition] = useState(null);
  const configuredCount = Object.values(config).filter((value) => value !== "auto").length;
  useEffect(() => {
    if (!open) return undefined;
    if (compact) {
      const rect = controlRef.current?.getBoundingClientRect();
      if (rect) {
        setPopoverPosition({
          right: Math.max(10, window.innerWidth - rect.right),
          bottom: Math.max(10, window.innerHeight - rect.top + 8),
        });
      }
    }
    const closeOnOutsideClick = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const clickedInside = path.includes(controlRef.current)
        || controlRef.current?.contains(event.target)
        || (event.target instanceof Element && event.target.closest(".visual-config-popover"));
      if (!clickedInside) onClose();
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("click", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onClose, compact]);

  return (
    <div
      ref={controlRef}
      className={`visual-config-control ${compact ? "is-compact" : ""}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`visual-config-trigger ${configuredCount ? "is-configured" : ""} ${triggerLabel ? "has-label" : ""}`}
        onClick={onToggle}
        title="当前画布视觉配置"
        aria-label="当前画布视觉配置"
        aria-expanded={open}
      >
        <Settings2 size={16} />
        {triggerLabel && <span>{triggerLabel}</span>}
        {configuredCount > 0 && <i>{configuredCount}</i>}
      </button>
      {open && (
        compact ? createPortal(<VisualConfigPopover
          config={config}
          applying={applying}
          nodeCount={nodeCount}
          onClose={onClose}
          onChange={onChange}
          onApply={onApply}
          footerText={footerText}
          showApply={showApply}
          floating={compact}
          floatingPosition={popoverPosition}
        />, document.body) : <VisualConfigPopover
          config={config}
          applying={applying}
          nodeCount={nodeCount}
          onClose={onClose}
          onChange={onChange}
          onApply={onApply}
          footerText={footerText}
          showApply={showApply}
        />
      )}
    </div>
  );
}

function CanvasVisualConfigBar({ config }) {
  return (
    <div className="canvas-visual-config" aria-label="当前画布生成配置">
      <div className="canvas-config-title">
        <Settings2 size={12} />
        <span>生成配置</span>
      </div>
      <div className="canvas-config-values">
        {VISUAL_CONFIG_GROUPS.map(([key, shortLabel]) => (
          <div key={key} title={`${shortLabel}：${getVisualConfigLabel(key, config[key])}`}>
            <small>{shortLabel}</small>
            <strong>{getVisualConfigLabel(key, config[key])}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function VisualConfigPopover({
  config,
  applying,
  nodeCount,
  onClose,
  onChange,
  onApply,
  footerText = "",
  showApply = true,
  floating = false,
  floatingPosition = null,
}) {
  const [expandedGroup, setExpandedGroup] = useState(null);
  return (
    <section
      className="visual-config-popover"
      aria-label="视觉配置"
      data-floating={floating ? "true" : undefined}
      style={floating && floatingPosition ? {
        right: floatingPosition.right,
        bottom: floatingPosition.bottom,
      } : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      <header>
        <div>
          <strong>视觉配置</strong>
          <span>当前画布统一使用</span>
        </div>
        <button type="button" onClick={onClose} title="关闭视觉配置">
          <X size={15} />
        </button>
      </header>
      {VISUAL_CONFIG_GROUPS.map(([key, , label]) => (
        <div className={`visual-config-group ${expandedGroup === key ? "is-expanded" : ""}`} key={key}>
          <button
            type="button"
            className="visual-config-group-trigger"
            onClick={() => setExpandedGroup((current) => current === key ? null : key)}
            aria-expanded={expandedGroup === key}
          >
            <span>{label}</span>
            <strong>{getVisualConfigLabel(key, config[key])}</strong>
            <ChevronDown size={14} />
          </button>
          {expandedGroup === key && (
            <div className="visual-config-options">
              {VISUAL_CONFIG_OPTIONS[key].map(([value, optionLabel]) => {
                const automatic = value === "auto";
                return (
                  <button
                    type="button"
                    key={value}
                    className={`visual-config-option ${config[key] === value ? "is-selected" : ""} ${automatic ? "is-automatic" : ""}`}
                    onClick={() => {
                      onChange(key, value);
                      setExpandedGroup(null);
                    }}
                  >
                    {!automatic && <VisualConfigOptionPreview groupKey={key} value={value} />}
                    <span>
                      <strong>{optionLabel}</strong>
                      <small>{automatic ? getAutomaticConfigDescription(key) : getVisualConfigOptionDescription(key, value)}</small>
                    </span>
                    {config[key] === value && <i aria-label="已选择">✓</i>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <p>{footerText || (nodeCount ? "配置会自动保存；应用后将按此设置重绘当前画布全部图解" : "配置会自动保存，并用于这个画布接下来生成的图解")}</p>
      {showApply && nodeCount > 0 && (
        <button
          type="button"
          className="visual-config-apply"
          onClick={onApply}
          disabled={applying}
        >
          <RefreshCw size={13} />
          {applying ? "正在应用" : `应用到 ${nodeCount} 个图解`}
        </button>
      )}
    </section>
  );
}

function getAutomaticConfigDescription(key) {
  return {
    space: "根据问题结构选择平面、等距、透视或剖面",
    style: "根据题材与知识目标选择绘制方式",
    tone: "根据内容场景自动匹配颜色与明暗",
    domain: "从问题中判断最合适的领域表达",
  }[key];
}

function getVisualConfigOptionDescription(groupKey, value) {
  const descriptions = {
    space: {
      "2d": "平面流程、时间线与直接对比",
      isometric: "稳定的立体结构与空间关系",
      "pseudo-3d": "具有纵深和近大远小的场景",
      section: "展示内部结构、层级与装配关系",
    },
    style: {
      realistic: "更接近真实物体、材质与环境",
      technical: "强调尺寸、结构和工程关系",
      infographic: "图形、数据与短标签组合表达",
      "line-art": "通过精细轮廓和局部线条解释",
      handdrawn: "白底抖动线稿、留白和动作隐喻",
      minimal: "只保留最关键的对象和关系",
    },
    tone: {
      natural: "接近现实环境的自然色彩",
      bright: "浅色背景与明快清晰的强调色",
      cool: "冷色、克制且偏专业的视觉感受",
      warm: "温和亲切，适合生活与人文主题",
      contrast: "强烈明暗与色彩反差突出重点",
    },
    domain: {
      technology: "芯片、电子设备与硬件系统",
      industry: "工厂、设备、产线与制造过程",
      medical: "人体结构、临床与生命机制",
      nature: "地貌、生态、物理与自然现象",
      business: "产业链、经营、供需与价值流",
      history: "时代场景、事件关系与文化对象",
      software: "界面、数据、网络与软件架构",
      daily: "日常用品、生活现象与工作原理",
    },
  };
  return descriptions[groupKey]?.[value] || "";
}

function VisualConfigOptionPreview({ groupKey, value }) {
  const commonProps = {
    viewBox: "0 0 132 72",
    "aria-hidden": "true",
  };

  if (groupKey === "space") {
    if (value === "2d") return (
      <svg {...commonProps}>
        <rect width="132" height="72" fill="var(--info-light)" />
        <rect x="10" y="23" width="28" height="25" fill="var(--accent)" />
        <rect x="52" y="13" width="28" height="25" fill="var(--warning)" />
        <rect x="94" y="31" width="28" height="25" fill="var(--accent)" />
        <path d="M38 35 C44 35 46 25 52 25 M80 26 C87 26 87 43 94 43" fill="none" stroke="var(--ink)" strokeWidth="2" strokeDasharray="4 3" />
      </svg>
    );
    if (value === "isometric") return (
      <svg {...commonProps}>
        <rect width="132" height="72" fill="var(--paper)" />
        <path d="M18 40 44 27 70 40 44 53Z" fill="var(--warning)" />
        <path d="M18 40v14l26 13V53Z" fill="var(--warning-strong)" />
        <path d="M70 40v14L44 67V53Z" fill="var(--warning)" />
        <path d="m61 27 22-11 26 13-22 11Z" fill="var(--info)" />
        <path d="M61 27v14l26 13V40Z" fill="var(--info)" />
        <path d="M109 29v14L87 54V40Z" fill="var(--accent-strong)" />
      </svg>
    );
    if (value === "pseudo-3d") return (
      <svg {...commonProps}>
        <defs><linearGradient id="space-perspective" x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--info-light)" /><stop offset="1" stopColor="var(--paper)" /></linearGradient></defs>
        <rect width="132" height="72" fill="url(#space-perspective)" />
        <path d="M51 72 63 24h6l14 48Z" fill="var(--ink)" />
        <path d="m16 61 43-37M116 61 73 24" stroke="var(--muted)" strokeWidth="1.5" />
        <rect x="18" y="29" width="22" height="27" fill="var(--accent)" />
        <rect x="91" y="20" width="14" height="19" fill="var(--warning)" />
      </svg>
    );
    return (
      <svg {...commonProps}>
        <rect width="132" height="72" fill="var(--canvas)" />
        <path d="M28 20h45v35H28Z" fill="#d9b555" stroke="var(--ink)" strokeWidth="1.5" />
        <path d="M35 26h31v23H35Z" fill="#f5eedf" />
        <path d="M78 17h26v38H78Z" fill="var(--info)" stroke="var(--ink)" strokeWidth="1.5" />
        <path d="M73 22h5M73 31h5M73 40h5M73 49h5" stroke="#bd624d" strokeWidth="2" />
        <circle cx="50" cy="38" r="7" fill="none" stroke="#bd624d" strokeWidth="3" />
      </svg>
    );
  }

  if (groupKey === "style") {
    if (value === "realistic") return (
      <svg {...commonProps}>
        <defs><linearGradient id="style-real-sky" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#9dcad0" /><stop offset="1" stopColor="#f2d8a7" /></linearGradient></defs>
        <rect width="132" height="72" fill="url(#style-real-sky)" />
        <path d="M0 54 30 31l17 15 20-26 26 28 17-13 22 19v18H0Z" fill="var(--info)" />
        <path d="M52 72 65 43l14 29Z" fill="#e7d6b2" opacity=".82" />
        <circle cx="105" cy="17" r="8" fill="#f5cf68" />
      </svg>
    );
    if (value === "technical") return (
      <svg {...commonProps}>
        <rect width="132" height="72" fill="var(--ink)" />
        <g fill="none" stroke="#bce6df" strokeWidth="1">
          <path d="M20 50V20h48v30Zm8-7 14-16 17 16Z" />
          <circle cx="91" cy="35" r="17" /><circle cx="91" cy="35" r="7" />
          <path d="M12 58h108M12 14h108M75 10v50" strokeDasharray="3 3" opacity=".65" />
        </g>
      </svg>
    );
    if (value === "infographic") return (
      <svg {...commonProps}>
        <rect width="132" height="72" fill="#f6f0e3" />
        <circle cx="28" cy="35" r="17" fill="#e2b74e" />
        <path d="M28 18a17 17 0 0 1 15 25L28 35Z" fill="#d9654e" />
        <rect x="55" y="16" width="61" height="7" fill="var(--accent)" />
        <rect x="55" y="31" width="45" height="7" fill="var(--info-light)" />
        <rect x="55" y="46" width="54" height="7" fill="#d7a94b" />
      </svg>
    );
    if (value === "line-art") return (
      <svg {...commonProps}>
        <rect width="132" height="72" fill="#fbf8ee" />
        <g fill="none" stroke="#263d37" strokeWidth="1.5">
          <circle cx="44" cy="36" r="18" /><circle cx="44" cy="36" r="7" />
          <path d="m44 13 3 6m17 0-5 5m8 15-7-1m-7 16-3-7m-20 8 4-7m-12-7 7-2m-5-17 7 4" />
          <path d="M73 21h42M73 31h34M73 41h42M73 51h27" />
        </g>
      </svg>
    );
    if (value === "handdrawn") return (
      <svg {...commonProps}>
        <rect width="132" height="72" fill="#fff" />
        <g fill="none" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="m13 53 17-2 1-26 33-2 2 28 18 2" />
          <path d="m38 36 10-7 9 7-9 8Z" />
          <path d="M93 42c-1-11 14-13 16-2 2 10-12 15-16 2Z" fill="#171717" />
          <path d="m97 50-3 12m10-12 5 11m-14-17-9 7m21-8 10-6" />
        </g>
        <circle cx="99" cy="39" r="1.5" fill="#fff" /><circle cx="105" cy="39" r="1.5" fill="#fff" />
        <path d="M69 37c8-7 12-6 18-1" fill="none" stroke="#d77845" strokeWidth="2.5" strokeLinecap="round" />
        <path d="m83 32 5 4-5 3" fill="none" stroke="#d77845" strokeWidth="2" />
        <path d="M15 14h25" stroke="#cf5d52" strokeWidth="2" /><path d="M91 18h24" stroke="#5d8ea3" strokeWidth="2" />
      </svg>
    );
    return (
      <svg {...commonProps}>
        <rect width="132" height="72" fill="#f7f5ee" />
        <circle cx="35" cy="36" r="16" fill="var(--accent)" />
        <rect x="60" y="22" width="43" height="28" fill="#e3b448" />
        <path d="M48 36h12" stroke="#20241f" strokeWidth="2" />
      </svg>
    );
  }

  if (groupKey === "tone") {
    /* Solo archive tone palettes (5 sets, all from the 22-token color card) */
    const palettesByTone = {
      natural: ["#88A2B9", "#6E665E", "#D6B06C", "#FAF6F1"],
      bright:  ["#D0937F", "#FCFAF7", "#D6B06C", "#FFFDFB"],
      cool:    ["#88A2B9", "#39342F", "#B6ABBC", "#DBE5ED"],
      warm:    ["#D0937F", "#F0DED7", "#D6B06C", "#FAF6F1"],
      contrast:["#1a1714", "#D6B06C", "#D0937F", "#FFFDFB"],
    };
    const colors = palettesByTone[value];
    return (
      <svg {...commonProps}>
        <rect width="132" height="72" fill={colors[3]} />
        <circle cx="30" cy="35" r="17" fill={colors[1]} />
        <rect x="55" y="17" width="55" height="13" fill={colors[2]} />
        <rect x="55" y="39" width="38" height="13" fill={colors[0]} stroke={colors[1]} strokeWidth="2" />
        <path d="M47 35h8" stroke={value === "contrast" ? "#fff" : colors[1]} strokeWidth="3" />
      </svg>
    );
  }

  if (value === "technology") return (
    <svg {...commonProps}>
      <rect width="132" height="72" fill="#e7eeee" />
      <rect x="40" y="15" width="52" height="42" rx="3" fill="var(--accent-strong)" />
      <rect x="50" y="24" width="32" height="24" fill="#d6b04e" />
      <g stroke="var(--accent-strong)" strokeWidth="2"><path d="M28 20h12M28 30h12M28 40h12M28 50h12M92 20h12M92 30h12M92 40h12M92 50h12" /></g>
    </svg>
  );
  if (value === "industry") return (
    <svg {...commonProps}>
      <rect width="132" height="72" fill="#ecebe4" />
      <path d="M13 57V31l22 10V28l24 12V20h15v37Z" fill="var(--stone)" />
      <rect x="80" y="24" width="35" height="33" fill="#d2a648" />
      <circle cx="92" cy="42" r="8" fill="none" stroke="#354b45" strokeWidth="3" />
      <path d="M0 58h132" stroke="#293d38" strokeWidth="3" />
    </svg>
  );
  if (value === "medical") return (
    <svg {...commonProps}>
      <rect width="132" height="72" fill="#f2ece9" />
      <path d="M43 53C18 37 29 17 43 27c14-10 25 10 0 26Z" fill="#d7635b" />
      <rect x="72" y="17" width="40" height="40" rx="20" fill="#dcebe5" />
      <path d="M92 27v20M82 37h20" stroke="#438174" strokeWidth="5" />
    </svg>
  );
  if (value === "nature") return (
    <svg {...commonProps}>
      <rect width="132" height="72" fill="#dcebea" />
      <circle cx="105" cy="17" r="8" fill="#e6bd55" />
      <path d="M0 59 33 24l20 23 17-16 31 28Z" fill="var(--stone)" />
      <path d="M17 60 32 38l15 22Z" fill="var(--accent-strong)" />
      <rect x="29" y="54" width="5" height="11" fill="#735748" />
    </svg>
  );
  if (value === "business") return (
    <svg {...commonProps}>
      <rect width="132" height="72" fill="#f4efe4" />
      <rect x="17" y="39" width="17" height="20" fill="#7ca699" />
      <rect x="43" y="27" width="17" height="32" fill="#d9ad4c" />
      <rect x="69" y="17" width="17" height="42" fill="#d46850" />
      <path d="m17 31 27-10 23 5 27-15" fill="none" stroke="#273f38" strokeWidth="2.5" />
      <circle cx="94" cy="11" r="4" fill="#273f38" />
    </svg>
  );
  if (value === "history") return (
    <svg {...commonProps}>
      <rect width="132" height="72" fill="#eee3ce" />
      <path d="M17 24 48 11l31 13Z" fill="#8a654d" />
      <path d="M23 27h7v29h-7zm15 0h7v29h-7zm15 0h7v29h-7zm15 0h7v29h-7zM16 57h66" fill="#9f7655" stroke="#76533e" strokeWidth="2" />
      <path d="M92 19h24v39H92Z" fill="#d1b37a" stroke="#76533e" strokeWidth="2" />
      <path d="M97 28h14M97 36h14M97 44h10" stroke="#76533e" />
    </svg>
  );
  if (value === "software") return (
    <svg {...commonProps}>
      <rect width="132" height="72" fill="#e6eceb" />
      <rect x="13" y="12" width="106" height="48" rx="3" fill="#244d56" />
      <circle cx="22" cy="20" r="2" fill="#df6c55" /><circle cx="29" cy="20" r="2" fill="#e0b64d" />
      <path d="m35 34-8 7 8 7M53 31l-7 20M63 34l8 7-8 7" fill="none" stroke="#bde0d8" strokeWidth="2.5" />
      <rect x="82" y="30" width="25" height="5" fill="#e1b44b" /><rect x="82" y="41" width="18" height="5" fill="#70a99c" />
    </svg>
  );
  return (
    <svg {...commonProps}>
      <rect width="132" height="72" fill="#f3ebda" />
      <path d="M15 38 42 17l27 21v25H15Z" fill="#d9b158" />
      <rect x="29" y="44" width="13" height="19" fill="#805a47" />
      <path d="M88 25h19v27H88Z" fill="#6e9b8c" />
      <path d="M91 20c0-7 10-7 10 0M108 34c10 0 10 12 0 12" fill="none" stroke="#466c61" strokeWidth="2" />
    </svg>
  );
}

function KnowledgeBoard({
  node,
  active,
  focused,
  readOnly,
  onSelect,
  onInspect,
  onRegenerate,
  onRetryText,
  followupOpen,
  followupLabel,
  followupQuery,
  onSelectionStart,
  onOpenFollowup,
  onFollowupQueryChange,
  onCancelFollowup,
  onSubmitFollowup,
  inspectorPanel,
}) {
  return (
    <article
      className={`knowledge-board ${active ? "active" : ""} ${focused ? "is-focused" : ""}`}
      data-node-id={node.id}
      data-zoom-label={node.title || node.question || "知识节点"}
      style={{
        left: node.x,
        top: node.y,
        width: node.width || DEFAULT_BOARD_WIDTH,
        height: node.height || DEFAULT_BOARD_HEIGHT,
        "--coral": node.palette[0],
        "--gold": node.palette[1],
        "--green": node.palette[2],
        "--paper-deep": node.palette[3],
      }}
      onClick={(event) => {
        if (event.target.closest(".generated-scene, button, input, form")) return;
        if (window.getSelection()?.toString().trim()) return;
        onSelect();
      }}
    >
      {!readOnly && !node.visualLoading && !node.regenerating && (
        <button
          type="button"
          className="regenerate-scene"
          title="重新生成图解"
          aria-label="重新生成图解"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRegenerate();
          }}
        >
          <RefreshCw size={15} />
        </button>
      )}
      <AnswerContainer
        node={node}
        active={active}
        onInspect={onInspect}
        onRegenerate={onRegenerate}
        onRetryText={onRetryText}
        followupOpen={followupOpen}
        followupLabel={followupLabel}
        followupQuery={followupQuery}
        onSelectionStart={onSelectionStart}
        onOpenFollowup={onOpenFollowup}
        onFollowupQueryChange={onFollowupQueryChange}
        onCancelFollowup={onCancelFollowup}
        onSubmitFollowup={onSubmitFollowup}
        inspectorPanel={inspectorPanel}
        readOnly={readOnly}
      />
    </article>
  );
}

function AnswerContainer({
  node,
  active,
  readOnly,
  onInspect,
  onRegenerate,
  onRetryText,
  followupOpen,
  followupLabel,
  followupQuery,
  onSelectionStart,
  onOpenFollowup,
  onFollowupQueryChange,
  onCancelFollowup,
  onSubmitFollowup,
  inspectorPanel,
}) {
  return (
    <section className="answer-container">
      <div className="answer-visual-panel">
        {node.visual ? (
          <AnimatedExplainer
            topic={node.title}
            summary={node.summary}
            questions={node.children}
            palette={node.palette}
            visual={node.visual}
            active={active}
            onInspect={onInspect}
          />
        ) : (
          <SceneSkeleton
            question={node.question}
            startedAt={node.loadingStartedAt}
            estimatedMs={node.estimatedMs}
            failed={node.visualFailed}
            failureMessage={node.visualFailureMessage}
            onRetry={readOnly ? null : onRegenerate}
          />
        )}
      </div>
      <div className="answer-left-panel">
        {inspectorPanel || (
          <div className="answer-copy-panel">
        {node.textLoading && !node.summary ? (
          <TextAnswerSkeleton question={node.question} />
        ) : node.textFailed && !node.summary ? (
          <div className="text-answer-failure">
            <span>文字答案生成失败</span>
            <strong>{node.question}</strong>
            <p>{node.textFailureMessage}</p>
            {!readOnly && (
              <button type="button" onClick={(event) => {
                event.stopPropagation();
                onRetryText();
              }}>
                <RefreshCw size={13} />重试文字答案
              </button>
            )}
          </div>
        ) : (
          <>
            <header>
              <div className="quick-answer-kicker">
                <MessageCircle size={15} />
                <span>{node.kicker || "直接回答"}</span>
              </div>
              <h3>{node.title}</h3>
            </header>
            <div className="answer-scroll-content">
              <MarkdownContent
                className="answer-markdown selectable-answer"
                nodeId={node.id}
                label={node.title}
                content={node.summary}
                onPointerDown={onSelectionStart}
              />
              <div className="quick-answer-facts">
                {Array.isArray(node.facts) ? node.facts.slice(0, 3).map((fact, index) => {
                  // Defensive: lesson-mode agents (claude / opencode) sometimes
                  // return facts as {label, description} objects instead of
                  // [label, detail] tuples. Normalize so the renderer never
                  // crashes on an unexpected shape.
                  let label = "";
                  let detail = "";
                  if (Array.isArray(fact)) {
                    label = fact[0] || "";
                    detail = fact[1] || "";
                  } else if (fact && typeof fact === "object") {
                    label = fact.label || fact.title || "";
                    detail = fact.description || fact.detail || fact.text || "";
                  } else if (typeof fact === "string") {
                    detail = fact;
                  }
                  return (
                    <div key={`${index}-${label}`}>
                      <strong>{label}</strong>
                      <MarkdownContent
                        className="quick-answer-fact-detail selectable-answer"
                        nodeId={node.id}
                        label={label}
                        content={detail}
                        onPointerDown={onSelectionStart}
                      />
                    </div>
                  );
                }) : null}
              </div>
            </div>
            {node.visualFailed && (
              <div className="answer-generation-state">
                <small className="failed">图解暂未生成</small>
              </div>
            )}
          </>
        )}
          </div>
        )}
        {!readOnly && (
          <FollowupDock
            label={followupLabel || node.title}
            open={followupOpen}
            query={followupQuery}
            onOpen={onOpenFollowup}
            onQueryChange={onFollowupQueryChange}
            onCancel={onCancelFollowup}
            onSubmit={(event) => onSubmitFollowup(followupLabel || node.title, event)}
          />
        )}
      </div>
    </section>
  );
}

function IntegratedInspector({
  nodeId,
  inspector,
  questions,
  getLinkedTask,
  onSelectionStart,
  onAskRecommended,
  onClose,
  readOnly,
}) {
  return (
    <aside
      className="integrated-inspector"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="inspector-copy">
        <strong>{inspector.label}</strong>
        <MarkdownContent
          className="inspector-detail selectable-answer"
          nodeId={nodeId}
          label={inspector.label}
          content={inspector.detail}
          onPointerDown={onSelectionStart}
        />
        {!readOnly && <div className="inspector-recommendation-area">
          <div className="inspector-recommendations">
            <small>推荐继续了解</small>
            {questions.map((rawQuestion, index) => {
              // Defensive: claude / opencode may return {question, reason} objects
              // (or other shapes) instead of plain strings. Normalize so the
              // renderer / onClick handler always see a real string.
              const question = typeof rawQuestion === "string"
                ? rawQuestion
                : rawQuestion && typeof rawQuestion === "object"
                  ? (rawQuestion.question || rawQuestion.text || rawQuestion.title || rawQuestion.label || JSON.stringify(rawQuestion))
                  : String(rawQuestion);
              const linkedTask = getLinkedTask(question);
              const linkedStatus = linkedTask
                ? linkedTask.failed || linkedTask.textFailed || linkedTask.visualFailed
                  ? "failed"
                  : linkedTask.loading || linkedTask.textLoading || linkedTask.visualLoading || linkedTask.regenerating
                    ? "pending"
                    : "completed"
                : "";
              const statusLabel = linkedStatus === "failed"
                ? "生成失败"
                : linkedStatus === "pending"
                  ? "生成中"
                  : linkedStatus === "completed"
                    ? "已生成"
                    : "";
              return (
                <button
                  type="button"
                  key={`${index}-${question}`}
                  className={`recommendation-button ${linkedStatus ? `is-${linkedStatus}` : ""}`}
                  onClick={(event) => onAskRecommended(question, event)}
                  title={linkedStatus === "completed" ? "已生成，点击查看对应图解" : undefined}
                >
                  <span className="recommendation-content">
                    <span className="recommendation-question">{question}</span>
                    {statusLabel && (
                      <small className={`recommendation-status ${linkedStatus}`}>
                        {statusLabel}
                      </small>
                    )}
                  </span>
                  {linkedStatus === "pending"
                    ? <Clock3 className="recommendation-state-icon" size={13} />
                    : linkedStatus === "failed"
                      ? <RefreshCw className="recommendation-state-icon" size={13} />
                      : <ArrowRight size={13} />}
                </button>
              );
            })}
          </div>
        </div>}
      </div>
      <button type="button" className="inspector-close" onClick={onClose} title="关闭">
        <X size={17} />
      </button>
    </aside>
  );
}

function MarkdownContent({
  className,
  nodeId,
  label,
  content,
  onPointerDown,
}) {
  return (
    <div
      className={className}
      data-node-id={nodeId}
      data-selection-label={label}
      onPointerDown={onPointerDown}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizeMarkdownContent(content)}
      </ReactMarkdown>
    </div>
  );
}

function FollowupDock({
  label,
  open,
  query,
  onOpen,
  onQueryChange,
  onCancel,
  onSubmit,
}) {
  const inputRef = useRef(null);
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);
  if (!open) {
    return (
      <button type="button" className="answer-followup-trigger" onClick={onOpen}>
        <Search size={14} />
        <span>继续追问</span>
      </button>
    );
  }
  return (
    <form
      className="answer-followup-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(event);
      }}
    >
      <Search size={15} />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onCancel();
        }}
        placeholder={`继续追问：${label}`}
      />
      <button type="button" className="answer-followup-cancel" onClick={onCancel} title="取消追问">
        <X size={15} />
      </button>
      <button type="submit" disabled={!query.trim()} title="继续下钻">
        <ArrowRight size={16} />
      </button>
    </form>
  );
}

function TextAnswerSkeleton({ question }) {
  return (
    <div className="text-answer-skeleton" role="status" aria-label={`正在生成文字答案：${question}`}>
      <div>
        <MessageCircle size={15} />
        <span>先整理直接答案</span>
      </div>
      <strong>{question}</strong>
      <i className="text-skeleton-line line-a" />
      <i className="text-skeleton-line line-b" />
      <i className="text-skeleton-line line-c" />
      <section>
        <i />
        <i />
        <i />
      </section>
    </div>
  );
}

function getQuestionVisual(question) {
  if (/晶圆|HBM|DRAM|芯片|半导体|服务器|产能/.test(question)) return { icon: "▦", motif: "chip", label: "产能正在重新排列" };
  if (/雨|云|水|海|河|天气|气候/.test(question)) return { icon: "◌", motif: "water", label: "水汽与环境" };
  if (/量子|粒子|原子|电子|光/.test(question)) return { icon: "✦", motif: "quantum", label: "微观关系" };
  if (/地球|太阳|月球|宇宙|星|季节/.test(question)) return { icon: "◎", motif: "space", label: "天体与轨道" };
  if (/神经|大脑|网络|算法|学习|模型/.test(question)) return { icon: "⌁", motif: "network", label: "连接与计算" };
  if (/历史|文艺|战争|时代|文明/.test(question)) return { icon: "◇", motif: "history", label: "事件与脉络" };
  return { icon: "✣", motif: "concept", label: "概念与结构" };
}

function SceneSkeleton({
  question,
  startedAt,
  estimatedMs,
  failed = false,
  failureMessage = "",
  onRetry,
}) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  const visual = getQuestionVisual(question);
  const rawProgress = elapsed / Math.max(estimatedMs, 1);
  const phase = rawProgress < .3 ? 0 : rawProgress < .7 ? 1 : rawProgress < 1.05 ? 2 : 3;
  const stage = [
    "信号正在浮现",
    "关系正在彼此靠近",
    "场景开始形成轮廓",
    "细节仍在暗处生长",
  ][phase];
  return (
    <div
      className={`scene-skeleton motif-${visual.motif} skeleton-phase-${phase} ${failed ? "is-failed" : ""}`}
      style={{ "--time-factor": Math.min(1.5, Math.max(.75, estimatedMs / 42_000)) }}
      role={failed ? "alert" : "status"}
      aria-label={failed ? `生成失败：${question}` : `正在生成：${question}`}
    >
      <div className="skeleton-atmosphere" />
      <div className="skeleton-floor" />
      <svg className="skeleton-draft" viewBox="0 0 760 370" aria-hidden="true">
        <defs>
          <linearGradient id="draft-face" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9de7dc" stopOpacity=".24" />
            <stop offset="1" stopColor="var(--accent-strong)" stopOpacity=".05" />
          </linearGradient>
          <filter id="draft-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g className="draft-horizon">
          <path d="M52 277 L380 116 L708 277 L380 354 Z" />
          <path d="M134 277 L380 156 L626 277 L380 330 Z" />
          <path d="M216 277 L380 196 L544 277 L380 307 Z" />
          <path d="M298 277 L380 236 L462 277 L380 284 Z" />
          <path d="M134 237 L462 76 M216 317 L544 156 M298 354 L626 196" />
          <path d="M626 237 L298 76 M544 317 L216 156 M462 354 L134 196" />
        </g>
        <g className="draft-object object-left">
          <path className="draft-face" d="M126 198 L218 153 L282 184 L190 230 Z" />
          <path d="M126 198 L126 270 L190 302 L190 230 Z" />
          <path d="M190 230 L282 184 L282 255 L190 302 Z" />
          <path d="M151 220 L190 240 L254 208 M151 245 L190 265 L254 233" />
        </g>
        <g className="draft-object object-center">
          <path className="draft-face" d="M304 143 L392 99 L474 140 L386 185 Z" />
          <path d="M304 143 L304 259 L386 301 L386 185 Z" />
          <path d="M386 185 L474 140 L474 256 L386 301 Z" />
          <path d="M330 163 L386 191 L448 160 M330 193 L386 221 L448 190 M330 223 L386 251 L448 220" />
          <path className="draft-energy" d="M386 118 L386 278" />
        </g>
        <g className="draft-object object-right">
          <path className="draft-face" d="M502 204 L570 170 L644 207 L576 241 Z" />
          <path d="M502 204 L502 267 L576 305 L576 241 Z" />
          <path d="M576 241 L644 207 L644 270 L576 305 Z" />
          <path d="M523 226 L576 253 L623 229 M523 250 L576 277 L623 253" />
        </g>
        <g className="draft-connections">
          <path d="M282 218 C313 202 329 199 353 207" />
          <path d="M421 211 C460 204 481 215 502 235" />
        </g>
      </svg>
      <div className="skeleton-copy">
        <strong>{visual.label}</strong>
        <span>{failed ? "场景生成未完成" : stage}</span>
      </div>
      {failed ? (
        <div className="skeleton-failure">
          <span>生成失败</span>
          <strong>{question}</strong>
          <p>{failureMessage}</p>
          {onRetry && (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onRetry();
              }}
            >
              <RefreshCw size={14} />重新生成
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function fallbackSceneSvg(diagram, palette) {
  const positions = [[110, 190], [285, 95], [475, 95], [650, 190], [475, 285], [285, 285]];
  const nodes = diagram.nodes.map((node, index) => {
    const [x, y] = positions[index] || positions[positions.length - 1];
    const color = palette[index % 3];
    return `<g class="scene-hotspot hotspot-${index}" data-label="${node.label}">
      <circle cx="${x}" cy="${y}" r="52" fill="${color}" opacity=".92"/>
      <text x="${x}" y="${y + 5}" text-anchor="middle" fill="#fff" font-size="14" font-weight="700">${node.label}</text>
    </g>`;
  }).join("");
  const links = diagram.links.map((link) => {
    const from = positions[link.from];
    const to = positions[link.to];
    if (!from || !to) return "";
    return `<path class="scene-flow-path" d="M${from[0]} ${from[1]} L${to[0]} ${to[1]}" fill="none" stroke="#fff" stroke-width="3" opacity=".55"/>`;
  }).join("");
  return `<svg viewBox="0 0 760 370" xmlns="http://www.w3.org/2000/svg">
    <rect width="760" height="370" fill="#172221"/>
    ${links}${nodes}
  </svg>`;
}

function cleanSceneDetail(detail, summary) {
  const cleaned = normalizeMarkdownContent(detail)
    .replace(/这是[“"「『].+?[”"」』]图解中的[“"「『].+?[”"」』][。；]?/g, "")
    .replace(/它与整幅场景共同说明[:：]?/g, "")
    .replace(/^结论[:：]\s*/g, "")
    .trim();
  return cleaned || normalizeMarkdownContent(summary);
}

function normalizeInspectorDetail(detail) {
  return normalizeMarkdownContent(detail);
}

// Defensive: claude / opencode may return [{question, reason}, ...] or
// other object shapes instead of plain strings. The inspector and
// recommendation UI always expect strings.
function normalizeQuestionsForInspector(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") {
      return entry.question || entry.text || entry.title || entry.label || JSON.stringify(entry);
    }
    return String(entry);
  });
}

function normalizeMarkdownLineBreaks(content) {
  const lines = String(content || "").split("\n");
  const normalized = [];
  let inFence = false;

  const isFence = (line) => /^\s*(```|~~~)/.test(line);
  const isStructuredLine = (line) => (
    /^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s?|(?:---+|___+|\*\*\*+)\s*$)/.test(line)
    || /^\s*\|.*\|\s*$/.test(line)
  );

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isFence(line)) {
      inFence = !inFence;
      normalized.push(line);
      continue;
    }
    if (inFence || !line.trim()) {
      normalized.push(line);
      continue;
    }

    let combined = line.trimEnd();
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1];
      if (!nextLine.trim() || isStructuredLine(combined) || isStructuredLine(nextLine)) break;
      combined += ` ${nextLine.trimStart()}`;
      index += 1;
    }
    normalized.push(combined);
  }

  return normalized.join("\n")
    .replace(/\*\*([\s\S]*?)\*\*/g, (match, text) => (
      `**${text.replace(/\s*\n+\s*/g, " ").trim()}**`
    ))
    .replace(/__([\s\S]*?)__/g, (match, text) => (
      `__${text.replace(/\s*\n+\s*/g, " ").trim()}__`
    ))
    .replace(/\[([^\]]*?)\]\(([^)\n]+)\)/g, (match, label, url) => (
      `[${label.replace(/\s*\n+\s*/g, " ").trim()}](${url})`
    ));
}

function normalizeMarkdownContent(content) {
  let value = String(content || "")
    .replace(/\u0000|\uFFFD/g, "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\uFF0A/g, "*")
    .replace(/\\\*\\\*/g, "**")
    .replace(/\r\n?/g, "\n")
    .replace(/\\+n/g, "\n")
    .trim();

  if (/^[\[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      const collectText = (item) => {
        if (typeof item === "string") return item;
        if (Array.isArray(item)) return item.map(collectText).filter(Boolean).join("\n\n");
        if (item && typeof item === "object") {
          return Object.values(item).map(collectText).filter(Boolean).join("\n\n");
        }
        return "";
      };
      value = collectText(parsed) || value;
    } catch {
      // Generated details occasionally contain partial JSON punctuation.
    }
  }

  return normalizeMarkdownLineBreaks(value
    .replace(/\*\*([^*\n]+?)([。！？；：，、])\*\*(?=\S)/g, "**$1**$2")
    .replace(/["']?\]\s*,\s*\[\s*["']?/g, "\n\n")
    .replace(/^\s*[\[\],]+\s*$/gm, "")
    .replace(/^\s*["'](?=\S)/gm, "")
    .replace(/(?<=\S)["']\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function disableUnsafeSvgRotations(root) {
  const svg = root?.querySelector("svg");
  if (!svg) return;

  svg.querySelectorAll(".scene-rotate").forEach((target) => {
    target.style.animation = "none";
  });

  svg.querySelectorAll('animateTransform[type="rotate"]').forEach((animation) => {
    const values = animation.getAttribute("values");
    const steps = values
      ? values.split(";").map((step) => step.trim()).filter(Boolean)
      : ["from", "to"].map((name) => animation.getAttribute(name)).filter(Boolean);
    const hasExplicitPivot = steps.length > 0 && steps.every((step) => (
      (step.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).length >= 3
    ));
    const hasUnsafeByOnly = Boolean(animation.getAttribute("by"))
      && !animation.getAttribute("from")
      && !animation.getAttribute("to")
      && !values;
    if (!hasExplicitPivot || hasUnsafeByOnly) animation.remove();
  });
}

function setSceneAnimationPlayback(root, playing) {
  const svg = root?.querySelector("svg");
  if (!svg) return;
  const canvas = root.closest(".infinite-canvas");
  const canvasIsMoving = ["is-panning", "is-zooming", "is-camera-moving"]
    .some((motionClass) => canvas?.classList.contains(motionClass));
  const shouldPlay = Boolean(playing && !canvasIsMoving);
  try {
    if (shouldPlay) svg.unpauseAnimations?.();
    else svg.pauseAnimations?.();
  } catch {
    // Some generated SVGs do not expose the SMIL timeline API.
  }
  root.getAnimations?.({ subtree: true }).forEach((animation) => {
    if (shouldPlay) animation.play();
    else animation.pause();
  });
}

function AnimatedExplainer({ topic, summary, questions, palette, visual, active, onInspect }) {
  const fallback = {
    type: "flow",
    center: topic,
    nodes: [
      { label: "开始", detail: "从这里开始理解整个场景。", questions: ["它是什么？", "为什么重要？", "从哪里开始观察？"] },
      { label: "变化", detail: "这里呈现了场景中最关键的变化。", questions: ["它为什么发生？", "哪些因素会影响？", "如何观察这个过程？"] },
      { label: "结果", detail: "这里展示变化最终带来的现象。", questions: ["结果如何形成？", "会持续多久？", "有哪些类似现象？"] },
      { label: "应用", detail: "这里连接场景与现实生活。", questions: ["它有什么用途？", "生活中哪里能看到？", "怎样进一步验证？"] },
    ],
    links: [
      { from: 0, to: 1, label: "推动" },
      { from: 1, to: 2, label: "产生" },
      { from: 2, to: 3, label: "影响" },
    ],
  };
  const diagram = visual?.nodes ? visual : fallback;
  const sceneRef = useRef(null);
  const sceneSvg = scopeSceneSvgStyles(
    removeSvgConnectionMarkers(diagram.sceneSvg || fallbackSceneSvg(diagram, palette)),
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      disableUnsafeSvgRotations(sceneRef.current);
      setSceneAnimationPlayback(sceneRef.current, active);
    });
    return () => cancelAnimationFrame(frame);
  }, [sceneSvg]);

  useEffect(() => {
    setSceneAnimationPlayback(sceneRef.current, active);
  }, [active]);

  const selectSceneElement = (event) => {
    const root = sceneRef.current;
    const svg = root?.querySelector("svg");
    if (!root || !svg) return;
    const target = event.target.closest(
      "[data-label], [aria-label], .scene-hotspot, g, path, rect, circle, ellipse, polygon, polyline, line, text, use, image",
    );
    if (!target || !svg.contains(target) || target === svg) {
      onInspect({ label: topic, detail: summary, questions });
    } else {
      const hotspot = target.closest(".scene-hotspot");
      const hotspotMatch = hotspot?.className?.baseVal?.match(/hotspot-(\d+)/);
      const node = hotspotMatch ? diagram.nodes[Number(hotspotMatch[1])] : null;
      const label = node?.label || target.closest("[data-label]")?.getAttribute("data-label");
      const matchedNode = node || diagram.nodes.find((item) => item.label === label);
      if (matchedNode) {
        onInspect({
          label: matchedNode.label,
          detail: cleanSceneDetail(matchedNode.detail, summary),
          questions: matchedNode.questions,
        });
      } else {
        onInspect({ label: topic, detail: summary, questions });
      }
    }
  };

  return (
    <section className="animated-explainer" onClick={selectSceneElement}>
      <SceneSvgMarkup
        ref={sceneRef}
        active={active}
        topic={topic}
        sceneSvg={sceneSvg}
      />
    </section>
  );
}

const SceneSvgMarkup = React.memo(React.forwardRef(function SceneSvgMarkup(
  { active, topic, sceneSvg },
  ref,
) {
  return (
    <div
      className={`generated-scene ${active ? "is-active" : "is-paused"}`}
      ref={ref}
      role="img"
      aria-label={`${topic} 交互图解`}
      dangerouslySetInnerHTML={{ __html: sceneSvg }}
    />
  );
}));

function removeSvgConnectionMarkers(svg) {
  return String(svg || "")
    .replace(/\smarker-(?:start|mid|end)\s*=\s*(["']).*?\1/gi, "")
    .replace(/\smarker\s*=\s*(["']).*?\1/gi, "")
    .replace(/marker-(?:start|mid|end)\s*:\s*url\([^)]*\)\s*;?/gi, "")
    .replace(/marker\s*:\s*url\([^)]*\)\s*;?/gi, "");
}

function TreeNode({
  node,
  activeId,
  activePath,
  children,
  expanded,
  draggedNodeId,
  dropTarget,
  canDrop,
  onDragStart,
  onDragEnd,
  onDropNode,
  onDropTargetChange,
  onDelete,
  onSelect,
  onToggle,
  readOnly = false,
}) {
  const descendants = children(node.id);
  const isExpanded = expanded.has(node.id);
  const dropAllowed = readOnly ? false : canDrop(node.id);
  const dropPosition = dropTarget?.id === node.id ? dropTarget.position : null;
  const status = node.textFailed && node.visualFailed
    ? "生成失败"
    : node.visualFailed
      ? "图解待重试"
      : node.textFailed
        ? "文字待重试"
    : node.regenerating
      ? "正在重新生成"
      : node.visualLoading && node.summary
        ? "阅读中 · 图解生成中"
        : node.textLoading || node.visualLoading
          ? "正在生成"
        : "";
  const completedLabel = node.depth === 0 ? "根问题" : `第 ${node.depth + 1} 层`;
  const visualDepth = Math.min(node.depth, 4);
  const showDepthBadge = node.depth >= 4;
  return (
    <div className="tree-node">
      <div
        className={`tree-row ${readOnly ? "is-read-only" : ""} ${activeId === node.id ? "active" : ""} ${activePath?.has(node.id) ? "is-active-path" : ""} ${node.textFailed || node.visualFailed ? "failed" : ""} ${node.textLoading || node.visualLoading || node.regenerating ? "pending" : ""} ${draggedNodeId === node.id ? "is-dragging" : ""} ${dropPosition ? `is-drop-${dropPosition}` : ""}`}
        data-node-id={node.id}
        style={{
          "--tree-indent": `${visualDepth * 9}px`,
          "--tree-accent": `var(--tree-depth-${node.depth % 5})`,
        }}
        onDragOver={(event) => {
          if (!dropAllowed) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
          const position = ratio < .28 ? "before" : ratio > .72 ? "after" : "inside";
          onDropTargetChange({ id: node.id, position });
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          onDropTargetChange((current) => current?.id === node.id ? null : current);
        }}
        onDrop={(event) => {
          if (!dropAllowed) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
          const position = ratio < .28 ? "before" : ratio > .72 ? "after" : "inside";
          onDropNode(node.id, position);
        }}
      >
        {!readOnly && (
          <button
            type="button"
            className="tree-drag-handle"
            draggable
            title="拖拽排序或调整关联"
            aria-label={`拖拽调整：${node.title}`}
            onDragStart={(event) => onDragStart(node.id, event)}
            onDragEnd={onDragEnd}
            onClick={(event) => event.stopPropagation()}
          >
            <GripVertical size={14} />
          </button>
        )}
        <button className="tree-toggle" onClick={() => onToggle(node.id)} disabled={!descendants.length}>
          {descendants.length ? (isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />) : <span className="leaf-dot" />}
        </button>
        <button className="tree-label" onClick={() => onSelect(node.id)}>
          <span className="tree-title-line">
            {showDepthBadge && <i className="tree-depth-badge" aria-hidden="true">L{node.depth + 1}</i>}
            <HoverFullTitle text={node.title} />
          </span>
          <small className={status ? "tree-status" : ""}>
            {status && <i aria-hidden="true" />}
            {status || completedLabel}
          </small>
        </button>
        {!readOnly && (
          <button
            type="button"
            className="tree-delete"
            title="删除节点"
            aria-label={`删除节点：${node.title}`}
            onClick={() => onDelete(node.id)}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {isExpanded && descendants.length > 0 && (
        <div className="tree-children">
          {descendants.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              activeId={activeId}
              activePath={activePath}
              children={children}
              expanded={expanded}
              draggedNodeId={draggedNodeId}
              dropTarget={dropTarget}
              canDrop={canDrop}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDropNode={onDropNode}
              onDropTargetChange={onDropTargetChange}
              onDelete={onDelete}
              onSelect={onSelect}
              onToggle={onToggle}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HoverFullTitle({ text, as: Tag = "span" }) {
  const textRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);

  const showTooltip = () => {
    const element = textRef.current;
    if (!element || element.scrollWidth <= element.clientWidth + 1) return;
    const rect = element.getBoundingClientRect();
    const maxWidth = Math.min(360, window.innerWidth - 24);
    let left = rect.right + 10;
    if (left + maxWidth > window.innerWidth - 12) {
      left = Math.max(12, rect.left - maxWidth - 10);
    }
    setTooltip({
      left,
      top: Math.min(window.innerHeight - 12, Math.max(12, rect.top + rect.height / 2)),
      maxWidth,
    });
  };

  useEffect(() => {
    if (!tooltip) return undefined;
    const close = () => setTooltip(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [tooltip]);

  return (
    <>
      <Tag
        ref={textRef}
        className="sidebar-truncated-title"
        title={text}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setTooltip(null)}
        onPointerEnter={showTooltip}
        onPointerLeave={() => setTooltip(null)}
        onFocus={showTooltip}
        onBlur={() => setTooltip(null)}
      >
        {text}
      </Tag>
      {tooltip && createPortal(
        <div
          className="sidebar-title-tooltip"
          role="tooltip"
          style={{ left: tooltip.left, top: tooltip.top, maxWidth: tooltip.maxWidth }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}

const rootElement = document.getElementById("root");
const appRoot = window.__SOLO_ROOT__ || createRoot(rootElement);
window.__SOLO_ROOT__ = appRoot;

class AppErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("[AppErrorBoundary]", error, info);
  }
  render() {
    if (this.state.error) {
      const err = this.state.error;
      return (
        <main className="boot-error">
          <strong>应用渲染崩溃了</strong>
          <span style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12 }}>
            {String(err && (err.stack || err.message || err))}
          </span>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </main>
      );
    }
    return this.props.children;
  }
}

// Catch async errors that React's render-time ErrorBoundary can't see.
function showFloatingError(label, detail) {
  try {
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;top:0;left:0;right:0;max-height:50vh;overflow:auto;background:#7a1f1f;color:#fff;padding:8px;z-index:99999;font-size:11px;white-space:pre-wrap;font-family:monospace;";
    pre.textContent = `${label}: ${detail}`;
    document.body.appendChild(pre);
  } catch { /* ignore */ }
}
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    showFloatingError("window.error", e.error?.stack || e.message || String(e));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    showFloatingError("unhandledrejection", r?.stack || r?.message || String(r));
  });
}

async function bootstrapApp() {
  try {
    const shareId = getShareIdFromLocation();
    const readOnly = /^[a-f0-9]{32}$/.test(shareId);
    const initialStore = readOnly
      ? await loadShareFromServer(shareId)
      : await loadStoreFromServer();
    if (readOnly) {
      const sharedTitle = initialStore.workspaces[0]?.title;
      if (sharedTitle) document.title = `${sharedTitle} - Solo Learning`;
    }
    appRoot.render(
      <AppErrorBoundary>
        <App initialStore={initialStore} readOnly={readOnly} shareId={shareId} />
      </AppErrorBoundary>,
    );
  } catch (error) {
    appRoot.render(
      <AppErrorBoundary>
        <main className="boot-error">
          <strong>无法加载画布数据</strong>
          <span>{error.message || "请确认本地服务已启动"}</span>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </main>
      </AppErrorBoundary>,
    );
  }
}

startAnimatedFavicon();
bootstrapApp();
