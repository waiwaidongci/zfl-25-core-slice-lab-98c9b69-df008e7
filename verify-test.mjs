#!/usr/bin/env node
/**
 * 岩芯切片批次工作台 —— 端到端验证脚本
 *
 * 覆盖：
 *  1. 批次登记 + 一次建立多张切片 + 登记后再批量添加
 *  2. 取样→切割→研磨→染色→观察 顺序推进，每步含操作人/时间/依据
 *  3. 工作台视图：进度、逾期项、下一步负责人
 *  4. 空观察结果不能完成观察、不能交付
 *  5. 非法跳步 / 回退 / 重复提交均失败
 *  6. 重复交付返回失败且不改写原交付记录
 *  7. 已交付批次封存，不能再推进/加片/改观察
 *  8. 重启服务后数据保留
 *
 * 用法：node verify-test.mjs            （自动准备独立测试库并启动服务，跑完即停）
 *      PORT 环境变量可改端口
 */
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TEST_PORT || "3125";
const BASE = `http://localhost:${PORT}`;
const DB = process.env.TEST_DB_FILE || join(__dirname, "data", "verify-test.json");

let pass = 0, fail = 0;
function ok(cond, title, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${title}`); }
  else { fail++; console.error(`  ❌ ${title}${extra ? `\n      ${extra}` : ""}`); }
}
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}
async function waitHealthy(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) return;
    } catch { /* 尚未启动 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("服务未能在限定时间内启动");
}
function startServer() {
  const child = spawn(process.execPath, [join(__dirname, "server.js")], {
    cwd: __dirname,
    env: { ...process.env, PORT, DB_FILE: DB },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));
  return child;
}
async function stopServer(child) {
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 2000);
  });
}
async function resetDb() {
  if (existsSync(DB)) rmSync(DB);
  for (const f of [DB + ".tmp"]) if (existsSync(f)) rmSync(f);
}
function getBatch(model, id) {
  return model.batches.find((b) => b.id === id);
}
// 推进到指定目标工序（stage 现在为必填）
function advance(batchId, sliceCode, body) {
  return call("POST", `/api/batches/${batchId}/slices/${sliceCode}/advance`, body);
}
function sliceState(batchId, code) {
  return call("GET", `/api/batches/${batchId}`).then((r) =>
    r.json.slices.find((x) => x.code === code));
}

async function main() {
  console.log("\n=== 0. 准备干净测试库并启动服务 ===");
  await resetDb();
  let server = startServer();
  await waitHealthy();
  console.log("  服务已就绪（全新数据库，含播种的演示批次）");

  try {
    /* ---------- 1. 工作台初始视图 ---------- */
    console.log("\n=== 1. 工作台视图：进度 / 逾期 / 下一步负责人（播种数据）===");
    let { json: model } = await call("GET", "/api/batches");
    ok(Array.isArray(model.batches) && model.batches.length >= 2, "播种批次可见", JSON.stringify(model.batches?.map(b => b.id)));
    const seedLive = model.batches.find((b) => b.id === "B20260901-001");
    ok(seedLive && seedLive.overdueCount >= 2, "演示批次存在逾期项（取样/研磨卡停）", `overdueCount=${seedLive?.overdueCount}`);
    ok(seedLive?.overdueItems.every((i) => i.overHours > 0), "逾期项带超期小时数", JSON.stringify(seedLive?.overdueItems));
    ok(seedLive?.progress.total === 3 && seedLive?.progress.observed === 1, "批次进度 1/3 观察完成", JSON.stringify(seedLive?.progress));
    const stainOwner = seedLive?.nextGroups.find((g) => g.stage === "染色");
    const cutOwner = seedLive?.nextGroups.find((g) => g.stage === "切割");
    ok(stainOwner?.owner === "苏染" && stainOwner.slices.includes("B20260901-001-S01"),
      "下一步负责人归组：S01 卡在研磨 → 染色/苏染", JSON.stringify(seedLive?.nextGroups));
    ok(cutOwner?.owner === "高岩" && cutOwner.slices.includes("B20260901-001-S03"),
      "下一步负责人归组：S03 卡在取样 → 切割/高岩", JSON.stringify(seedLive?.nextGroups));
    ok(!seedLive.nextGroups.some((g) => g.slices.includes("B20260901-001-S02")),
      "已完成观察的 S02 不在待办归组中，计入观察完成数");
    ok(seedLive?.canDeliver === false, "存在未完成观察的切片时不可交付");
    const seedDelivered = model.batches.find((b) => b.id === "B20260818-002");
    ok(seedDelivered?.delivered === true && seedDelivered?.status === "已交付", "已交付批次状态为“已交付”");

    /* ---------- 2. 样本登记 ---------- */
    console.log("\n=== 2. 样本登记（必填校验 + 一次建立多张切片 + 负责人）===");
    let r = await call("POST", "/api/batches", {});
    ok(r.status === 400 && r.json.error === "missing_field", "空表单登记被拒绝", JSON.stringify(r.json));

    r = await call("POST", "/api/batches", {
      project: "西坡铁矿补勘", borehole: "ZK-31", coreBox: "BX-22",
      depth: "45.20-45.60m", registeredBy: "陆川",
      owner_切割: "高岩", owner_研磨: "韩砂", owner_染色: "苏染", owner_观察: "顾鉴",
      sliceCount: 3,
    });
    ok(r.status === 201, "登记成功并一次建立 3 张切片", r.status !== 201 ? JSON.stringify(r.json) : "");
    const batch = r.json;
    const B = batch.id;
    ok(batch.slices.length === 3, "切片编号 B-S01..S03 自动生成", batch.slices.map(s => s.code).join(","));
    ok(batch.slices.every((s) => s.stage === null && s.nextStage === "取样"), "新切片全部停在“待取样”，下一步为取样");
    ok(batch.slices[0].nextOwner === "陆川", "未指定取样负责人时回退为登记人 陆川", batch.slices[0].nextOwner);
    const s02 = batch.slices.find((s) => s.code === `${B}-S02`);
    ok(s02.nextStage === "取样", "S02 初始待取样");

    /* ---------- 3. 登记后再批量添加切片 ---------- */
    console.log("\n=== 3. 登记后批量添加切片 ===");
    r = await call("POST", `/api/batches/${B}/slices`, { count: 2, slices: [{ method: "茜素红-S" }, { method: "薄片不染色" }] });
    ok(r.status === 201 && r.json.slices.length === 5, "再添加 2 张，总数 5", `status=${r.status} n=${r.json?.slices?.length}`);
    r = await call("POST", `/api/batches/${B}/slices`, {});
    ok(r.status === 400, "未提供数量被拒绝");
    r = await call("POST", `/api/batches/${B}/slices`, { count: 0 });
    ok(r.status === 400, "数量为 0 被拒绝");
    r = await call("POST", `/api/batches/${B}/slices`, { slices: [] });
    ok(r.status === 400 && r.json.error === "empty_slices", "空切片清单 slices:[] 被拒绝并说明原因", r.json.message);
    r = await call("POST", `/api/batches/${B}/slices`, { slices: "不是数组" });
    ok(r.status === 400 && r.json.error === "invalid_slices", "非数组清单被拒绝", r.json.message);
    r = await call("POST", "/api/batches/NO-SUCH/slices", { count: 1 });
    ok(r.status === 404, "不存在的批次返回 404");

    /* ---------- 4. 顺序推进：取样 → 切割 ---------- */
    console.log("\n=== 4. 顺序推进，每步校验操作人/依据/时间 ===");
    const S1 = `${B}-S01`;
    r = await advance(B, S1, {});
    ok(r.status === 400 && r.json.error === "missing_stage", "未指定目标工序不能推进");

    // 基准工序 from 必填，缺失/空白/非法都必须失败且不改变状态与记录
    r = await advance(B, S1, { stage: "取样" });
    ok(r.status === 400 && r.json.error === "missing_from_stage", "缺基准工序 from → 400", r.json.message);
    r = await advance(B, S1, { stage: "取样", from: "" });
    ok(r.status === 400 && r.json.error === "missing_from_stage", "from 为空串 → 400", r.json.message);
    r = await advance(B, S1, { stage: "取样", from: "   " });
    ok(r.status === 400 && r.json.error === "missing_from_stage", "from 为纯空白 → 400（按空值处理）", r.json.message);
    r = await advance(B, S1, { stage: "取样", from: null });
    ok(r.status === 400 && r.json.error === "missing_from_stage", "from 为 null → 400");
    r = await advance(B, S1, { stage: "取样", from: "打磨抛光" });
    ok(r.status === 400 && r.json.error === "invalid_from_stage", "from 为非法工序名 → 400", r.json.message);
    {
      const s = await sliceState(B, S1);
      ok(s.stage === null && s.records.length === 0, "所有缺/非法基准工序请求后状态与记录均未改变");
    }

    r = await advance(B, S1, { stage: "取样", from: "待取样" });
    ok(r.status === 400 && r.json.error === "missing_field", "基准合法但缺操作人/依据不能推进");
    r = await advance(B, S1, { stage: "取样", from: "待取样", operator: "陆川", basis: "" });
    ok(r.status === 400, "依据为空不能推进");
    r = await advance(B, S1, { stage: "取样", from: "待取样", operator: "陆川", basis: "取样规程", at: "not-a-time" });
    ok(r.status === 400 && r.json.error === "invalid_time", "非法时间格式被拒绝", JSON.stringify(r.json));

    r = await advance(B, S1, {
      stage: "取样", from: "待取样", operator: "陆川", basis: "取样作业指导书 v3.2", at: "2026-09-10T09:00Z",
    });
    ok(r.status === 200 && r.json.record.stage === "取样", "S01 完成取样", JSON.stringify(r.json?.record));
    ok(r.json.record.operator === "陆川" && r.json.record.basis.includes("v3.2"), "记录含操作人与依据");
    const afterSample = r.json.batch.slices.find((s) => s.code === S1);
    ok(afterSample.stage === "取样" && afterSample.nextStage === "切割" && afterSample.nextOwner === "高岩",
      "取样后下一步为切割→高岩", JSON.stringify({ stage: afterSample.stage, next: afterSample.nextStage, owner: afterSample.nextOwner }));
    ok(afterSample.records.length === 1, "取样记录已追加（1 条）");

    /* ---------- 5. 非法跳步 / 回退 / 重复提交 ---------- */
    console.log("\n=== 5. 非法跳步 / 回退 / 重复提交必须失败 ===");
    r = await advance(B, S1, { from: "取样", operator: "x", basis: "y", stage: "观察" });
    ok(r.status === 409 && r.json.error === "illegal_transition", "取样后直跳观察 → 409 非法跳步", r.json.message);
    r = await advance(B, S1, { from: "取样", operator: "x", basis: "y", stage: "取样" });
    ok(r.status === 409 && r.json.error === "duplicate_submit", "重复提交取样 → 409 且不改写", r.json.message);
    r = await advance(B, S1, { from: "取样", operator: "x", basis: "y", stage: "研磨" });
    ok(r.status === 409 && r.json.error === "illegal_transition", "跳过切割到研磨 → 409");
    r = await advance(B, S1, { operator: "x", basis: "y", stage: "不存在" });
    ok(r.status === 400, "未知工序 → 400");
    {
      const check = await call("GET", `/api/batches/${B}`);
      const s = check.json.slices.find((x) => x.code === S1);
      ok(s.stage === "取样" && s.records.length === 1, "所有非法请求后状态与记录均未被改写", `stage=${s.stage} records=${s.records.length}`);
    }

    /* ---------- 5b. 并发重复提交：同一切片同时收到相同推进请求 ---------- */
    console.log("\n=== 5b. 并发重复提交只允许一次推进（独立批次，不干扰主交付流程）===");
    const cb = await call("POST", "/api/batches", {
      project: "并发验证批", borehole: "ZK-C", coreBox: "BX-C", depth: "1-2m",
      registeredBy: "陆川", owner_切割: "高岩", sliceCount: 5,
    });
    const CB = cb.json.id;
    const S5 = `${CB}-S05`;
    {
      // 5 个完全相同的“从待取样推进到取样”请求同时发出
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        advance(CB, S5, { stage: "取样", from: "待取样", operator: "陆川", basis: "取样作业指导书 v3.2" })));
      const codes = results.map((x) => x.status);
      const n200 = codes.filter((c) => c === 200).length;
      const n409 = results.filter((x) => x.status === 409 && x.json.error === "duplicate_submit").length;
      ok(n200 === 1 && n409 === 4, `5 个并发相同请求：恰好 1 个成功、4 个 duplicate_submit（实际 ${codes.join(",")}）`);
      const s = await sliceState(CB, S5);
      ok(s.stage === "取样" && s.records.length === 1,
        "只前进了一步、只写了一条记录", `stage=${s.stage} records=${s.records.length}`);
      // 落盘后顺序重放同一请求（错过进行中窗口）仍应被乐观锁拒绝且不变
      const replay = await advance(CB, S5, { stage: "取样", from: "待取样", operator: "陆川", basis: "取样作业指导书 v3.2" });
      ok(replay.status === 409 && replay.json.error === "duplicate_submit", "完成后重放相同请求 → 409", replay.json.message);
      const s2 = await sliceState(CB, S5);
      ok(s2.stage === "取样" && s2.records.length === 1, "重放后状态/记录依旧不变");
    }
    {
      // 不同切片的相同目标工序并发，互不影响
      const S3 = `${CB}-S03`, S4 = `${CB}-S04`;
      const [a, c] = await Promise.all([
        advance(CB, S3, { stage: "取样", from: "待取样", operator: "陆川", basis: "取样规程" }),
        advance(CB, S4, { stage: "取样", from: "待取样", operator: "陆川", basis: "取样规程" }),
      ]);
      ok(a.status === 200 && c.status === 200, "不同切片并发推进各自成功（不会被互相判重）");

      // 同一张切片并发“推进到切割”：仍只允许一次
      const cuts = await Promise.all([
        advance(CB, S3, { stage: "切割", from: "取样", operator: "高岩", basis: "切割规程", at: "2026-09-10T13:00Z" }),
        advance(CB, S3, { stage: "切割", from: "取样", operator: "高岩", basis: "切割规程", at: "2026-09-10T13:05Z" }),
      ]);
      const okCount = cuts.filter((x) => x.status === 200).length;
      const dupCount = cuts.filter((x) => x.status === 409 && x.json.error === "duplicate_submit").length;
      ok(okCount === 1 && dupCount === 1, "同切片同目标并发：一成一拒 duplicate_submit（后到请求的时间不会覆盖先到记录）");
      const s3 = await sliceState(CB, S3);
      ok(s3.stage === "切割" && s3.records.length === 2 && s3.records[1].at === "2026-09-10T13:00:00.000Z",
        "保留先到请求写入的记录（13:00Z），未被 13:05Z 覆盖", JSON.stringify(s3.records.map(r => r.at)));
    }
    {
      // 先到请求校验失败时，不写入、释放槽位；并发的同样请求也都失败，随后合法请求可正常推进
      const S2 = `${CB}-S02`;
      const bad = await Promise.all(Array.from({ length: 3 }, () =>
        advance(CB, S2, { stage: "取样", from: "待取样", operator: "", basis: "" })));
      ok(bad.every((x) => x.status === 400), "3 个并发非法请求全部 400（先到失败不连累后到得到错误语义）");
      const s = await sliceState(CB, S2);
      ok(s.stage === null && s.records.length === 0, "全部失败后切片仍在待取样、无任何记录");
      const good = await advance(CB, S2, { stage: "取样", from: "待取样", operator: "陆川", basis: "取样规程" });
      ok(good.status === 200, "失败释放槽位后，合法请求可以正常推进", good.json?.message || "");
    }

    /* ---------- 5c. 跨目标并发：同一初始状态、目标工序不同也不得连跳 ---------- */
    console.log("\n=== 5c. 跨目标工序并发只允许一次推进（过期页面/重复重试不得跨多步）===");
    {
      // 全新切片，同时请求“切割”和“研磨”——取样未做，两者本身都非法，均不得成功
      const SX = `${CB}-S01`;
      const [rCut, rGrind] = await Promise.all([
        advance(CB, SX, { stage: "切割", from: "待取样", operator: "高岩", basis: "切割规程" }),
        advance(CB, SX, { stage: "研磨", from: "待取样", operator: "韩砂", basis: "磨片规程" }),
      ]);
      ok([rCut, rGrind].every((x) => x.status === 409 && x.json.error === "illegal_transition"),
        "待取样切片上并发 {切割,研磨}：二者都是非法跳步，全部 409",
        JSON.stringify([rCut.status, rCut.json.error, rGrind.status, rGrind.json.error]));
      const sx = await sliceState(CB, SX);
      ok(sx.stage === null && sx.records.length === 0, "非法跨目标并发后切片仍停在待取样、无记录");
    }
    {
      // 先确认 S05 已在“取样”（5b 的 5 连请求结果），再基于同一初始状态（from=取样）并发 {切割, 研磨, 染色}
      const target = `${CB}-S05`;
      const pre = await sliceState(CB, target);
      ok(pre.code === target && pre.stage === "取样", "前置：S05 当前在取样");
      const beforeN = pre.records.length;
      const res = await Promise.all([
        advance(CB, target, { stage: "切割", from: "取样", operator: "高岩", basis: "切割规程", at: "2026-09-10T13:00Z" }),
        advance(CB, target, { stage: "研磨", from: "取样", operator: "韩砂", basis: "磨片规程", at: "2026-09-10T13:05Z" }),
        advance(CB, target, { stage: "染色", from: "取样", operator: "苏染", basis: "染色规范", at: "2026-09-10T13:10Z" }),
      ]);
      const codes = res.map((x) => `${x.status}:${x.json.error || "ok"}`);
      const n200 = res.filter((x) => x.status === 200).length;
      ok(n200 === 1, `{切割,研磨,染色} 基于“取样”并发：恰好 1 个成功（实际 ${codes.join(" / ")}）`);
      const winner = res.find((x) => x.status === 200);
      ok(winner.json.record.stage === "切割", "先到成功者只推进到“切割”，不会因后到请求连跳");
      ok(res.filter((x) => x.json.error === "concurrent_conflict").length === 2,
        "跨目标的后到请求均命中 concurrent_conflict（过期页面/重试不得跨多步）");
      const after = await sliceState(CB, target);
      ok(after.stage === "切割" && after.records.length === beforeN + 1 &&
         after.records[after.records.length - 1].at === "2026-09-10T13:00:00.000Z",
        "只新增一条切割记录（13:00Z），研磨/染色请求未写入任何内容",
        `stage=${after.stage} records=${after.records.length}`);
    }
    {
      // 关键：请求“串行到达”（错过进行中窗口）时，乐观基准 from 仍须挡住过期跨工序请求
      const target = `${CB}-S05`; // 当前在“切割”
      const pre = await sliceState(CB, target);
      ok(pre.stage === "切割", "前置：S05 已被并发测试推进到切割");
      const beforeN = pre.records.length;
      // 两个都声称基于旧状态“取样”，且一个发到研磨、一个发到染色——依次、非并发
      const g1 = await advance(CB, target, { stage: "研磨", from: "取样", operator: "韩砂", basis: "磨片规程" });
      const g2 = await advance(CB, target, { stage: "染色", from: "取样", operator: "苏染", basis: "染色规范" });
      ok(g1.status === 409 && g1.json.error === "concurrent_conflict" &&
         g2.status === 409 && g2.json.error === "concurrent_conflict",
        "串行到达的过期请求（from=取样，当前已切割）也被拒绝，不依赖并发窗口",
        JSON.stringify([g1.json.error, g2.json.error]));
      const mid = await sliceState(CB, target);
      ok(mid.stage === "切割" && mid.records.length === beforeN, "两个过期请求后状态/记录均不变");
      // 基于最新状态“切割”的正常下一步应成功，主流程不受影响
      const legit = await advance(CB, target, { stage: "研磨", from: "切割", operator: "韩砂", basis: "磨片规程" });
      ok(legit.status === 200 && legit.json.record.stage === "研磨", "刷新后基于当前工序的正常推进成功（主流程正常）");
      const fin = await sliceState(CB, target);
      ok(fin.stage === "研磨" && fin.records.length === beforeN + 1, "正常推进恰好再进一步、多一条记录");
    }

    /* ---------- 6. 正常推进切割/研磨/染色 ---------- */
    console.log("\n=== 6. 正常推进 切割→研磨→染色（显式目标工序与时间）===");
    for (const [stage, operator, basis, hour, from] of [
      ["切割", "高岩", "切割作业指导书 v3.2", 12, "取样"],
      ["研磨", "韩砂", "磨片作业指导书 v2.5", 18, "切割"],
      ["染色", "苏染", "茜素红-S 染色规范 v1.8", 22, "研磨"],
    ]) {
      const rr = await advance(B, S1, {
        stage, from, operator, basis, at: `2026-09-10T${hour}:00Z`,
      });
      ok(rr.status === 200 && rr.json.record.stage === stage, `S01 完成「${stage}」（基准 ${from}）`, rr.json?.message || "");
    }
    {
      const g = await call("GET", `/api/batches/${B}`);
      const s = g.json.slices.find((x) => x.code === S1);
      ok(s.stage === "染色" && s.nextStage === "观察" && s.nextOwner === "顾鉴",
        "染色后下一步为观察→顾鉴", JSON.stringify({ stage: s.stage, owner: s.nextOwner }));
      ok(s.records.length === 4 && s.records.every((x) => x.operator && x.at && x.basis),
        "四条记录均含操作人/时间/依据");
    }

    /* ---------- 7. 观察：空结果拒绝；录入后可完成 ---------- */
    console.log("\n=== 7. 观察结果为空不能完成观察 ===");
    r = await advance(B, S1, {
      stage: "观察", from: "染色", operator: "顾鉴", basis: "岩矿鉴定规范", at: "2026-09-11T10:00Z",
    });
    ok(r.status === 400 && r.json.error === "observation_required", "空观察结果 → 400 且状态停在染色", r.json.message);
    {
      const g = await call("GET", `/api/batches/${B}`);
      const s = g.json.slices.find((x) => x.code === S1);
      ok(s.stage === "染色" && s.records.length === 4 && !s.observation, "被拒后观察记录未生成、观察结果仍为空");
    }
    const OBS = "磁铁石英岩，细粒变晶结构，条带状构造；金属矿物以磁铁矿为主（约 18%），石英呈定向拉长，局部见黄铁矿细脉。";
    r = await advance(B, S1, {
      stage: "观察", from: "染色", operator: "顾鉴", basis: "岩矿鉴定规范 DZ/T 0275", at: "2026-09-11T10:20Z", observation: OBS,
    });
    ok(r.status === 200 && r.json.record.stage === "观察", "录入观察结果后完成观察");
    {
      const g = await call("GET", `/api/batches/${B}`);
      const s = g.json.slices.find((x) => x.code === S1);
      ok(s.stage === "观察" && s.observation === OBS, "观察结果已保存到切片与记录");
      ok(s.nextStage === null && !s.delivered, "五工序完成，等待批次交付");
      r = await advance(B, S1, { stage: "观察", from: "观察", operator: "x", basis: "y" });
      ok(r.status === 409 && r.json.error === "stage_already_done", "已观察完成再推进/回退 → 409");
    }

    /* ---------- 8. 交付门槛：未全部观察 / 空观察 / 缺依据 ---------- */
    console.log("\n=== 8. 交付校验 ===");
    r = await call("POST", `/api/batches/${B}/deliver`, {});
    ok(r.status === 400, "缺交付人/依据不能交付");
    r = await call("POST", `/api/batches/${B}/deliver`, { operator: "顾鉴", basis: "报告 BG-1" });
    ok(r.status === 409 && r.json.error === "stage_incomplete",
      "其余切片未完成观察 → 409，并列出卡在的工序", r.json.message);
    // 给 S02 造一张“到达观察但观察结果为空”的切片（补录路径拒绝空值）
    {
      const S2 = `${B}-S02`;
      let hour = 8;
      let base = "待取样";
      for (const [stage, op, bs] of [
        ["取样", "陆川", "取样规程"], ["切割", "高岩", "切割规程"],
        ["研磨", "韩砂", "磨片规程"], ["染色", "苏染", "染色规范"],
      ]) {
        await advance(B, S2,
          { stage, from: base, operator: op, basis: bs, at: `2026-09-11T${String(hour++).padStart(2, "0")}:00Z` });
        base = stage;
      }
      // 染色→观察时给空白串也必须失败（基准工序仍为染色）
      const rr = await advance(B, S2,
        { stage: "观察", from: "染色", operator: "顾鉴", basis: "鉴定规范", at: "2026-09-11T17:00Z", observation: "   " });
      ok(rr.status === 400 && rr.json.error === "observation_required", "纯空白观察结果同样拒绝");
    }

    /* ---------- 9. 完成全部切片观察并交付 ---------- */
    console.log("\n=== 9. 完成全部 5 张切片观察后交付 ===");
    for (let i = 2; i <= 5; i++) {
      const code = `${B}-S0${i}`;
      // 该切片可能已推进若干步，查询当前状态补齐
      let g = await call("GET", `/api/batches/${B}`);
      let s = g.json.slices.find((x) => x.code === code);
      const plan = {
        取样: { op: "陆川", bs: "取样作业指导书 v3.2" },
        切割: { op: "高岩", bs: "切割作业指导书 v3.2" },
        研磨: { op: "韩砂", bs: "磨片作业指导书 v2.5" },
        染色: { op: "苏染", bs: "染色规范 v1.8" },
      };
      let dayHour = 8;
      for (const stage of ["取样", "切割", "研磨", "染色"]) {
        if (STAGES_IDX(s.stage) >= STAGES_IDX(stage)) continue;
        const hh = String(dayHour++).padStart(2, "0");
        await advance(B, code,
          { stage, from: s.stage ?? "待取样", operator: plan[stage].op, basis: plan[stage].bs, at: `2026-09-11T${hh}:30Z` });
        s.stage = stage; // 本地同步基准，便于下一步 from
      }
      g = await call("GET", `/api/batches/${B}`);
      s = g.json.slices.find((x) => x.code === code);
      if (s.stage !== "观察") {
        await advance(B, code, {
          stage: "观察", from: s.stage ?? "待取样", operator: "顾鉴", basis: "岩矿鉴定规范 DZ/T 0275",
          at: "2026-09-11T19:00Z", observation: `切片 ${code}：粒状结构，矿物组成均匀，未见显著矿化，综合判定为围岩样品。`,
        });
      }
    }
    {
      const g = await call("GET", `/api/batches/${B}`);
      ok(g.json.progress.observed === 5 && g.json.canDeliver === true,
        "5/5 观察完成，工作台置为可交付", JSON.stringify(g.json.progress));
    }
    const DEL_BASIS = "岩矿鉴定报告 BG-2026-0911-31 归档";
    r = await call("POST", `/api/batches/${B}/deliver`,
      { operator: "顾鉴", basis: DEL_BASIS, at: "2026-09-12T09:00Z" });
    ok(r.status === 200 && r.json.delivered && r.json.status === "已交付", "批次交付成功");
    ok(r.json.deliveryRecord.operator === "顾鉴" && r.json.deliveryRecord.basis === DEL_BASIS,
      "交付记录含操作人/时间/依据", JSON.stringify(r.json.deliveryRecord));
    ok(r.json.slices.every((s) => s.delivered),
      "全部切片随批次标记已交付");

    /* ---------- 10. 重复交付不改写；已交付封存 ---------- */
    console.log("\n=== 10. 重复交付失败且原记录不变；已交付批次封存 ===");
    const originalDelivered = r.json;
    const r2 = await call("POST", `/api/batches/${B}/deliver`,
      { operator: "冒名顶替者", basis: "试图改写的依据", at: "2026-12-31T00:00Z" });
    ok(r2.status === 409 && r2.json.error === "already_delivered", "重复交付 → 409 失败", r2.json.message);
    ok(r2.json.details?.deliveryRecord?.operator === "顾鉴" &&
       r2.json.details.deliveryRecord.basis === DEL_BASIS,
      "失败响应回传的仍是原交付记录");
    {
      const g = (await call("GET", `/api/batches/${B}`)).json;
      ok(g.deliveryRecord.operator === "顾鉴" && g.deliveryRecord.basis === DEL_BASIS &&
         g.deliveredAt === originalDelivered.deliveredAt,
        "库里的交付记录完全未被改写");
    }
    r = await advance(B, S1, { stage: "切割", from: "观察", operator: "x", basis: "y" });
    ok(r.status === 409 && r.json.error === "batch_locked", "已交付批次不能再推进工序");
    r = await call("POST", `/api/batches/${B}/slices`, { count: 1 });
    ok(r.status === 409 && r.json.error === "batch_locked", "已交付批次不能再添加切片");
    r = await call("PUT", `/api/batches/${B}/slices/${S1}/observation`,
      { observation: "试图篡改的观察结果", operator: "x" });
    ok(r.status === 409, "已交付批次观察记录不可改写");

    /* ---------- 11. 逾期判定（补录历史时间） ---------- */
    console.log("\n=== 11. 逾期项判定（按各工序 SLA 时限）===");
    r = await call("POST", "/api/batches", {
      project: "逾期验证批", borehole: "ZK-99", coreBox: "BX-01",
      depth: "10-11m", registeredBy: "陆川", owner_切割: "高岩", sliceCount: 1,
    });
    const B2 = r.json.id;
    const T1 = `${B2}-S01`;
    await advance(B2, T1,
      { stage: "取样", from: "待取样", operator: "陆川", basis: "规程", at: "2026-09-10T08:00Z" }); // 取样：24h 时限，已超约 24h
    {
      const g = await call("GET", `/api/batches/${B2}`);
      const s = g.json.slices[0];
      ok(s.stage === "取样" && s.overdue !== null && s.overdue.overHours >= 20,
        "取样停留超过 24h 时限被标记为逾期（今天 2026-09-12）", JSON.stringify(s.overdue));
      const listed = g.json.overdueItems.find((i) => i.code === T1);
      ok(!!listed, "工作台批次级逾期清单包含该切片");
    }
    r = await advance(B2, T1,
      { stage: "切割", from: "取样", operator: "高岩", basis: "切割规程", at: "2026-09-12T07:00Z" }); // 切割刚进入，未逾期
    ok(r.status === 200, "切割推进成功");
    {
      const g = await call("GET", `/api/batches/${B2}`);
      const s = g.json.slices[0];
      ok(s.stage === "切割" && s.overdue === null, "推进到切割后逾期解除（24h 内）");
    }

    /* ---------- 12. 观察补录路径 ---------- */
    console.log("\n=== 12. 观察结果补录（未交付、观察阶段内）===");
    r = await call("PUT", `/api/batches/${B2}/slices/${T1}/observation`,
      { observation: "还没进观察阶段", operator: "顾鉴" });
    ok(r.status === 409 && r.json.error === "not_in_observation", "未进入观察阶段不能补录观察结果");

    /* ---------- 13. 重启服务：数据持久化 ---------- */
    console.log("\n=== 13. 重启服务后数据保留 ===");
    await stopServer(server);
    await new Promise((r) => setTimeout(r, 600));
    server = startServer();
    await waitHealthy();
    {
      const list = await call("GET", "/api/batches");
      const restored = getBatch(list.json, B);
      const restored2 = getBatch(list.json, B2);
      ok(!!restored && restored.delivered === true, "重启后已交付批次仍在且保持已交付");
      ok(restored.slices.length === 5 && restored.slices[0].records.length === 5,
        "重启后切片与 5 步操作记录完整", `slices=${restored?.slices?.length}`);
      ok(restored.deliveryRecord.basis === DEL_BASIS, "重启后交付依据仍是原值（未被重复交付改写）");
      const t1 = restored2.slices[0];
      ok(t1.stage === "切割" && t1.records.length === 2, "重启后在制批次进度/记录完整");
      // 重启后重复交付仍然失败
      const rr = await call("POST", `/api/batches/${B}/deliver`, { operator: "x", basis: "y" });
      ok(rr.status === 409 && rr.json.error === "already_delivered", "重启后重复交付依旧被拒绝");
    }

    /* ---------- 汇总 ---------- */
  } finally {
    await stopServer(server);
  }

  console.log(`\n========== 验证结果：${pass} 通过，${fail} 失败 ==========`);
  if (fail) process.exit(1);
}
function STAGES_IDX(st) {
  return ["取样", "切割", "研磨", "染色", "观察"].indexOf(st);
}
main().catch((e) => {
  console.error("验证脚本异常：", e);
  process.exit(2);
});
