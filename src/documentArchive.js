import { strFromU8, unzipSync } from "fflate";

export const MAX_DOCUMENT_IMAGES = 16;
const DOCUMENT_TITLE_COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function compareDocumentTitles(a, b) {
  return DOCUMENT_TITLE_COLLATOR.compare(a?.sourceTitle || a?.title || "", b?.sourceTitle || b?.title || "");
}

function cleanHeading(value) {
  return value
    .replace(/\\([.()#[\]_*])/g, "$1")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

function headingNumber(value) {
  return value.match(/^(\d+(?:\.\d+)*)(?=\s|[.、．)）])/u)?.[1] || "";
}

export function parseDocumentOutline(text) {
  const source = String(text || "");
  const markdownHeadings = [...source.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({
    start: match.index,
    contentStart: match.index + match[0].length,
    markdownLevel: match[1].length,
    title: cleanHeading(match[2]),
  }));
  const headings = markdownHeadings.length > 1
    ? markdownHeadings
    : [...source.matchAll(/^(\d+(?:\.\d+)*)[.、．)）]?\s+(.{2,100})$/gm)].map((match) => ({
        start: match.index,
        contentStart: match.index + match[0].length,
        markdownLevel: 1,
        title: cleanHeading(`${match[1]} ${match[2]}`),
      }));
  if (!headings.length) return [];
  const firstIsTitle = !headingNumber(headings[0].title);
  const candidates = headings.slice(firstIsTitle ? 1 : 0);
  const outline = [];
  const numbered = new Map();
  candidates.forEach((heading) => {
    const number = headingNumber(heading.title);
    const markdownParent = () => {
      for (let index = outline.length - 1; index >= 0; index -= 1) {
        if (outline[index].markdownLevel < heading.markdownLevel) return index;
      }
      return -1;
    };
    let parent = -1;
    if (number.includes(".")) parent = numbered.get(number.slice(0, number.lastIndexOf("."))) ?? markdownParent();
    if (!number) parent = markdownParent();
    const index = outline.length;
    outline.push({ ...heading, number, parent });
    if (number) numbered.set(number, index);
  });
  const isDescendant = (index, ancestor) => {
    let parent = outline[index]?.parent ?? -1;
    while (parent >= 0) {
      if (parent === ancestor) return true;
      parent = outline[parent]?.parent ?? -1;
    }
    return false;
  };
  return outline.map((heading, index) => {
    let end = source.length;
    for (let next = index + 1; next < outline.length; next += 1) {
      if (!isDescendant(next, index)) {
        end = outline[next].start;
        break;
      }
    }
    const ownEnd = outline[index + 1]?.start ?? source.length;
    const ownContent = source.slice(heading.contentStart, ownEnd).trim();
    const content = source.slice(heading.contentStart, end).trim();
    return {
      title: heading.title.slice(0, 120),
      number: heading.number,
      sourceId: heading.number || `h${index + 1}`,
      scope: heading.title.slice(0, 300),
      parent: heading.parent,
      ownContent: ownContent.slice(0, 100_000),
      content: content.slice(0, 100_000),
      ownImageNames: referencedImages(ownContent, ""),
      imageNames: referencedImages(content, ""),
    };
  });
}

export function compactDocumentOutline(outline, mode = "concise") {
  if (mode === "detailed") {
    const included = new Set();
    outline.forEach((item, index) => {
      let ancestor = index;
      while (outline[ancestor]?.parent >= 0) ancestor = outline[ancestor].parent;
      if (/^\d+$/.test(outline[ancestor]?.number || "")) included.add(index);
    });
    const remapped = new Map();
    return outline.flatMap((item, index) => {
      if (!included.has(index)) return [];
      const nextIndex = remapped.size;
      remapped.set(index, nextIndex);
      return [{ ...item, sourceTitle: item.title, parent: item.parent < 0 ? -1 : remapped.get(item.parent) ?? -1 }];
    });
  }
  const result = [];
  outline.forEach((chapter, chapterIndex) => {
    if (chapter.parent !== -1 || !/^\d+$/.test(chapter.number || "")) return;
    const chapterResultIndex = result.length;
    result.push({ ...chapter, parent: -1, sourceTitle: chapter.title });
    const sections = outline.filter((item) => item.parent === chapterIndex);
    const groupCount = Math.ceil(sections.length * 0.3);
    for (let group = 0; group < groupCount; group += 1) {
      const start = Math.floor(group * sections.length / groupCount);
      const end = Math.floor((group + 1) * sections.length / groupCount);
      const items = sections.slice(start, end);
      if (!items.length) continue;
      const title = items.length === 1
        ? items[0].title
        : `${items[0].number}–${items.at(-1).number}：${items.map((item) => item.title.replace(/^\d+(?:\.\d+)*[.、．)）]?\s*/, "")).join("、")}`;
      result.push({
        title: title.slice(0, 120),
        sourceTitle: title.slice(0, 120),
        number: items[0].number,
        scope: items.map((item) => item.title).join("；").slice(0, 300),
        parent: chapterResultIndex,
        content: items.map((item) => `## ${item.title}\n\n${item.content}`).join("\n\n"),
        imageNames: [...new Set(items.flatMap((item) => item.imageNames || []))],
      });
    }
  });
  return result;
}

export function applyDocumentPlan(outline, plan, strict = false) {
  const byId = new Map(outline.map((item, index) => [item.sourceId || item.number || `h${index + 1}`, { item, index }]));
  const chapterOf = (index) => {
    while (outline[index]?.parent >= 0) index = outline[index].parent;
    return index;
  };
  const used = new Set();
  const planIndexes = new Map();
  const result = [];
  (Array.isArray(plan) ? plan : []).slice(0, 19).forEach((entry, planIndex) => {
    const sources = [...new Set(Array.isArray(entry?.sources) ? entry.sources : [])]
      .flatMap((sourceId) => {
        const normalizedId = String(sourceId);
        const source = byId.get(normalizedId);
        if (strict && (!source || used.has(normalizedId))) throw new Error("教学结构存在无效或重复的章节来源");
        if (!source || used.has(normalizedId)) return [];
        used.add(normalizedId);
        return [source];
      });
    if (!sources.length) return;
    const chapters = new Set(sources.map(({ index }) => chapterOf(index)));
    if (strict && chapters.size > 1) throw new Error("精简模式不能跨原著一级章节合并");
    const resultIndex = result.length;
    const level = ["main", "detail", "appendix", "overview"].includes(entry.level)
      ? entry.level
      : Number.isInteger(entry.parent) && entry.parent >= 0 ? "detail" : "main";
    const requestedParent = level === "detail" && Number.isInteger(entry.parent) && entry.parent >= 0
      ? planIndexes.get(entry.parent) ?? -1
      : -1;
    if (strict && ((level === "detail" && requestedParent < 0) || (level !== "detail" && entry.parent !== -1))) {
      throw new Error("教学结构存在无效的父子层级");
    }
    if (level === "overview") {
      planIndexes.set(planIndex, -1);
      return;
    }
    planIndexes.set(planIndex, resultIndex);
    const parent = requestedParent >= 0 && result[requestedParent]?.parent === -1
      ? requestedParent
      : -1;
    if (strict && level === "detail" && (parent < 0 || result[parent]?.chapterIndex !== [...chapters][0])) {
      throw new Error("二级卡片必须归属于同一原著一级章节");
    }
    const title = String(entry.title || sources[0].item.title).trim().slice(0, 120);
    result.push({
      title,
      sourceTitle: title,
      number: sources[0].item.number,
      scope: sources.map(({ item }) => item.title).join("；").slice(0, 300),
      parent,
      chapterIndex: [...chapters][0],
      sourceIndexes: sources.map(({ index }) => index),
      content: sources.map(({ item }) => `## ${item.title}\n\n${item.ownContent || ""}`).join("\n\n"),
      imageNames: [...new Set(sources.flatMap(({ item }) => item.ownImageNames || []))],
    });
  });
  if (strict && used.size !== outline.length) throw new Error("教学结构没有完整覆盖原文章节");
  if (!result.length) return strict ? [] : compactDocumentOutline(outline, "detailed").filter((item) => item.parent === -1);
  outline.forEach((item, index) => {
    const sourceId = item.sourceId || item.number || `h${index + 1}`;
    if (used.has(sourceId)) return;
    const target = result.reduce((best, candidate, candidateIndex) => {
      const distance = Math.min(...candidate.sourceIndexes.map((sourceIndex) => Math.abs(sourceIndex - index)));
      return !best || distance < best.distance ? { candidate, candidateIndex, distance } : best;
    }, null)?.candidate;
    if (!target) return;
    target.content += `\n\n## ${item.title}\n\n${item.ownContent || ""}`;
    target.scope = `${target.scope}；${item.title}`.slice(0, 300);
    target.imageNames = [...new Set([...target.imageNames, ...(item.ownImageNames || [])])];
  });
  return result.map(({ sourceIndexes, chapterIndex, ...item }) => item);
}

const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function extension(name) {
  return name.toLowerCase().match(/\.[^.\/]+$/)?.[0] || "";
}

function normalizePath(name) {
  const parts = [];
  for (const part of name.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function referencedImages(markdown, markdownName) {
  const directory = markdownName.includes("/") ? markdownName.slice(0, markdownName.lastIndexOf("/") + 1) : "";
  return [...markdown.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)].map((match) => {
    const raw = (match[1] || match[2]).split(/[?#]/, 1)[0];
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep malformed path for matching */ }
    return normalizePath(decoded.startsWith("/") ? decoded : `${directory}${decoded}`);
  });
}

export function extractMarkdownArchive(data) {
  if (data.byteLength > 80 * 1024 * 1024) throw new Error("ZIP 不能超过 80MB");
  let expandedSize = 0;
  const entries = unzipSync(new Uint8Array(data), {
    filter(entry) {
      if (entry.name.length > 500) throw new Error("ZIP 内文件路径过长");
      const ext = extension(entry.name);
      if (ext !== ".md" && ext !== ".markdown" && !MIME_TYPES[ext]) return false;
      if ((ext === ".md" || ext === ".markdown") && entry.originalSize > 2 * 1024 * 1024) {
        throw new Error("ZIP 内单个 Markdown 不能超过 2MB");
      }
      if (MIME_TYPES[ext] && entry.originalSize > 12 * 1024 * 1024) {
        throw new Error("ZIP 内单张图片不能超过 12MB");
      }
      expandedSize += entry.originalSize;
      if (expandedSize > 100 * 1024 * 1024) throw new Error("ZIP 解压后不能超过 100MB");
      return true;
    },
  });
  const markdownEntries = Object.entries(entries).filter(([name]) => [".md", ".markdown"].includes(extension(name)));
  if (!markdownEntries.length) throw new Error("ZIP 中没有找到 Markdown 文件");

  const markdowns = markdownEntries.map(([name, bytes]) => ({ name: normalizePath(name), text: strFromU8(bytes) }));
  const images = Object.entries(entries)
    .filter(([name]) => MIME_TYPES[extension(name)])
    .map(([name, bytes]) => ({ name: normalizePath(name), type: MIME_TYPES[extension(name)], bytes }));
  const order = markdowns.flatMap(({ name, text }) => referencedImages(text, name));
  images.sort((a, b) => {
    const aIndex = order.indexOf(a.name);
    const bIndex = order.indexOf(b.name);
    return (aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex);
  });
  return {
    text: markdowns.length === 1
      ? markdowns[0].text
      : markdowns.map(({ name, text }) => `# 来源：${name}\n\n${text}`).join("\n\n"),
    images: images.slice(0, MAX_DOCUMENT_IMAGES),
    outline: parseDocumentOutline(markdowns.length === 1
      ? markdowns[0].text
      : markdowns.map(({ name, text }) => `# 来源：${name}\n\n${text}`).join("\n\n")),
  };
}
