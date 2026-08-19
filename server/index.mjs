import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, SUPPORTED_AGENTS } from "./agent/index.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const schemaPath = join(root, "server", "lesson.schema.json");
const quickAnswerSchemaPath = join(root, "server", "quick-answer.schema.json");
const dataDir = join(root, "server", "data");
const usersDir = join(dataDir, "users");

/**
 * Try to extract a JSON object from raw agent output. Agents (esp. claude /
 * opencode) sometimes wrap their JSON in markdown ```json ... ``` fences
 * even when the prompt forbids it. We try four strategies and return the
 * first that yields a parsed object. Returns null when nothing parses.
 *
 * @param {string} raw
 * @returns {unknown | null}
 */
function extractJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();

  // 1) Direct parse — works for codex (no fences) and clean claude/opencode.
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }

  // 2) Strip a single leading ```json (or ```) fence.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]+?)\s*```\s*$/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* fall through */ }
  }

  // 3) Slice from the first { to the last } — handles stray prose around the JSON.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch { /* fall through */ }
  }

  return null;
}
const sharesDir = join(dataDir, "shares");
const legacyStorePath = join(dataDir, "app-store.json");
const legacyTasksPath = join(dataDir, "lesson-tasks.json");
const legacyOwnerPath = join(dataDir, "legacy-owner.txt");
const port = Number(process.env.ATLAS_API_PORT || 8787);
const userStates = new Map();
let persistenceQueue = Promise.resolve();

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function readBody(request, maxBytes = 2_000_000) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("请求内容过大"));
        request.destroy();
      }
    });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function queueJsonWrite(path, value) {
  persistenceQueue = persistenceQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, JSON.stringify(value), "utf8");
      await rename(tempPath, path);
    });
  return persistenceQueue;
}

function normalizeAppStore(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.workspaces)) {
    throw new Error("画布数据格式无效");
  }
  const workspaces = value.workspaces.slice(0, 500).map(stripWorkspaceExecutionData);
  const currentId = typeof value.currentId === "string" && workspaces.some((item) => item?.id === value.currentId)
    ? value.currentId
    : workspaces[0]?.id || null;
  const generationEstimateMs = Number(value.generationEstimateMs);
  return {
    version: 1,
    workspaces,
    currentId,
    generationEstimateMs: Number.isFinite(generationEstimateMs)
      ? Math.min(300_000, Math.max(12_000, generationEstimateMs))
      : 42_000,
    updatedAt: new Date().toISOString(),
  };
}

function stripWorkspaceExecutionData(workspace) {
  if (!workspace || typeof workspace !== "object") return workspace;
  return {
    ...workspace,
    nodes: Array.isArray(workspace.nodes)
      ? workspace.nodes.map((node) => {
          if (!node || typeof node !== "object") return node;
          const {
            codexEvents,
            codexThreadId,
            codexUsage,
            codexLastEventAt,
            ...cleanNode
          } = node;
          return cleanNode;
        })
      : workspace.nodes,
  };
}

function createShareSnapshot(workspace) {
  const cleanWorkspace = stripWorkspaceExecutionData(workspace);
  if (!cleanWorkspace || typeof cleanWorkspace !== "object" || !Array.isArray(cleanWorkspace.nodes)) {
    throw new Error("分享画布格式无效");
  }
  return {
    ...cleanWorkspace,
    nodes: cleanWorkspace.nodes.slice(0, 1000).map((node) => {
      if (!node || typeof node !== "object") return node;
      const {
        textTaskId,
        visualTaskId,
        taskId,
        preserveViewportAnchorId,
        textAgentStage,
        textAgentStageLabel,
        textAgentStageStartedAt,
        textAgentStageHistory,
        visualAgentStage,
        visualAgentStageLabel,
        visualAgentStageStartedAt,
        visualAgentStageHistory,
        ...sharedNode
      } = node;
      return {
        ...sharedNode,
        loading: false,
        regenerating: false,
        textLoading: false,
        visualLoading: false,
        textFailed: !sharedNode.summary,
        visualFailed: !sharedNode.visual,
      };
    }),
    sharedAt: new Date().toISOString(),
  };
}

