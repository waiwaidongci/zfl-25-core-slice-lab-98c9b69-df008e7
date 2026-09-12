import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_FILE
  ? (process.env.DB_FILE.startsWith("/") ? process.env.DB_FILE : join(__dirname, process.env.DB_FILE))
  : join(__dirname, "data", "core-slice.json");
const port = Number(process.env.PORT || 3025);

/* ---------- 领域常量 ---------- */

// 强制顺序：取样 → 切割 → 研磨 → 染色 → 观察
const STAGES = ["取样", "切割", "研磨", "染色", "观察"];
const STAGE_HOURS = { 取样: 24, 切割: 24, 研磨: 48, 染色: 24, 观察: 72 };
const DB_VERSION = 2;

/* ---------- 小工具 ---------- */

function nowIso() {
  return new Date().toISOString();
}
function fail(res, status, code, message, details = undefined) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: code, message, details }, null, 2));
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是合法 JSON");
  }
}
class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
function requireText(input, field, label, max = 200) {
  const value = typeof input[field] === "string" ? input[field].trim() : "";
  if (!value) throw new HttpError(400, "missing_field", `请填写${label}`);
  if (value.length > max) throw new HttpError(400, "field_too_long", `${label}不能超过 ${max} 个字符`);
  return value;
}
function optionalText(input, field, max = 100) {
  if (input[field] === undefined || input[field] === null) return undefined;
  const value = String(input[field]).trim();
  if (value.length > max) throw new HttpError(400, "field_too_long", `${field} 不能超过 ${max} 个字符`);
  return value || undefined;
}
// 接受 "2026-09-01T10:00" / ISO；返回 ISO 字符串
function parseOperatedAt(value) {
  if (value === undefined || value === null || value === "") return nowIso();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(400, "invalid_time", "操作时间格式不合法，请使用本地时间（如 2026-09-12T10:30）");
  }
  return d.toISOString();
}
function pad3(n) {
  return String(n).padStart(3, "0");
}
function pad2(n) {
  return String(n).padStart(2, "0");
}

/* ---------- 持久化 ---------- */

function makeSeedSlice(code, stageIndex, owners, overrides = {}) {
  // 构造已推进到 STAGES[stageIndex] 的切片（该阶段为当前停留阶段，逾期由 enterAt 决定）
  const slice = {
    code,
    method: overrides.method || "茜素红-S 染色",
    stage: null,
    stageEnterAt: null,
    observation: overrides.observation ?? null,
    delivered: false,
    deliveredAt: null,
    records: [],
  };
  // 以固定时间补历史记录（便于演示逾期，不依赖当前时钟）
  const base = Date.UTC(2026, 8, 1, 8, 0, 0); // 2026-09-01T08:00:00Z
  for (let i = 0; i <= stageIndex; i++) {
    const stage = STAGES[i];
    const at = new Date(base + i * 6 * 3600e3).toISOString();
    slice.records.push({
      stage,
      operator: owners[stage] || "陆川",
      at,
      basis: overrides[`${stage}Basis`] || `${stage}作业指导书 v3.2`,
      observation: stage === "观察" ? (overrides.observation ?? null) : null,
    });
    slice.stage = stage;
    slice.stageEnterAt = at;
  }
  if (overrides.observation !== undefined) slice.observation = overrides.observation;
  return slice;
}

