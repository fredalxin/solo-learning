import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { applyDocumentPlan, compactDocumentOutline, compareDocumentTitles, extractMarkdownArchive, parseDocumentOutline } from "../src/documentArchive.js";

const archive = zipSync({
  "book/readme.md": strToU8("![later](images/b.png)\n![first](images/a.png)"),
  "book/images/a.png": new Uint8Array([1]),
  "book/images/b.png": new Uint8Array([2]),
  "ignored.txt": strToU8("ignored"),
});
const result = extractMarkdownArchive(archive.buffer);
assert.deepEqual(result.images.map((image) => image.name), ["book/images/b.png", "book/images/a.png"]);
assert.match(result.text, /later/);
const outline = parseDocumentOutline("# 书名\n# 1. 第一章\n正文\n## 1.1 第一节\n细节\n### 1.1.1 小节\n更细\n# 2. 第二章\n结尾");
assert.deepEqual(outline.map(({ title, parent }) => ({ title, parent })), [
  { title: "1. 第一章", parent: -1 },
  { title: "1.1 第一节", parent: 0 },
  { title: "1.1.1 小节", parent: 1 },
  { title: "2. 第二章", parent: -1 },
]);
assert.match(outline[0].content, /1\.1 第一节/);
assert.deepEqual(parseDocumentOutline("# 书名\n# 一、前言\n## 1\\.1 为什么选择 Pi\n正文\n## 1\\.2 为什么用它理解 Agent\n正文").map(({ sourceId, parent }) => ({ sourceId, parent })), [
  { sourceId: "h1", parent: -1 },
  { sourceId: "1.1", parent: 0 },
  { sourceId: "1.2", parent: 0 },
]);
const detailed = compactDocumentOutline(outline, "detailed");
assert.deepEqual(detailed.map(({ title, parent }) => ({ title, parent })), [
  { title: "1. 第一章", parent: -1 },
  { title: "1.1 第一节", parent: 0 },
  { title: "1.1.1 小节", parent: 1 },
  { title: "2. 第二章", parent: -1 },
]);
const compact = compactDocumentOutline(parseDocumentOutline("# 书名\n# 1. 第一章\n## 1.1 A\n## 1.2 B\n## 1.3 C\n## 1.4 D\n# 2. 第二章"));
assert.deepEqual(compact.map(({ title, parent }) => ({ title, parent })), [
  { title: "1. 第一章", parent: -1 },
  { title: "1.1–1.2：A、B", parent: 0 },
  { title: "1.3–1.4：C、D", parent: 0 },
  { title: "2. 第二章", parent: -1 },
]);
const plannedSource = parseDocumentOutline("# 书名\n# 1. 第一章\n## 1.1 第一节\n内容\n## 1.2 第二节\n内容\n# 2. 第二章");
const planned = applyDocumentPlan(plannedSource, [
  { title: "第一部分", sources: ["1"], level: "main", parent: -1 },
  { title: "第一节", sources: ["1.1"], level: "detail", parent: 0 },
  { title: "越级小节", sources: ["1.2"], level: "detail", parent: 1 },
  { title: "第二部分", sources: ["2"], level: "main", parent: 0 },
]);
assert.deepEqual(planned.map(({ title, parent }) => ({ title, parent })), [
  { title: "第一部分", parent: -1 },
  { title: "第一节", parent: 0 },
  { title: "越级小节", parent: -1 },
  { title: "第二部分", parent: -1 },
]);
assert.ok(planned.every((item) => item.parent < 0 || planned[item.parent]?.parent === -1));
assert.throws(() => applyDocumentPlan(plannedSource, [
  { title: "跨章合并", sources: ["1", "2"], level: "main", parent: -1 },
], true), /不能跨原著一级章节合并/);
assert.deepEqual(applyDocumentPlan(plannedSource, [
  { title: "第一章", sources: ["1", "1.1", "1.2"], level: "main", parent: -1 },
  { title: "吸收到总览", sources: ["2"], level: "overview", parent: -1 },
], true).map(({ title, parent }) => ({ title, parent })), [
  { title: "第一章", parent: -1 },
]);
assert.deepEqual([
  { sourceTitle: "10. 第十章" },
  { sourceTitle: "9. 第九章" },
].sort(compareDocumentTitles).map((item) => item.sourceTitle), ["9. 第九章", "10. 第十章"]);
console.log("document archive check passed");