function getUserId(request) {
  const userId = String(request.headers["x-fast-learning-user-id"] || "").trim();
  if (!/^user-[a-zA-Z0-9_-]{16,120}$/.test(userId)) {
    throw new Error("缺少有效的用户标识");
  }
  return userId;
}

function getUserPaths(userId) {
  const userDir = join(usersDir, userId);
  return {
    userDir,
    storePath: join(userDir, "app-store.json"),
    tasksPath: join(userDir, "lesson-tasks.json"),
  };
}

function serializeTasks(state) {
  return [...state.lessonTasks.values()].map((task) => ({
    id: task.id,
    status: task.status,
    stage: task.stage,
    stageLabel: task.stageLabel,
    stageStartedAt: task.stageStartedAt,
    stageHistory: task.stageHistory,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    result: task.result,
    error: task.error,
  }));
}

async function persistTasks(state) {
  await queueJsonWrite(state.tasksPath, serializeTasks(state));
}

async function claimLegacyData(userId) {
  let owner = "";
  try {
    await writeFile(legacyOwnerPath, userId, { encoding: "utf8", flag: "wx" });
    owner = userId;
  } catch {
    owner = String(await readFile(legacyOwnerPath, "utf8").catch(() => "")).trim();
  }
  if (owner !== userId) return { appStore: null, tasks: [] };
  return {
    appStore: await readJsonFile(legacyStorePath, null),
    tasks: await readJsonFile(legacyTasksPath, []),
  };
}

async function initializeUserState(userId) {
  if (userStates.has(userId)) return userStates.get(userId);
  const paths = getUserPaths(userId);
  await mkdir(paths.userDir, { recursive: true });
  let appStore = await readJsonFile(paths.storePath, null);
  let storedTasks = await readJsonFile(paths.tasksPath, null);
  let migratedLegacyData = false;
  if (!appStore && !Array.isArray(storedTasks)) {
    const legacy = await claimLegacyData(userId);
    appStore = legacy.appStore;
    storedTasks = legacy.tasks;
    migratedLegacyData = Boolean(appStore || storedTasks.length);
  }
  if (!Array.isArray(storedTasks)) storedTasks = [];
  if (appStore?.workspaces) {
    appStore = {
      ...appStore,
      workspaces: appStore.workspaces.map(stripWorkspaceExecutionData),
    };
  }
  const state = {
    userId,
    appStore,
    lessonTasks: new Map(),
    ...paths,
  };
  if (Array.isArray(storedTasks)) {
    storedTasks.forEach((task) => {
      if (!task?.id) return;
      const {
        codexEvents,
        codexThreadId,
        codexUsage,
        ...storedTask
      } = task;
      state.lessonTasks.set(task.id, {
        ...storedTask,
        status: task.status === "pending" ? "failed" : task.status,
        stage: task.status === "pending" ? "failed" : task.stage,
        stageLabel: task.status === "pending"
          ? "服务重启中断了 Agent 任务"
          : task.stageLabel || "",
        stageStartedAt: task.status === "pending" ? Date.now() : task.stageStartedAt,
        error: task.status === "pending"
          ? "服务重启中断了生成任务，请重新生成"
          : task.error || "",
        updatedAt: task.status === "pending" ? Date.now() : task.updatedAt,
      });
    });
  }
  userStates.set(userId, state);
  if (state.appStore) await queueJsonWrite(state.storePath, state.appStore);
  if (storedTasks.length || migratedLegacyData) {
    await persistTasks(state);
  }
  return state;
}