function seedDb() {
  const owners = { 取样: "陆川", 切割: "高岩", 研磨: "韩砂", 染色: "苏染", 观察: "顾鉴" };
  const b1 = {
    id: "B20260901-001",
    project: "东岭铜矿外围普查",
    borehole: "ZK-17",
    coreBox: "BX-09",
    depth: "128.40-128.80m",
    rockType: "含矿化条带花岗闪长岩",
    registeredBy: "陆川",
    registeredAt: "2026-09-01T08:00:00.000Z",
    owners: { ...owners },
    delivered: false,
    deliveredAt: null,
    deliveryRecord: null,
    slices: [
      makeSeedSlice("B20260901-001-S01", 2, owners, { method: "茜素红-S 染色" }),   // 停在研磨，已逾期
      makeSeedSlice("B20260901-001-S02", 4, owners, {
        method: "茜素红-S 染色",
        observation: "半自形粒状结构，黄铜矿呈细脉浸染状分布，目估品位约 0.6%。",
      }), // 观察完成、待交付
      makeSeedSlice("B20260901-001-S03", 0, owners, { method: "薄片不染色（鉴定用）" }), // 停在取样，已逾期
    ],
  };
  // 第二个批次：已交付，用于演示“重复交付不改写”
  const b2owners = { 取样: "陆川", 切割: "高岩", 研磨: "韩砂", 染色: "苏染", 观察: "顾鉴" };
  const deliveredAt = "2026-08-20T09:30:00.000Z";
  const s = makeSeedSlice("B20260818-002-S01", 4, b2owners, {
    method: "薄片不染色（鉴定用）",
    observation: "绢英岩化安山岩，裂隙面见黄铁矿薄膜。",
  });
  s.delivered = true;
  s.deliveredAt = deliveredAt;
  const b2 = {
    id: "B20260818-002",
    project: "北沟金矿区详查",
    borehole: "ZK-04",
    coreBox: "BX-02",
    depth: "86.10-86.50m",
    rockType: "绢英岩化安山岩",
    registeredBy: "陆川",
    registeredAt: "2026-08-18T02:00:00.000Z",
    owners: { ...b2owners },
    delivered: true,
    deliveredAt,
    deliveryRecord: { operator: "顾鉴", at: deliveredAt, basis: "岩矿鉴定报告 BG-2026-0818-02 归档" },
    slices: [s],
  };
  return { version: DB_VERSION, seq: 2, batches: [b2, b1] };
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    const seeded = seedDb();
    await writeFile(dbPath, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  const raw = JSON.parse(await readFile(dbPath, "utf8"));
  if (!raw || raw.version !== DB_VERSION) {
    // 旧原型数据结构不兼容：备份后重新播种，避免脏数据破坏状态机
    const backup = dbPath.replace(/\.json$/, raw?.version ? `.v${raw.version}.bak.json` : ".legacy.bak.json");
    await rename(dbPath, backup);
    const seeded = seedDb();
    await writeFile(dbPath, JSON.stringify(seeded, null, 2));
    console.warn(`检测到旧版数据文件，已备份为 ${backup} 并重新初始化`);
    return seeded;
  }
  return raw;
}
async function saveDb(db) {
  const tmp = `${dbPath}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath); // 原子替换，进程崩溃不会写坏数据
}

/* ---------- 领域操作 ---------- */

function findBatch(db, id) {
  const batch = db.batches.find((b) => b.id === id);
  if (!batch) throw new HttpError(404, "batch_not_found", `批次 ${id} 不存在`);
  return batch;
}
function findSlice(batch, code) {
  const slice = batch.slices.find((s) => s.code === code);
  if (!slice) throw new HttpError(404, "slice_not_found", `切片 ${code} 不存在于批次 ${batch.id}`);
  return slice;
}
function nextStageOf(slice) {
  if (slice.stage === null) return STAGES[0];
  const idx = STAGES.indexOf(slice.stage);
  return idx >= STAGES.length - 1 ? null : STAGES[idx + 1];
}
function ownerFor(batch, stage) {
  return batch.owners?.[stage] || batch.registeredBy;
}

function registerBatch(db, input) {
  const project = requireText(input, "project", "项目名称");
  const borehole = requireText(input, "borehole", "钻孔编号");
  const coreBox = requireText(input, "coreBox", "岩芯箱号");
  const depth = requireText(input, "depth", "取样深度");
  const registeredBy = requireText(input, "registeredBy", "登记人");
  const rockType = optionalText(input, "rockType") || null;

  const owners = {};
  for (const stage of STAGES) {
    const v = optionalText(input, `owner_${stage}`);
    if (v) owners[stage] = v;
  }

  db.seq = (db.seq || 0) + 1;
  const date = new Date();
  const id = `B${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad3(db.seq)}`;
  const batch = {
    id,
    project, borehole, coreBox, depth, rockType,
    registeredBy,
    registeredAt: nowIso(),
    owners,
    delivered: false,
    deliveredAt: null,
    deliveryRecord: null,
    slices: [],
  };

  // 登记时可同时建立多张切片（一次添加多张）：给 slices 清单或只给 sliceCount
  const specs = Array.isArray(input.slices) ? input.slices : [];
  const count = specs.length || Number(input.sliceCount) || 0;
  if (count > 50) throw new HttpError(400, "too_many_slices", "单次最多建立 50 张切片");
  if (count < 0) throw new HttpError(400, "invalid_count", "切片数量不合法");
  for (let i = 0; i < count; i++) {
    const spec = specs[i] || {};
    batch.slices.push({
      code: `${id}-S${pad2(i + 1)}`,
      method: optionalText(spec, "method", 100) || null,
      stage: null,
      stageEnterAt: null,
      observation: null,
      delivered: false,
      deliveredAt: null,
      records: [],
    });
  }

  db.batches.unshift(batch);
  return batch;
}

function addSlices(batch, input) {
  if (batch.delivered) throw new HttpError(409, "batch_locked", "批次已交付封存，不能再添加切片");
  const hasList = input.slices !== undefined && input.slices !== null;
  if (hasList && !Array.isArray(input.slices)) {
    throw new HttpError(400, "invalid_slices", "切片清单必须是数组，每项可含 method 字段");
  }
  const specs = hasList ? input.slices : null;
  if (specs && specs.length === 0) {
    throw new HttpError(400, "empty_slices", "切片清单为空：至少需要添加 1 张切片（请提供非空 slices 清单，或改用 count 指定数量）");
  }
  const count = specs ? specs.length : Number(input.count) || 0;
  if (!specs && (!Number.isInteger(count) || count <= 0)) {
    throw new HttpError(400, "missing_count", "请提供要添加的切片数量（count，正整数）或非空切片清单（slices）");
  }
  if (count > 50) throw new HttpError(400, "too_many_slices", "单次最多添加 50 张切片");
  const start = batch.slices.length;
  for (let i = 0; i < count; i++) {
    const spec = specs ? specs[i] || {} : {};
    const code = `${batch.id}-S${pad2(start + i + 1)}`;
    if (batch.slices.some((s) => s.code === code)) {
      throw new HttpError(409, "slice_code_exists", `切片编号 ${code} 已存在`);
    }
    batch.slices.push({
      code,
      method: optionalText(spec, "method", 100) || null,
      stage: null,
      stageEnterAt: null,
      observation: null,
      delivered: false,
      deliveredAt: null,
      records: [],
    });
  }
  return batch;
}

function advanceSlice(batch, slice, input, targetStage) {
  if (batch.delivered) throw new HttpError(409, "batch_locked", "批次已交付封存，记录不可改写");
  if (slice.delivered) throw new HttpError(409, "slice_locked", "该切片已交付，不能再推进");

  const operator = requireText(input, "operator", "操作人");
  const basis = requireText(input, "basis", "依据（作业指导书/标准/任务单）", 300);
  const at = parseOperatedAt(input.at || input.operatedAt);

  const expected = nextStageOf(slice);
  if (expected === null) {
    throw new HttpError(409, "stage_already_done", `切片已停留在“${slice.stage}”，下一步应交付，不能继续推进或回退`);
  }

  // 目标工序由调用方（路由）结合请求意图解析；严格校验，非法跳步/回退直接失败
  const target = targetStage || expected;
  if (!STAGES.includes(target)) throw new HttpError(400, "unknown_stage", `未知工序：${target}`);
  if (target === slice.stage) {
    throw new HttpError(409, "duplicate_submit", `该切片已完成“${target}”，重复提交不会改写原记录（状态与记录保持不变）`);
  }
  if (target !== expected) {
    const where = slice.stage === null ? "尚未取样" : `当前停留在“${slice.stage}”`;
    throw new HttpError(
      409,
      "illegal_transition",
      `非法跳步/回退：切片${where}，只能推进到“${expected}”，不能直接到“${target}”`
    );
  }

  const record = { stage: expected, operator, at, basis, observation: null };

  // 观察阶段必须在完成时填写观察结果；空结果不能推进，更不能交付
  if (expected === "观察") {
    const obs = typeof input.observation === "string" ? input.observation.trim() : "";
    if (!obs) {
      throw new HttpError(400, "observation_required", "观察结果为空，不能完成观察工序（也无法交付），请先录入观察结果");
    }
    if (obs.length > 5000) throw new HttpError(400, "field_too_long", "观察结果不能超过 5000 字");
    record.observation = obs;
    slice.observation = obs;
  }

  slice.records.push(record);
  slice.stage = expected;
  slice.stageEnterAt = at;
  return { batch, slice, record };
}

// 观察结果补录/修订（仅限尚未交付、且已到达观察阶段的切片）；修订留痕，不改写历史步骤
function updateObservation(batch, slice, input) {
  if (batch.delivered || slice.delivered) {
    throw new HttpError(409, "locked", "已交付的观察记录不可改写");
  }
  if (slice.stage !== "观察") {
    throw new HttpError(409, "not_in_observation", `切片尚未进入观察阶段（当前：${slice.stage ?? "待取样"}），不能录入观察结果`);
  }
  const obs = requireText(input, "observation", "观察结果", 5000);
  const operator = requireText(input, "operator", "操作人");
  const basis = optionalText(input, "basis", 300) || "观察结果补录/修订";
  const at = parseOperatedAt(input.at);
  slice.observation = obs;
  // 追加一条观察阶段的修订记录，保留完整痕迹，原始完成记录不动
  slice.records.push({ stage: "观察", operator, at, basis, observation: obs });
  return { batch, slice };
}

function deliverBatch(batch, input) {
  if (batch.delivered) {
    // 重复交付：返回原记录，绝不改写
    throw new HttpError(409, "already_delivered", "批次已交付，重复交付不会改写原交付记录", {
      deliveryRecord: batch.deliveryRecord,
      deliveredAt: batch.deliveredAt,
    });
  }
  // 先校验输入，再校验状态
  const operator = requireText(input, "operator", "交付人");
  const basis = requireText(input, "basis", "交付依据（报告编号/任务单）", 300);
  const at = parseOperatedAt(input.at);

  if (batch.slices.length === 0) {
    throw new HttpError(400, "no_slices", "批次下没有切片，不能交付");
  }
  const notObserved = batch.slices.filter((s) => s.stage !== "观察");
  if (notObserved.length) {
    throw new HttpError(
      409,
      "stage_incomplete",
      `还有 ${notObserved.length} 张切片未完成观察工序（${notObserved.map((s) => `${s.code}：${s.stage ?? "待取样"}`).join("；")}），不能交付`
    );
  }
  const emptyObs = batch.slices.filter((s) => !s.observation || !String(s.observation).trim());
  if (emptyObs.length) {
    throw new HttpError(400, "observation_required", `观察结果为空，不能交付：${emptyObs.map((s) => s.code).join("、")}`);
  }

  const deliveryRecord = { operator, at, basis };
  batch.delivered = true;
  batch.deliveredAt = at;
  batch.deliveryRecord = deliveryRecord;
  for (const s of batch.slices) {
    s.delivered = true;
    s.deliveredAt = at;
  }
  return batch;
}

/* ---------- 工作台视图 ---------- */

function sliceView(slice, batch, refNow) {
  const next = nextStageOf(slice);
  let overdue = null;
  // 仅对“还在等下一工序”的在制切片做 SLA 逾期判定；已完成观察等待交付的不再算工序逾期
  if (!batch.delivered && next && slice.stage && slice.stageEnterAt) {
    const limitMs = STAGE_HOURS[slice.stage] * 3600e3;
    const elapsed = refNow - new Date(slice.stageEnterAt).getTime();
    if (elapsed > limitMs) {
      overdue = {
        stage: slice.stage,
        limitHours: STAGE_HOURS[slice.stage],
        overHours: Math.round((elapsed - limitMs) / 3600e3),
      };
    }
  }
  return {
    code: slice.code,
    method: slice.method,
    stage: slice.stage,
    nextStage: next,
    nextOwner: next ? ownerFor(batch, next) : slice.stage === "观察" ? ownerFor(batch, "观察") : null,
    stageEnterAt: slice.stageEnterAt,
    observation: slice.observation,
    delivered: slice.delivered,
    deliveredAt: slice.deliveredAt,
    records: slice.records,
    overdue,
  };
}

function batchView(batch, refNow) {
  const slices = batch.slices.map((s) => sliceView(s, batch, refNow));
  const total = slices.length;
  const done = slices.filter((s) => s.stage === "观察").length;
  const overItems = slices.filter((s) => s.overdue);
  const active = slices.filter((s) => !s.delivered && s.nextStage);

  // 下一步负责人：按“下一工序 + 负责人”归组
  const nextGroupsMap = new Map();
  for (const s of active) {
    const key = `${s.nextStage}|${s.nextOwner}`;
    if (!nextGroupsMap.has(key)) nextGroupsMap.set(key, { stage: s.nextStage, owner: s.nextOwner, slices: [] });
    nextGroupsMap.get(key).slices.push(s.code);
  }
  const nextGroups = [...nextGroupsMap.values()];

  let status;
  if (batch.delivered) status = "已交付";
  else if (total === 0) status = "待制片";
  else if (done === total) status = "待交付";
  else status = "制片中";

  const canDeliver =
    !batch.delivered &&
    total > 0 &&
    slices.every((s) => s.stage === "观察") &&
    slices.every((s) => s.observation && String(s.observation).trim());

  return {
    id: batch.id,
    project: batch.project,
    borehole: batch.borehole,
    coreBox: batch.coreBox,
    depth: batch.depth,
    rockType: batch.rockType,
    registeredBy: batch.registeredBy,
    registeredAt: batch.registeredAt,
    owners: batch.owners,
    delivered: batch.delivered,
    deliveredAt: batch.deliveredAt,
    deliveryRecord: batch.deliveryRecord,
    status,
    progress: { total, observed: done, percent: total ? Math.round((done / total) * 100) : 0 },
    overdueCount: overItems.length,
    overdueItems: overItems.map((s) => ({ code: s.code, stage: s.overdue.stage, overHours: s.overdue.overHours, limitHours: s.overdue.limitHours })),
    nextGroups,
    canDeliver,
    slices,
  };
}

/* ---------- 简易串行锁（避免并发写互相覆盖） ---------- */

let chain = Promise.resolve();
function withDb(fn) {
  const run = chain.then(() => loadDb().then(fn));
  chain = run.then(() => {}, () => {});
  return run;
}
function normalizeTargetStage(input) {
  const raw = input.stage ?? input.target;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  return String(raw).trim();
}

/* ---------- 推进防重（同一切片 → 同一目标工序的并发去重） ----------
 *
 * 背景：串行写锁（withDb）只保证不互相覆盖。两个相同的推进请求并发时，
 * 第一个把 取样→切割 落盘后，第二个重新加载到新状态，会被当成“推进到研磨”
 * 再成功一次 —— 于是连续前进两步、多写一条记录。
 *
 * 顺序重发没有这个问题：状态机会发现目标工序已完成并拒绝；唯一漏洞是后到
 * 请求在首个请求落盘前读到了旧状态。这里加“进行中槽位”：同一
 * （切片, 目标工序）只允许一个请求执行，其余并发请求等首个结果——
 *   - 首个成功：后到的一律 409 duplicate_submit，不写任何记录；
 *   - 首个失败（如缺依据/空观察）：后到请求作为独立尝试再执行一次，
 *     不会因为别人的校验失败被误伤。
 * 槽位声明在同一事件循环轮次内同步完成，Node 单线程下天然原子。
 */
const inflightAdvance = new Map(); // `${batchId}|${sliceCode}|${target}` -> Promise<settled>

function runAdvance({ batchId, sliceCode, target, input }) {
  const key = `${batchId}|${sliceCode}|${target}`;
  const execute = () =>
    withDb(async (db) => {
      const b = findBatch(db, batchId);
      const s = findSlice(b, sliceCode);
      const r = advanceSlice(b, s, input, target);
      await saveDb(db);
      return r;
    });
  const asSettled = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
  const dupError = () => new HttpError(
    409,
    "duplicate_submit",
    `检测到并发重复提交：该切片的“${target}”推进已由先到请求完成，后到请求未写入任何记录，切片仅前进一步`
  );

  function attempt() {
    const existing = inflightAdvance.get(key);
    if (existing) {
      return existing.then((first) => {
        if (first.ok) throw dupError();
        return attempt(); // 首个失败（校验未过），本请求独立重试一次
      });
    }
    const settled = asSettled(execute());
    inflightAdvance.set(key, settled);
    settled.finally(() => inflightAdvance.delete(key));
    return settled.then((out) => {
      if (!out.ok) throw out.e;
      return out.r;
    });
  }
  return attempt();
}

/* ---------- 前端页面 ---------- */

async function servePage(res) {
  try {
    const html = await readFile(join(__dirname, "public", "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("public/index.html 缺失");
  }
}

/* ---------- HTTP 路由 ---------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") return await servePage(res);
    if (req.method === "GET" && p === "/api/health") {
      return sendJson(res, 200, { ok: true, stages: STAGES, stageHours: STAGE_HOURS, time: nowIso() });
    }

    // 工作台总览
    if (req.method === "GET" && p === "/api/batches") {
      const db = await loadDb();
      const refNow = Date.now();
      return sendJson(res, 200, {
        stages: STAGES,
        stageHours: STAGE_HOURS,
        batches: db.batches.map((b) => batchView(b, refNow)),
      });
    }

    // 批次详情
    let m = p.match(/^\/api\/batches\/([^/]+)$/);
    if (m && req.method === "GET") {
      const batch = await withDb((db) => findBatch(db, m[1]));
      return sendJson(res, 200, batchView(batch, Date.now()));
    }

    // 批次登记（可同时建立多张切片）
    if (req.method === "POST" && p === "/api/batches") {
      const input = await readBody(req);
      const batch = await withDb(async (db) => {
        const b = registerBatch(db, input);
        await saveDb(db);
        return b;
      });
      return sendJson(res, 201, batchView(batch, Date.now()));
    }

    // 批量添加切片
    m = p.match(/^\/api\/batches\/([^/]+)\/slices$/);
    if (m && req.method === "POST") {
      const input = await readBody(req);
      const batch = await withDb(async (db) => {
        const b = findBatch(db, m[1]);
        addSlices(b, input);
        await saveDb(db);
        return b;
      });
      return sendJson(res, 201, batchView(batch, Date.now()));
    }

    // 推进到下一工序（必须显式说明目标工序，便于服务端识别并发重复提交）
    m = p.match(/^\/api\/batches\/([^/]+)\/slices\/([^/]+)\/advance$/);
    if (m && req.method === "POST") {
      const input = await readBody(req);
      const batchId = m[1];
      const sliceCode = decodeURIComponent(m[2]);
      const target = normalizeTargetStage(input);
      if (!target) {
        throw new HttpError(400, "missing_stage", "推进请求必须指定目标工序（字段 stage），请由“推进到下一工序”按钮提交");
      }
      if (!STAGES.includes(target)) throw new HttpError(400, "unknown_stage", `未知工序：${target}`);
      const result = await runAdvance({ batchId, sliceCode, target, input });
      return sendJson(res, 200, { batch: batchView(result.batch, Date.now()), record: result.record });
    }

    // 观察结果补录
    m = p.match(/^\/api\/batches\/([^/]+)\/slices\/([^/]+)\/observation$/);
    if (m && req.method === "PUT") {
      const input = await readBody(req);
      const result = await withDb(async (db) => {
        const b = findBatch(db, m[1]);
        const s = findSlice(b, decodeURIComponent(m[2]));
        const r = updateObservation(b, s, input);
        await saveDb(db);
        return r;
      });
      return sendJson(res, 200, batchView(result.batch, Date.now()));
    }

    // 批次交付
    m = p.match(/^\/api\/batches\/([^/]+)\/deliver$/);
    if (m && req.method === "POST") {
      const input = await readBody(req);
      const batch = await withDb(async (db) => {
        const b = findBatch(db, m[1]);
        deliverBatch(b, input);
        await saveDb(db);
        return b;
      });
      return sendJson(res, 200, batchView(batch, Date.now()));
    }

    return fail(res, 404, "not_found", "接口不存在");
  } catch (error) {
    if (error instanceof HttpError) {
      return fail(res, error.status, error.code, error.message, error.details);
    }
    console.error(error);
    return fail(res, 500, "internal_error", error.message || "服务器内部错误");
  }
});

server.listen(port, () => {
  console.log(`岩芯切片批次工作台已启动：http://localhost:${port}`);
});