function parseLessonInput(body) {
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const context = typeof body.context === "string" ? body.context.trim() : "";
  const learningHistory = typeof body.learningHistory === "string"
    ? body.learningHistory.trim().slice(0, 3000)
    : "";
  const revision = typeof body.revision === "string" ? body.revision.trim().slice(0, 500) : "";
  const visualConfig = body.visualConfig && typeof body.visualConfig === "object"
    ? Object.fromEntries(
        Object.entries(body.visualConfig)
          .slice(0, 4)
          .map(([key, value]) => [String(key).slice(0, 30), String(value).trim().slice(0, 60)]),
      )
    : {};
  const existingLesson = body.existingLesson && typeof body.existingLesson === "object"
    ? body.existingLesson
    : null;
  const answerMode = body.answerMode === "quick" ? "quick" : "visual";
  const requestedAgent = typeof body.agent === "string" ? body.agent.trim().toLowerCase() : "";
  const agent = SUPPORTED_AGENTS.includes(requestedAgent) ? requestedAgent : "claude";
  if (!question || question.length > 500) {
    throw new Error("问题不能为空，且不能超过 500 个字符");
  }
  return { question, context, learningHistory, revision, visualConfig, existingLesson, answerMode, agent };
}

function startLessonTask(state, taskId, input) {
  const existing = state.lessonTasks.get(taskId);
  if (existing) return existing;
  const createdAt = Date.now();
  const task = {
    id: taskId,
    status: "pending",
    stage: "queued",
    stageLabel: "等待 Agent 接收任务",
    stageStartedAt: createdAt,
    stageHistory: [{
      stage: "queued",
      label: "等待 Agent 接收任务",
      startedAt: createdAt,
      endedAt: null,
    }],
    createdAt,
    updatedAt: createdAt,
    result: null,
    error: "",
  };
  state.lessonTasks.set(taskId, task);
  void persistTasks(state);
  const setStage = (stage, stageLabel) => {
    const now = Date.now();
    const currentStage = task.stageHistory.at(-1);
    if (currentStage && !currentStage.endedAt) currentStage.endedAt = now;
    task.stageHistory.push({
      stage,
      label: stageLabel,
      startedAt: now,
      endedAt: null,
    });
    Object.assign(task, {
      stage,
      stageLabel,
      stageStartedAt: now,
      updatedAt: now,
    });
  };
  const updateStage = (stage, stageLabel) => {
    setStage(stage, stageLabel);
    void persistTasks(state);
  };
  const generator = input.answerMode === "quick"
    ? generateQuickAnswer(
        input.question,
        input.context,
        input.learningHistory,
        input.revision,
        input.agent,
        updateStage,
      )
    : generateLesson(
        input.question,
        input.context,
        input.revision,
        input.existingLesson,
        input.learningHistory,
        input.visualConfig,
        input.agent,
        updateStage,
      );
  generator
    .then((result) => {
      setStage("completed", input.answerMode === "quick" ? "快答已经准备完成" : "图解已经准备完成");
      Object.assign(task, {
        status: "completed",
        result,
        updatedAt: Date.now(),
      });
      void persistTasks(state);
    })
    .catch((error) => {
      console.error("[atlas-agent]", error);
      setStage("failed", "Agent 执行失败");
      Object.assign(task, {
        status: "failed",
        error: error.message || "Agent 生成失败",
        updatedAt: Date.now(),
      });
      void persistTasks(state);
    });
  return task;
}

function taskResponse(task) {
  const now = Date.now();
  return {
    id: task.id,
    status: task.status,
    stage: task.stage || (task.status === "pending" ? "queued" : task.status),
    stageLabel: task.stageLabel || (task.status === "pending" ? "等待 Agent 接收任务" : ""),
    stageStartedAt: task.stageStartedAt || task.updatedAt || task.createdAt,
    stageHistory: task.stageHistory || [],
    elapsedMs: Math.max(0, now - task.createdAt),
    stageElapsedMs: Math.max(0, now - (task.stageStartedAt || task.updatedAt || task.createdAt)),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.status === "completed" ? { result: task.result } : {}),
    ...(task.status === "failed" ? { error: task.error } : {}),
  };
}

async function generateQuickAnswer(
  question,
  context = "",
  learningHistory = "",
  revision = "",
  agent = "codex",
  onStage = () => {},
) {
  onStage("preparing", "整理问题并提取直接答案");
  const tempDir = await mkdtemp(join(tmpdir(), "atlas-quick-agent-"));
  const outputPath = join(tempDir, "answer.json");
  const prompt = `你是 Fast Learning 的快问快答 Agent。请直接、准确、通俗地回答用户的问题，不生成 SVG；使用清晰但克制的 Markdown 组织一篇可独立阅读的解释。

用户问题：${question}
${context ? `相关上下文：${context}` : ""}
${learningHistory ? `用户此前的学习路径与提问习惯（只用于生成推荐追问）：
${learningHistory}` : ""}
${revision ? `用户对当前答案的修正要求：${revision}` : ""}

生成要求：
1. 默认用户刚接触这个领域。先直接回答，再用白话补充最关键的解释，不要假设用户掌握专业背景。
2. summary 使用约 480-700 个中文字符，分成 4-6 个短段落，让用户在等待图解生成时能够先完成一轮较充分的理解：
   - 第一段直接回答用户的问题，先给明确结论。
   - 随后拆解最关键的原因、机制或组成关系，讲清楚中间的因果链，让用户不仅知道“是什么”，也知道“为什么会这样”。
   - 补充一个贴近现实的例子、使用场景或可观察现象，帮助初学者建立具体认识。
   - 说明至少一个重要成立条件、限制、常见误解或例外，避免给出过度绝对的结论。
   - 若问题涉及多个对象、方案或阶段，补充简短对比，指出它们各自承担的作用以及为什么不能简单互换。
   - 不写与问题无关的历史背景、行业铺垫或泛泛价值判断，避免“这个问题很重要”“简单来说”等空话。
   - 使用简洁 Markdown 排版：关键结论或术语可用 **加粗**；存在并列步骤、条件或对比时可使用短列表。不要使用一级标题、表格、代码块或复杂嵌套列表。
3. 首次出现专业术语时，用一句短解释说明它是什么、在当前问题中承担什么作用。内容应完整但保持易读。
4. facts 正好 3 项，每项是“短标签 + 具体说明”。每项说明约 60-110 个中文字符，应能独立阅读，并分别补充核心定义、关键机制/特征、边界/影响或实际意义，不能只是正文原句的缩写。
5. children 正好 3 项。结合用户的学习路径，推荐具体、互补、不重复的下一步问题；问题可以继续快答，也可以适合生成图解。
6. title 简洁概括答案主题，kicker 使用 2-6 个中文字符表示答案类型。
7. answerMode 必须为 "quick"。
8. 只返回符合 JSON Schema 的 JSON，不要输出其他内容。`;

  const agentLabel = SUPPORTED_AGENTS.includes(agent) ? agent : "codex";
  const isCodex = agentLabel === "codex";

  try {
    onStage("running", `${agentLabel} Agent 正在组织快答`);
    const raw = await runAgent(agentLabel, prompt, {
      cwd: root,
      timeoutMs: 120_000,
      // Codex-only: these two are required for --output-schema / --output-last-message.
      // Claude / opencode ignore them — schema lives inside the prompt instead.
      ...(isCodex
        ? { schemaPath: quickAnswerSchemaPath, outputPath }
        : {}),
    });

    onStage("validating", "校验答案与推荐问题");
    const answer = extractJson(raw);
    if (answer === null || typeof answer !== "object") {
      throw new Error(
        `${agentLabel} 输出不是合法 JSON: ${raw.slice(0, 400)}`,
      );
    }
    onStage("finalizing", "写入知识画布");
    return answer;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function generateLesson(
  question,
  context,
  revision = "",
  existingLesson = null,
  learningHistory = "",
  visualConfig = {},
  agent = "codex",
  onStage = () => {},
) {
  onStage("preparing", "整理问题、上下文与视觉要求");
  const tempDir = await mkdtemp(join(tmpdir(), "atlas-agent-"));
  const outputPath = join(tempDir, "lesson.json");
  const prompt = `你是 Atlas 的视觉课程生成 Agent。请把用户的问题转化为准确、易懂、可继续探索的中文微型课程。

用户问题：${question}
${context ? `相关上下文：${context}` : ""}
${learningHistory ? `用户此前的学习路径与提问习惯（只用于生成推荐追问，不得影响本轮正文结论和视觉构图）：
${learningHistory}` : ""}
${Object.keys(visualConfig).length ? `当前画布统一视觉配置：
- 空间表现：${visualConfig.space || "自动选择"}
- 视觉风格：${visualConfig.style || "自动选择"}
- 色调：${visualConfig.tone || "跟随内容"}
- 领域：${visualConfig.domain || "自动识别"}
标记为“自动选择”“跟随内容”或“自动识别”的项目不是固定风格，必须根据本轮问题重新判断。只有用户明确选择的非自动项目才是高优先级约束。` : ""}
${revision ? `用户对当前 SVG 的修正要求：${revision}` : ""}
${revision && existingLesson ? `当前图解信息（仅用于识别需要修正的内容）：
${JSON.stringify(existingLesson)}` : ""}

生成要求：
0. 默认用户是第一次接触这个领域的初学者。所有内容都应尽可能通俗、直观、容易理解：
   - 不假设用户已经掌握专业背景。首次出现专业术语时，用简短白话解释它是什么，以及它在当前问题中有什么作用。
   - 先讲用户能直接理解的结论和现象，再逐步进入原因、结构与机制，避免突然跨越多个知识层级。
   - 优先使用具体对象、日常类比、因果关系和可观察的过程来解释抽象概念，但类比必须准确，并说明类比不能覆盖的关键差异。
   - 句子尽量简洁，减少术语堆叠、缩写堆叠和教科书式表述。无法避免缩写时，同时给出中文含义。
   - SVG 应让初学者无需先读大量文字也能看懂主要对象、变化方向和因果结果；标签使用易懂的中文，必要术语旁增加白话说明。
   - 通俗不等于省略关键机制或降低事实准确性。应将复杂内容拆成容易跟随的小步骤，而不是只给模糊比喻或表面结论。
1. 用户本轮问题是唯一主要任务，必须把它当作一个可独立成立的专题进行深入回答。
   - 相关上下文只用于消除代词、术语或指代歧义。若本轮问题本身已经清楚，应忽略父级内容，不得沿用父级的结论、结构、叙事顺序或视觉构图。
   - 子问题不能停留在定义或概览。需要继续下钻到关键原因、内部机制、组成结构、作用路径、成立条件、限制因素、例外情况和最终结果；选择其中与本轮问题最相关的部分详细剖析。
   - title、summary、facts、steps、children、visual.nodes、visual.links 和 sceneSvg 都必须围绕本轮问题从零组织。不得复用父主题的通用介绍，不得把子问题回答成父主题摘要，也不得花篇幅复述父级知识。
   - 父主题和被点击对象最多作为必要的定位信息出现，不能成为标题、视觉中心或主要结论，除非本轮问题明确要求比较或回到父主题。
   - sceneSvg 的主体必须是本轮追问的局部对象、内部结构、具体机制或因果链。优先使用剖面、拆解、局部放大、过程分层和状态变化，让用户看到“里面是什么、怎么作用、为什么发生、受什么限制”。
   - 询问“为什么”时，详细展示多层原因如何共同作用并产生结果；询问“如何”时，展示关键步骤、状态变化与反馈；询问“区别”时，使用同尺度直接对比并解释差异来源；询问某个部件时，展示结构、接口、工作过程和上下游影响。
   - children 应继续沿本轮子问题向更深层追问，不能退回父主题的宽泛分支。
2. 内容应先给结论，再解释关键原因或过程。避免空话、重复和与问题无关的背景知识。
   - summary 是点击整幅 SVG 后看到的直接回答，不能只写一句概括。用约 180-300 个中文字符分成 2-3 个短段落：第一段正面回答用户的问题；后续说明最关键的运行机制、因果链、成立条件、限制或现实影响。
   - summary 必须能够脱离 SVG 单独阅读，不使用“如图所示”“这张图展示了”等依赖画面的空泛表述，也不要重复标题。
3. title、summary、metaphor、facts、steps、children 和 visual 需要互相一致。
4. facts 正好 3 项，steps 正好 5 项，children 正好 3 项。
   - children 是点击整幅 SVG 后展示的三个推荐追问。结合用户此前已经学习的内容、连续追问方向和偏好的问题方式生成。
   - 推荐问题不得重复用户已经问过的问题，也不要退回宽泛入门定义；应紧接当前答案，分别覆盖最值得继续理解的机制、边界/对比或现实影响。
   - 三个问题都应具体、可独立提问、通俗易懂，并能继续生成一张有明确视觉主体的下钻图解。
   - 学习历史只用于推荐问题个性化，不得改变本轮正文答案、事实结论或 SVG 的主要表达。
5. visual.nodes 包含 4-6 个值得点击了解的对象。每个节点提供清楚的 label、detail，以及正好 3 个继续追问的问题。
   - 每个 detail 使用约 100-180 个中文字符，分成 1-2 个短段落。先解释该对象是什么、在本轮问题中承担什么作用，再说明它如何工作、与哪些对象发生关系，以及最值得初学者注意的条件、影响或限制。
   - detail 必须提供该局部对象独有的信息，不能只是重复 summary，也不要使用“这是图中的某个元素”“它与整幅场景共同说明”等模板化废话。
   - 每个节点的 questions 必须围绕该局部对象继续深入，同时参考用户此前学习习惯，避免重复已学内容。
   - 三个问题应形成互补方向，例如内部机制、成立条件/限制、与其他对象的关系或实际影响，不能只是同一句话的改写。
6. visual.links 用节点数组下标描述必要的关系。visual.type 根据内容从 flow、cycle、network、compare、layers 中选择。
7. visual.sceneSvg 输出一张完整、可交互的动画 SVG 图解：
${revision && existingLesson ? `   - 这是一次针对现有 SVG 的定向修正。必须优先落实用户的修正要求，不要忽略、弱化或仅在文字字段中回应。
   - 保持原问题和核心知识结论不变，重点重新设计 visual.nodes、visual.links 和 sceneSvg，使图解真正解决用户指出的问题。
   - 不要只对当前 SVG 做颜色或文字上的微调；若结构、视角、对象选择或表达方式导致用户不满意，应重新组织整幅图解。`
    : revision ? `   - 上一次生成任务失败，本次是保留原问题后的重新尝试。请结合用户补充要求，从零生成完整的 visual.nodes、visual.links 和 sceneSvg。` : ""}
   - **sceneSvg 总字符数严格控制在 4500 以内**（必要动画不要省略，但元素数量要克制，最多 30-40 个 SVG 元素）；如内容复杂，优先用 2D 分层结构 + 少量关键动画，而不是堆砌细节。
   - sceneSvg 字符串中只能有一个完整的 <svg>...</svg>，不要输出 HTML、Markdown 或额外说明。
   - SVG 的 width、height 和 viewBox 由你根据内容自由决定（建议 800×500 左右）。
   - 先根据问题的知识结构选择最合适的空间表现，优先 2D 分层结构、时间轴、同尺度对照；只有内容确实需要时才使用 2.5D/透视。
   - 不使用外部资源、script、foreignObject、事件属性或 data URL。
   - visual.nodes 中每个节点都要在 SVG 中有对应的可点击分组，格式为 class="scene-hotspot hotspot-N"，N 是节点下标。
   - 有知识含义的对象可添加 data-label。背景和纯装饰元素不要添加。
8. 只返回符合 JSON Schema 的 JSON，不要输出其他内容。`;

  const agentLabel = SUPPORTED_AGENTS.includes(agent) ? agent : "codex";
  const isCodex = agentLabel === "codex";

  try {
    onStage("running", `${agentLabel} Agent 正在推理并绘制图解`);
    const raw = await runAgent(agentLabel, prompt, {
      cwd: root,
      timeoutMs: 600_000,
      // Codex-only: --output-schema / --output-last-message file paths.
      // Claude / opencode ignore them — schema lives inside the prompt.
      ...(isCodex
        ? { schemaPath, outputPath }
        : {}),
    });

    onStage("validating", "校验知识结构、SVG 与交互热点");
    const lesson = extractJson(raw);
    if (!lesson || typeof lesson !== "object") {
      throw new Error(
        `${agentLabel} 输出不是合法 JSON: ${raw.slice(0, 400)}`,
      );
    }
    lesson.visual.sceneSvg = sanitizeSceneSvg(lesson.visual.sceneSvg);
    onStage("finalizing", "整理结果并写入知识画布");
    return { ...lesson, answerMode: "visual" };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function sanitizeSceneSvg(svg) {
  if (typeof svg !== "string") throw new Error("Agent 未返回有效 SVG");
  let clean = svg.trim()
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<(foreignObject|iframe|object|embed|audio|video)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(foreignObject|iframe|object|embed|audio|video)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*(["'])\s*(?:javascript:|data:)[\s\S]*?\1/gi, "");
  const svgOpenCount = clean.match(/<svg\b/gi)?.length || 0;
  const svgCloseCount = clean.match(/<\/svg>/gi)?.length || 0;
  if (
    svgOpenCount !== 1
    || svgCloseCount !== 1
    || !/^<svg\b/i.test(clean)
    || !/<\/svg>\s*$/i.test(clean)
  ) {
    throw new Error("Agent 返回的 SVG 结构不完整");
  }
  clean = clean.replace(/^<svg\b([^>]*)>/i, (_, rawAttributes) => {
    let attributes = rawAttributes.trim();
    if (!/\bxmlns\s*=/i.test(attributes)) {
      attributes += ' xmlns="http://www.w3.org/2000/svg"';
    }
    if (!/\bpreserveAspectRatio\s*=/i.test(attributes)) {
      attributes += ' preserveAspectRatio="xMidYMid meet"';
    }
    return `<svg${attributes ? ` ${attributes}` : ""}>`;
  });
  clean = clean
    .replace(/\smarker-(?:start|mid|end)\s*=\s*(["']).*?\1/gi, "")
    .replace(/\smarker\s*=\s*(["']).*?\1/gi, "")
    .replace(/marker-(?:start|mid|end)\s*:\s*url\([^)]*\)\s*;?/gi, "")
    .replace(/marker\s*:\s*url\([^)]*\)\s*;?/gi, "");
  clean = clean.replace(/<animateTransform\b[^>]*\btype\s*=\s*(["'])rotate\1[^>]*\/?>/gi, (tag) => {
    const values = tag.match(/\bvalues\s*=\s*(["'])(.*?)\1/i)?.[2];
    const steps = values
      ? values.split(";").map((step) => step.trim()).filter(Boolean)
      : ["from", "to"]
          .map((name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2])
          .filter(Boolean);
    const hasExplicitPivot = steps.length > 0 && steps.every((step) => (
      (step.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).length >= 3
    ));
    const hasUnsafeByOnly = /\bby\s*=/i.test(tag)
      && !/\bfrom\s*=/i.test(tag)
      && !/\bto\s*=/i.test(tag)
      && !values;
    return hasExplicitPivot && !hasUnsafeByOnly ? tag : "";
  });
  const hotspotIndexes = [...clean.matchAll(/\bhotspot-(\d+)\b/g)].map((match) => Number(match[1]));
  if (new Set(hotspotIndexes).size < 4) {
    throw new Error("Agent 返回的 SVG 缺少交互热点");
  }
  return clean;
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/health") {
    json(response, 200, { ok: true, agents: SUPPORTED_AGENTS, defaultAgent: "claude", renderer: "svg" });
    return;
  }

  if (request.method === "GET" && request.url === "/api/store") {
    try {
      const state = await initializeUserState(getUserId(request));
      json(response, 200, state.appStore || {
        version: 1,
        workspaces: [],
        currentId: null,
        generationEstimateMs: 42_000,
        updatedAt: null,
      });
    } catch (error) {
      json(response, 400, { error: error.message || "无法读取用户画布数据" });
    }
    return;
  }

  if (request.method === "PUT" && request.url === "/api/store") {
    try {
      const state = await initializeUserState(getUserId(request));
      state.appStore = normalizeAppStore(JSON.parse(await readBody(request, 64_000_000)));
      await queueJsonWrite(state.storePath, state.appStore);
      json(response, 200, { ok: true, updatedAt: state.appStore.updatedAt });
    } catch (error) {
      json(response, 400, { error: error.message || "画布保存失败" });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/shares") {
    try {
      getUserId(request);
      const body = JSON.parse(await readBody(request, 64_000_000));
      const workspace = createShareSnapshot(body.workspace);
      const shareId = randomBytes(16).toString("hex");
      await queueJsonWrite(join(sharesDir, `${shareId}.json`), {
        version: 1,
        shareId,
        workspace,
        createdAt: new Date().toISOString(),
      });
      json(response, 201, { shareId });
    } catch (error) {
      json(response, 400, { error: error.message || "分享链接生成失败" });
    }
    return;
  }

  const shareMatch = request.url?.match(/^\/api\/shares\/([a-f0-9]{32})$/);
  if (request.method === "GET" && shareMatch) {
    const shared = await readJsonFile(join(sharesDir, `${shareMatch[1]}.json`), null);
    if (!shared?.workspace) {
      json(response, 404, { error: "分享画布不存在或已失效" });
      return;
    }
    json(response, 200, {
      shareId: shared.shareId,
      workspace: shared.workspace,
      createdAt: shared.createdAt,
    });
    return;
  }

  const taskMatch = request.url?.match(/^\/api\/tasks\/([^/?]+)$/);
  if (request.method === "GET" && taskMatch) {
    try {
      const state = await initializeUserState(getUserId(request));
      const task = state.lessonTasks.get(decodeURIComponent(taskMatch[1]));
      if (!task) {
        json(response, 404, { error: "任务不存在或服务已重启" });
        return;
      }
      json(response, 200, taskResponse(task));
    } catch (error) {
      json(response, 400, { error: error.message || "无法读取用户任务" });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/tasks") {
    try {
      const state = await initializeUserState(getUserId(request));
      const body = JSON.parse(await readBody(request));
      const taskId = typeof body.taskId === "string" ? body.taskId.trim().slice(0, 120) : "";
      if (!taskId) {
        json(response, 400, { error: "缺少任务 ID" });
        return;
      }
      const input = parseLessonInput(body);
      const task = startLessonTask(state, taskId, input);
      json(response, task.status === "pending" ? 202 : 200, taskResponse(task));
    } catch (error) {
      json(response, 400, { error: error.message || "任务参数无效" });
    }
    return;
  }

  if (request.method !== "POST" || request.url !== "/api/lesson") {
    json(response, 404, { error: "Not found" });
    return;
  }

  try {
    getUserId(request);
    const body = JSON.parse(await readBody(request));
    const {
      question,
      context,
      revision,
      existingLesson,
      learningHistory,
      visualConfig,
      answerMode,
      agent,
    } = parseLessonInput(body);
    const lesson = answerMode === "quick"
      ? await generateQuickAnswer(question, context, learningHistory, revision, agent)
      : await generateLesson(question, context, revision, existingLesson, learningHistory, visualConfig, agent);
    json(response, 200, lesson);
  } catch (error) {
    console.error("[atlas-agent]", error);
    json(response, 500, { error: error.message || "Agent 生成失败" });
  }
});

await Promise.all([
  mkdir(usersDir, { recursive: true }),
  mkdir(sharesDir, { recursive: true }),
]);

server.listen(port, "127.0.0.1", () => {
  console.log(`Atlas Agent API: http://127.0.0.1:${port}`);
});
