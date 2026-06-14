# E2E 套件分类与提速 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/desktop/e2e` 的 22 个 spec 重组成 5 个可选择运行的 suite（smoke/ui/export/audio/motif），抽出共享 helper 消除重复，平衡合并安全用例（22→15 文件），并加 opt-in 跳过构建——既能本地只跑一类，又能压缩全量总时长。

**Architecture:** 新增 `helpers/` 模块集中所有 `browser.execute*` 包装（app/preview/export/media），各 spec 改为 import；wdio 用 `suites` 分组 + `scripts/run-suite.mjs` 直接 spawn `node wdio.js --suite <name>` 绕开 Windows 上 npm/PS 吞 `--` 的坑；`onPrepare` 用 `WEFTCUT_E2E_NO_BUILD` 跳过 `tauri build`。死锁高发的 7 个 export spec 保持 1:1 独立。

**Tech Stack:** WebdriverIO 9 + mocha + tauri-driver + msedgedriver（真实 WebView2），ESM（`type: module`），Node 22。

> 设计来源：`docs/superpowers/specs/2026-06-14-e2e-suite-categories-design.md`
> 工作分支：`e2e-suite-categories`（worktree `videtor-wt1`，基于 main `4a16fe46`）。

## 关于 TDD 的说明（本计划的适配）

这是**测试基础设施重构**，被改动的对象本身就是测试。这里没有"先写失败测试"的产品代码循环；正确性判据是：**重组后每个 suite 仍能跑通、用例数与断言不减、行为与现状等价**。因此每个阶段的"验证"步骤 = 跑对应 suite 并确认（a）"Execution of 1 workers"、（b）用例数等于来源 spec 之和、（c）全绿。e2e 跑得慢，所以检查点按"阶段/类别"粒度，而非每次微改。Phase 1 末尾用 `e2e:smoke`（约 1 次启动）作为最便宜的管线自检。

## 前置：依赖安装（worktree 首次）

worktree 不共享 `node_modules`。执行任何任务前，在 `videtor-wt1` 里装好 e2e 依赖。

- [ ] **Step 1: 安装 e2e 依赖**

Run（在 `C:/Users/jonny/Desktop/learning/videtor-wt1`）:
```
npm --prefix apps/desktop/e2e install
```
Expected: 安装完成，`apps/desktop/e2e/node_modules/@wdio/cli/bin/wdio.js` 存在。

> 注意：所有后续路径都相对 worktree 根 `C:/Users/jonny/Desktop/learning/videtor-wt1`。提交时**按显式路径暂存**（main 正被其他会话推进），提交前 `git status` 复查。

## File Structure

新建：
- `apps/desktop/e2e/helpers/media.mjs` — fixture/输出路径 + `MEDIA_DIR`（尊重 `WEFTCUT_TEST_MEDIA`）
- `apps/desktop/e2e/helpers/app.mjs` — `waitForHook` / `invokeCmd` / `newProject` / `summary` / `findLayer` / `findTrackOf`
- `apps/desktop/e2e/helpers/preview.mjs` — `seekUs` / `sampleAt` / `waitPreviewBridge`
- `apps/desktop/e2e/helpers/export.mjs` — `driveExport`（fire-and-forget + 轮询 `__weftcutExportState`）
- `apps/desktop/e2e/scripts/run-suite.mjs` — Windows 安全的 suite 运行器
- 合并产物：`specs/ui/layers.e2e.js`、`specs/audio/audio.e2e.js`、`specs/motif/capture.e2e.js`、`specs/motif/state.e2e.js`

修改：
- `apps/desktop/e2e/wdio.conf.mjs` — `suites` + build-skip guard
- `apps/desktop/e2e/package.json` — `e2e*` 脚本
- 全部 22 个 spec：移入子目录 + 改用共享 helper（合并的 9 个被并入 4 个文件）

不动：`apps/desktop/e2e/lib/analyze.mjs`、`apps/desktop/e2e/tools/**`、`fixtures/**`、产品代码。

---

## Phase 1 — 共享基础设施（不碰 spec，纯新增）

### Task 1: helpers/media.mjs

**Files:**
- Create: `apps/desktop/e2e/helpers/media.mjs`

- [ ] **Step 1: 写入模块**

```js
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // apps/desktop/e2e/helpers

/// Fixture media root. Respects WEFTCUT_TEST_MEDIA; defaults to e2e/fixtures/media.
/// Computed relative to helpers/ so it is independent of how deep a spec lives.
export const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "..", "fixtures", "media");

/// Absolute path to a named fixture under MEDIA_DIR.
export const fixture = (name) => path.resolve(MEDIA_DIR, name);

/// Absolute path to a temp output file under the OS tmpdir.
export const tmpOut = (name) => path.resolve(os.tmpdir(), name);

/// Absolute path to a temp project-parent folder under the OS tmpdir.
export const tmpProjectParent = (name) => path.resolve(os.tmpdir(), name);
```

- [ ] **Step 2: 语法自检**

Run: `node --check apps/desktop/e2e/helpers/media.mjs`
Expected: 无输出（exit 0）。

- [ ] **Step 3: Commit**

```
git add apps/desktop/e2e/helpers/media.mjs
git commit -m "test(e2e): add shared media-path helper"
```

### Task 2: helpers/app.mjs

**Files:**
- Create: `apps/desktop/e2e/helpers/app.mjs`

> `browser` 是 wdio 注入到 globalThis 的全局；被 spec import 的模块在调用时可直接引用。

- [ ] **Step 1: 写入模块**

```js
/// Tauri-app interaction helpers. All wrap wdio's global `browser`.

/// Wait until a window.__weftcutTest hook of the given name is a function.
export async function waitForHook(name, timeout = 30000) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (n) => typeof window.__weftcutTest?.[n] === "function",
        name,
      )) === true,
    { timeout, timeoutMsg: `${name} never mounted` },
  );
}

/// Invoke a Tauri command via window.__TAURI__.core.invoke; throw on failure.
export async function invokeCmd(cmd, args) {
  const r = await browser.executeAsync(
    (c, a, done) => {
      window.__TAURI__.core
        .invoke(c, a)
        .then((res) => done({ ok: true, res }))
        .catch((e) => done({ ok: false, error: String(e) }));
    },
    cmd,
    args ?? {},
  );
  if (!r.ok) throw new Error(`invoke ${cmd} failed: ${r.error}`);
  return r.res;
}

/// Create a fresh project and enter the editor. Waits for the hook first.
export async function newProject({ parentFolder, name, canvas }) {
  await waitForHook("newProjectAndEnter");
  const r = await browser.executeAsync(
    (parent, nm, cv, done) => {
      window.__weftcutTest
        .newProjectAndEnter({ parentFolder: parent, name: nm, canvas: cv })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    },
    parentFolder,
    name ?? ("e2e-" + Date.now()),
    { ...canvas },
  );
  if (!r.ok) throw new Error("newProjectAndEnter failed: " + r.error);
}

/// Read the current project summary (tracks + layers).
export const summary = () => invokeCmd("project_summary");

/// Find a layer by id across all tracks; null if absent.
export function findLayer(sum, layerId) {
  for (const t of sum.tracks) {
    const l = t.layers.find((x) => x.id === layerId);
    if (l) return l;
  }
  return null;
}

/// Find the track that holds a given layer id; null if absent.
export function findTrackOf(sum, layerId) {
  return sum.tracks.find((t) => t.layers.some((l) => l.id === layerId)) ?? null;
}
```

- [ ] **Step 2: 语法自检**

Run: `node --check apps/desktop/e2e/helpers/app.mjs`
Expected: exit 0。

- [ ] **Step 3: Commit**

```
git add apps/desktop/e2e/helpers/app.mjs
git commit -m "test(e2e): add shared app-interaction helpers"
```

### Task 3: helpers/preview.mjs

**Files:**
- Create: `apps/desktop/e2e/helpers/preview.mjs`

- [ ] **Step 1: 写入模块**

```js
/// Live-preview sampling helpers. Wrap wdio's global `browser`.

/// Seek the live preview to an absolute time (µs).
export async function seekUs(tUs) {
  await browser.execute((t) => window.__weftcutTest.weftcutSeekUs(t), tUs);
}

/// Sample the composited pixel at (x,y). Re-seeks first so a paused stale frame
/// can't mask an async composite update; settles `settleMs` after the seek.
export async function sampleAt(tUs, x, y, settleMs = 300) {
  await seekUs(tUs);
  await browser.pause(settleMs);
  const r = await browser.executeAsync(
    (px, py, done) => {
      window.__weftcutTest
        .weftcutSampleComposite(px, py)
        .then((p) => done({ ok: true, p }))
        .catch((e) => done({ ok: false, error: String(e) }));
    },
    x,
    y,
  );
  if (!r.ok) throw new Error(`weftcutSampleComposite failed: ${r.error}`);
  return r.p;
}

/// Wait until the preview bridge (weftcutSampleComposite) is registered and live.
/// Only registers once PixiPreview mounts (timeline non-empty) — call AFTER a
/// layer has been added.
export async function waitPreviewBridge(timeout = 30000) {
  await browser.waitUntil(
    async () =>
      (await browser.executeAsync((done) => {
        if (typeof window.__weftcutTest?.weftcutSampleComposite !== "function") {
          return done(false);
        }
        window.__weftcutTest
          .weftcutSampleComposite(0, 0)
          .then(() => done(true))
          .catch(() => done(false));
      })) === true,
    { timeout, timeoutMsg: "preview bridge never registered" },
  );
}
```

- [ ] **Step 2: 语法自检**

Run: `node --check apps/desktop/e2e/helpers/preview.mjs`
Expected: exit 0。

- [ ] **Step 3: Commit**

```
git add apps/desktop/e2e/helpers/preview.mjs
git commit -m "test(e2e): add shared preview-sampling helpers"
```

### Task 4: helpers/export.mjs

**Files:**
- Create: `apps/desktop/e2e/helpers/export.mjs`

> 设计要点：`driveExport` **不在导出失败时抛错**——它返回 settlement。期望成功的调用方检查 `r.done.ok`；测错误路径的调用方（如 content_modes）断言 `r.done.ok === false`。`args` 原样转发给 `exportClip`，覆盖 `{mediaAbsPath,outputAbsPath}`、`{...,settings}`、以及 audio/keyframe 的自定义 patch 形态。

- [ ] **Step 1: 写入模块**

```js
import { waitForHook } from "./app.mjs";

/// Drive window.__weftcutTest.exportClip(args) fire-and-forget and poll the
/// mirrored export state until it settles. Returns { done, lastFrame, lastKind,
/// lastDetail } WITHOUT throwing on export failure. `args` is forwarded verbatim
/// to exportClip. Logs each frame/phase advance so a hang reports the exact
/// stall frame instead of a blind timeout.
export async function driveExport(args, { timeout = 170000, label = "" } = {}) {
  await waitForHook("exportClip");
  await browser.execute((a) => {
    window.__e2eExportDone = null;
    window.__weftcutTest
      .exportClip(a)
      .then(() => {
        window.__e2eExportDone = { ok: true };
      })
      .catch((e) => {
        window.__e2eExportDone = { ok: false, error: String(e) };
      });
  }, args);

  const tag = label ? " " + label : "";
  let lastFrame = -1;
  let lastKind = null;
  let lastDetail = null;
  let settled = null;
  try {
    await browser.waitUntil(
      async () => {
        const snap = await browser.execute(() => {
          const st = window.__weftcutExportState;
          return {
            done: window.__e2eExportDone,
            kind: st?.kind ?? null,
            phase: st?.progress?.phase ?? null,
            frame: st?.progress?.frame ?? null,
            detail: st?.detail ?? null,
          };
        });
        if (snap.frame != null && snap.frame !== lastFrame) {
          lastFrame = snap.frame;
          console.log(`[e2e]${tag} export ${snap.kind}/${snap.phase ?? "-"} frame=${snap.frame}`);
        }
        if (snap.kind && snap.kind !== lastKind) {
          lastKind = snap.kind;
          console.log(`[e2e]${tag} export phase -> ${snap.kind}`);
        }
        if (snap.detail && snap.detail !== lastDetail) lastDetail = snap.detail;
        if (snap.done) {
          settled = snap.done;
          return true;
        }
        return false;
      },
      { timeout, interval: 1000 },
    );
  } catch (e) {
    throw new Error(
      `export never settled (last kind=${lastKind}, detail=${lastDetail}, last frame=${lastFrame}): ${e.message}`,
    );
  }
  return { done: settled, lastFrame, lastKind, lastDetail };
}
```

- [ ] **Step 2: 语法自检**

Run: `node --check apps/desktop/e2e/helpers/export.mjs`
Expected: exit 0。

- [ ] **Step 3: Commit**

```
git add apps/desktop/e2e/helpers/export.mjs
git commit -m "test(e2e): add shared export-driver helper"
```

### Task 5: scripts/run-suite.mjs + package.json 脚本

**Files:**
- Create: `apps/desktop/e2e/scripts/run-suite.mjs`
- Modify: `apps/desktop/e2e/package.json`

- [ ] **Step 1: 写入 run-suite.mjs**

```js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run wdio for one suite by spawning node -> wdio.js directly with the --suite
// flag in argv. This sidesteps the Windows npm/PowerShell `--` swallowing trap
// (passing `--suite` through `npm run ... -- --suite x` silently drops it).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(HERE, ".."); // apps/desktop/e2e
const WDIO_BIN = path.resolve(E2E_ROOT, "node_modules", "@wdio", "cli", "bin", "wdio.js");
const CONF = path.resolve(E2E_ROOT, "wdio.conf.mjs");

const VALID = new Set(["all", "smoke", "ui", "export", "audio", "motif"]);
const suite = process.argv[2];
if (!suite || !VALID.has(suite)) {
  console.error(`[run-suite] usage: node scripts/run-suite.mjs <${[...VALID].join("|")}>`);
  process.exit(2);
}

const args = ["run", CONF];
if (suite !== "all") args.push("--suite", suite);

const child = spawn(process.execPath, [WDIO_BIN, ...args], {
  stdio: "inherit",
  cwd: E2E_ROOT,
});
child.on("exit", (code) => process.exit(code ?? 1));
```

- [ ] **Step 2: 改 package.json 的 `scripts` 块**

把现有 `scripts` 替换为（保留 `drivers`/`fixtures`/`test` 不变，新增 `e2e*`）：
```json
  "scripts": {
    "drivers": "node scripts/fetch-msedgedriver.mjs",
    "fixtures": "node fixtures/generate-fixtures.mjs",
    "test": "node scripts/fetch-msedgedriver.mjs && wdio run wdio.conf.mjs",
    "e2e": "node scripts/fetch-msedgedriver.mjs && node scripts/run-suite.mjs all",
    "e2e:smoke": "node scripts/fetch-msedgedriver.mjs && node scripts/run-suite.mjs smoke",
    "e2e:ui": "node scripts/fetch-msedgedriver.mjs && node scripts/run-suite.mjs ui",
    "e2e:export": "node scripts/fetch-msedgedriver.mjs && node scripts/run-suite.mjs export",
    "e2e:audio": "node scripts/fetch-msedgedriver.mjs && node scripts/run-suite.mjs audio",
    "e2e:motif": "node scripts/fetch-msedgedriver.mjs && node scripts/run-suite.mjs motif"
  },
```

- [ ] **Step 3: 语法自检**

Run: `node --check apps/desktop/e2e/scripts/run-suite.mjs`
Expected: exit 0。
Run: `node -e "JSON.parse(require('fs').readFileSync('apps/desktop/e2e/package.json','utf8'))"`
Expected: 无报错（JSON 合法）。

- [ ] **Step 4: Commit**

```
git add apps/desktop/e2e/scripts/run-suite.mjs apps/desktop/e2e/package.json
git commit -m "test(e2e): add Windows-safe per-suite runner + npm scripts"
```

### Task 6: wdio.conf.mjs — suites + build-skip

**Files:**
- Modify: `apps/desktop/e2e/wdio.conf.mjs`

- [ ] **Step 1: 加 `existsSync` import**

把顶部第 4 行（`import { spawn, spawnSync } from "node:child_process";`）后面新增一行：
```js
import { existsSync } from "node:fs";
```

- [ ] **Step 2: 在 config 里 `specs` 之后加 `suites`**

在 `specs: ["./specs/**/*.e2e.js"],` 这一行后面插入：
```js
  suites: {
    smoke: ["./specs/smoke/**/*.e2e.js"],
    ui: ["./specs/ui/**/*.e2e.js"],
    export: ["./specs/export/**/*.e2e.js"],
    audio: ["./specs/audio/**/*.e2e.js"],
    motif: ["./specs/motif/**/*.e2e.js"],
  },
```
（`specs` 保持不变 = 全量；`**` 已覆盖新子目录。）

- [ ] **Step 3: 给 onPrepare 包 build-skip guard**

把现有 `onPrepare` 整体替换为：
```js
  onPrepare: async () => {
    const mediaDir = process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "fixtures", "media");
    await ensureFixtures(mediaDir);
    // Opt-in fast path: reuse an already-built debug binary. Explicit only —
    // never auto-detect staleness (stale-binary trap). Default still rebuilds.
    if (process.env.WEFTCUT_E2E_NO_BUILD) {
      if (!existsSync(APP)) {
        throw new Error(
          `[e2e] WEFTCUT_E2E_NO_BUILD is set but the app binary is missing at ${APP} — run once without it to build first.`,
        );
      }
      console.log(`[e2e] WEFTCUT_E2E_NO_BUILD set — skipping tauri build, reusing ${APP}`);
      return;
    }
    const r = spawnSync(
      "npm",
      ["--prefix", "apps/desktop", "run", "tauri", "--", "build", "--debug", "--no-bundle"],
      { cwd: REPO, stdio: "inherit", shell: true, env: { ...process.env, VITE_WEFTCUT_E2E: "1" } },
    );
    if (r.status !== 0) throw new Error(`tauri build failed (${r.status})`);
  },
```

- [ ] **Step 4: 语法自检**

Run: `node --check apps/desktop/e2e/wdio.conf.mjs`
Expected: exit 0。

- [ ] **Step 5: Commit**

```
git add apps/desktop/e2e/wdio.conf.mjs
git commit -m "test(e2e): add suites config + opt-in WEFTCUT_E2E_NO_BUILD"
```

---

## Phase 2 — 按类别重组 + 合并 + 换 helper（每个 spec 只动一次）

> 通用规则（每个移动的 spec 都适用）：
> 1. 用 `git mv` 把文件移进子目录（保留 git 历史）。
> 2. 删掉文件内与共享 helper **重复**的本地定义（`waitForHook`/`invokeCmd`/`newProject`/`summary`/`findLayer`/`findTrackOf`/`sampleAt`/`waitPreviewBridge`/导出驱动函数），在顶部加对应 import。
> 3. 调用点改用 helper 的签名（见下，多数同名同形）。
> 4. 修正残留相对路径：移到 `specs/<cat>/` 后深度 +1，`"../lib/analyze.mjs"` → `"../../lib/analyze.mjs"`；本地自算的 `MEDIA_DIR`/`SOURCE`/`OUTPUT` 改用 `helpers/media.mjs` 的 `MEDIA_DIR`/`fixture()`/`tmpOut()`。
> 5. **不改任何 `it()` 标题、断言阈值、采样点、settings**——只换"怎么调"，不换"测什么"。
>
> helper 签名对照：本地 `sampleAt(tUs,x,y)` → `import { sampleAt } from "../../helpers/preview.mjs"`（同形）；本地导出轮询块 → `const r = await driveExport(args, { timeout, label }); const settled = r.done;`。

### Task 7: smoke — launch

**Files:**
- Move: `apps/desktop/e2e/specs/launch.e2e.js` → `apps/desktop/e2e/specs/smoke/launch.e2e.js`

- [ ] **Step 1: 移动文件**

```
git mv apps/desktop/e2e/specs/launch.e2e.js apps/desktop/e2e/specs/smoke/launch.e2e.js
```
（`launch.e2e.js` 不用任何 helper、无相对路径依赖，内容不改。）

- [ ] **Step 2: 一次性构建（之后各 suite 复用）**

Run（worktree 根）:
```
npm --prefix apps/desktop/e2e run e2e:smoke
```
Expected: 首次会 `tauri build --debug`（慢），随后启动 1 个 session，日志含 `Execution of 1 workers`，smoke 用例 PASS（1 passing）。

- [ ] **Step 3: 验证 build-skip 与 run-suite 管线**

Run（PowerShell；复用上一步构建好的二进制）:
```
$env:WEFTCUT_E2E_NO_BUILD=1; npm --prefix apps/desktop/e2e run e2e:smoke
```
Expected: 日志含 `WEFTCUT_E2E_NO_BUILD set — skipping tauri build`，**不**重新构建,smoke 仍 PASS。

> 之后所有验证步骤都在已设 `WEFTCUT_E2E_NO_BUILD=1` 的 PowerShell 会话里跑，避免每次重建。改了 Rust/前端源码时才 `Remove-Item Env:WEFTCUT_E2E_NO_BUILD` 重建一次。

- [ ] **Step 4: Commit**

```
git add apps/desktop/e2e/specs/smoke/launch.e2e.js
git commit -m "test(e2e): move launch into smoke suite"
```

### Task 8: ui — layers（合并 add_color_text_layer + image_support） + keyframe_authoring

**Files:**
- Create: `apps/desktop/e2e/specs/ui/layers.e2e.js`（合并）
- Move: `apps/desktop/e2e/specs/keyframe_authoring.e2e.js` → `apps/desktop/e2e/specs/ui/keyframe_authoring.e2e.js`
- Delete: `apps/desktop/e2e/specs/add_color_text_layer.e2e.js`, `apps/desktop/e2e/specs/image_support.e2e.js`

- [ ] **Step 1: 读两个来源 spec**

Read: `apps/desktop/e2e/specs/add_color_text_layer.e2e.js` 与 `apps/desktop/e2e/specs/image_support.e2e.js`，记下各自的 `describe`/`it` 块、常量、采样点。

- [ ] **Step 2: 写合并文件 `specs/ui/layers.e2e.js`**

结构：
```js
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { invokeCmd, newProject, summary, findLayer, findTrackOf } from "../../helpers/app.mjs";
import { sampleAt, waitPreviewBridge } from "../../helpers/preview.mjs";
import { MEDIA_DIR, fixture } from "../../helpers/media.mjs";

// ... 保留两份各自的常量（CANVAS / DEFAULT_DURATION_US / PROJECT_PARENT / 图片 fixture 列表等），
//     重名的合并为一份。

describe("add color & text layers (real WebView2)", function () {
  // ← add_color_text_layer.e2e.js 的 before + 4 个 it，原样照搬 it 体，
  //    把本地 newProject/invokeCmd/sampleAt/summary/findLayer/findTrackOf/waitPreviewBridge
  //    调用替换为 import 进来的同名 helper。本地这些函数定义全部删除。
  //    本地 newProject() 无参 → 改为 newProject({ parentFolder: PROJECT_PARENT, canvas: CANVAS })。
});

describe("still-image + gif media support (real WebView2)", function () {
  // ← image_support.e2e.js 的 before + it，同样换 helper；
  //    图片 fixture 路径用 fixture("xxx.png") 之类（原本自算 MEDIA_DIR 的改用导入的 MEDIA_DIR/fixture）。
});
```
要点：
- `add_color_text_layer` 里的本地 `newProject()` 用了固定 `PROJECT_PARENT`+`CANVAS`，合并后改成调用 `newProject({ parentFolder: PROJECT_PARENT, canvas: CANVAS })`（helper 形态）。
- 两个 `before()` 各自 `mkdirSync` 自己的临时目录，保留两个 `describe` 各一份。
- image_support 若直接 import `analyze` 或其它 `../lib/*`，路径改 `../../lib/*`。

- [ ] **Step 3: 移动 keyframe_authoring 并换 helper**

```
git mv apps/desktop/e2e/specs/keyframe_authoring.e2e.js apps/desktop/e2e/specs/ui/keyframe_authoring.e2e.js
```
然后在 `ui/keyframe_authoring.e2e.js` 里：换用 `helpers/app.mjs`（invokeCmd/newProject/waitForHook/summary…按其实际所用）、`helpers/export.mjs` 的 `driveExport`（把本地的 exportClip fire-and-forget + 轮询块替换为 `const r = await driveExport(args, {label:"keyframe"}); if (!r.done.ok) throw ...`）、`helpers/media.mjs`（MEDIA_DIR/输出路径）；`"../lib/..."` → `"../../lib/..."`。保留所有断言。

- [ ] **Step 4: 删除原文件**

```
git rm apps/desktop/e2e/specs/add_color_text_layer.e2e.js apps/desktop/e2e/specs/image_support.e2e.js
```

- [ ] **Step 5: 语法自检**

Run: `node --check apps/desktop/e2e/specs/ui/layers.e2e.js && node --check apps/desktop/e2e/specs/ui/keyframe_authoring.e2e.js`
Expected: exit 0。

- [ ] **Step 6: 跑 ui suite**

Run（已设 `WEFTCUT_E2E_NO_BUILD=1`）:
```
npm --prefix apps/desktop/e2e run e2e:ui
```
Expected: `Execution of 1 workers`（注意：ui 有 2 个文件 → wdio 会跑 2 个 session，日志是两段；这是预期）；用例总数 = add_color_text_layer(4) + image_support(1) + keyframe_authoring(1) = **6 passing**，全绿。

> ⚠️ 若 keyframe 的 `exportClip` 参数形态与 `driveExport(args)` 不吻合（它可能传非 `{mediaAbsPath,...}` 的 patch），以 keyframe 原始调用为准：`driveExport` 是把 `args` 原样转发，所以把 keyframe 原本传给 `exportClip(...)` 的对象整个作为 `args` 传入即可。

- [ ] **Step 7: Commit**

```
git add apps/desktop/e2e/specs/ui/
git add -A apps/desktop/e2e/specs/add_color_text_layer.e2e.js apps/desktop/e2e/specs/image_support.e2e.js apps/desktop/e2e/specs/keyframe_authoring.e2e.js
git commit -m "test(e2e): ui suite — merge add-layer+image into layers, move keyframe, use shared helpers"
```

### Task 9: audio — 合并 conformance + formats + envelope

**Files:**
- Create: `apps/desktop/e2e/specs/audio/audio.e2e.js`
- Delete: `apps/desktop/e2e/specs/audio_conformance.e2e.js`, `audio_formats.e2e.js`, `audio_envelope.e2e.js`

- [ ] **Step 1: 读三个来源 spec**

Read: `audio_conformance.e2e.js`、`audio_formats.e2e.js`、`audio_envelope.e2e.js`。三者都用 `exportClip` + 轮询 + `analyze`（音频 Goertzel）。记下各自的矩阵数据、`it` 标题、阈值、分析参数。

- [ ] **Step 2: 写合并文件 `specs/audio/audio.e2e.js`**

```js
import os from "node:os";
import path from "node:path";
import { /* mkdirSync 等按需 */ } from "node:fs";
import { newProject, invokeCmd } from "../../helpers/app.mjs";
import { driveExport } from "../../helpers/export.mjs";
import { MEDIA_DIR, fixture, tmpOut } from "../../helpers/media.mjs";
import { analyze } from "../../lib/analyze.mjs";

// 保留三份各自的矩阵常量与分析参数（重名合并）。

describe("audio conformance matrix (real WebView2)", function () { /* 照搬 */ });
describe("audio-only format matrix (real WebView2)", function () { /* 照搬 */ });
describe("audio envelope conformance (real WebView2)", function () { /* 照搬 */ });
```
要点：
- 每个原 spec 里的"等 exportClip hook + fire-and-forget + 轮询"整块 → `const r = await driveExport(args, { label }); if (!r.done.ok) throw new Error(...)`，保留原错误信息中的 kind/detail（用 `r.lastKind`/`r.lastDetail`）。
- `analyze` import 路径 `../../lib/analyze.mjs`。
- `SOURCE`/`OUTPUT` 改用 `fixture(...)`/`tmpOut(...)`。
- 三个 `describe` 各保留自己的 `before()`(若有 SKIP-on-missing-source 逻辑，保留)。

- [ ] **Step 3: 删原文件**

```
git rm apps/desktop/e2e/specs/audio_conformance.e2e.js apps/desktop/e2e/specs/audio_formats.e2e.js apps/desktop/e2e/specs/audio_envelope.e2e.js
```

- [ ] **Step 4: 语法自检**

Run: `node --check apps/desktop/e2e/specs/audio/audio.e2e.js`
Expected: exit 0。

- [ ] **Step 5: 跑 audio suite**

Run:
```
npm --prefix apps/desktop/e2e run e2e:audio
```
Expected: `Execution of 1 workers`（audio 仅 1 文件 → 1 session）；用例数 = 三个矩阵 + envelope 的 4 个之和，全绿。

> ⚠️ 三合一后所有音频导出共享一个 session。若出现连带失败/flaky，按设计回退：把 `audio_envelope` 的 describe 拆回 `specs/audio/envelope.e2e.js`（仍在 audio suite）。

- [ ] **Step 6: Commit**

```
git add apps/desktop/e2e/specs/audio/
git add -A apps/desktop/e2e/specs/audio_conformance.e2e.js apps/desktop/e2e/specs/audio_formats.e2e.js apps/desktop/e2e/specs/audio_envelope.e2e.js
git commit -m "test(e2e): audio suite — merge conformance+formats+envelope, use shared helpers"
```

### Task 10: motif — capture / state 合并 + export / prebake 移动

**Files:**
- Create: `apps/desktop/e2e/specs/motif/capture.e2e.js`（merge capture + lower_third + live_preview）
- Create: `apps/desktop/e2e/specs/motif/state.e2e.js`（merge staleness + bake_status + filewatch）
- Move: `motif_export.e2e.js` → `specs/motif/export.e2e.js`；`motif_prebake.e2e.js` → `specs/motif/prebake.e2e.js`
- Delete: `motif_capture/lower_third/live_preview/staleness/bake_status/filewatch.e2e.js`

- [ ] **Step 1: 读 8 个 motif spec**

Read 全部 8 个 `motif_*.e2e.js`，归类：
- capture 组（capture / lower_third / live_preview）：抓帧/渲染，无导出。
- state 组（staleness / bake_status / filewatch）：轻量 UI/状态。
- 独立：export（真实导出）、prebake（磁盘 GC 副作用，3 个 it）。

- [ ] **Step 2: 写 `specs/motif/capture.e2e.js`**

把 capture / lower_third / live_preview 三个 `describe` 并入一个文件；本地的 `invokeCmd`/`newProject`/`waitForHook`/采样等替换为 `helpers/*` import；motif fixture/路径用 `helpers/media.mjs`；`../lib/*` → `../../lib/*`。保留每个 `it` 的标题、采样坐标、像素/容差断言原样。

- [ ] **Step 3: 写 `specs/motif/state.e2e.js`**

把 staleness / bake_status / filewatch 三个 `describe` 并入；同样换 helper、修路径。保留断言。

- [ ] **Step 4: 移动 export / prebake 并换 helper**

```
git mv apps/desktop/e2e/specs/motif_export.e2e.js apps/desktop/e2e/specs/motif/export.e2e.js
git mv apps/desktop/e2e/specs/motif_prebake.e2e.js apps/desktop/e2e/specs/motif/prebake.e2e.js
```
两文件内：`motif/export.e2e.js` 的导出轮询块换成 `driveExport`；`prebake` 的本地 app/preview helper 换成 import；两者 `../lib/*` → `../../lib/*`，路径用 `helpers/media.mjs`。保留断言（含 prebake 的磁盘 PNG/GC 检查）。

- [ ] **Step 5: 删 6 个原文件**

```
git rm apps/desktop/e2e/specs/motif_capture.e2e.js apps/desktop/e2e/specs/motif_lower_third.e2e.js apps/desktop/e2e/specs/motif_live_preview.e2e.js apps/desktop/e2e/specs/motif_staleness.e2e.js apps/desktop/e2e/specs/motif_bake_status.e2e.js apps/desktop/e2e/specs/motif_filewatch.e2e.js
```

- [ ] **Step 6: 语法自检**

Run: `node --check apps/desktop/e2e/specs/motif/capture.e2e.js && node --check apps/desktop/e2e/specs/motif/state.e2e.js && node --check apps/desktop/e2e/specs/motif/export.e2e.js && node --check apps/desktop/e2e/specs/motif/prebake.e2e.js`
Expected: exit 0。

- [ ] **Step 7: 跑 motif suite**

Run:
```
npm --prefix apps/desktop/e2e run e2e:motif
```
Expected: 4 个文件 → 4 session；用例总数 = 8 个原 spec 的 it 之和（capture 3 + lower_third 4 + live_preview 1 + staleness 1 + bake_status 1 + filewatch 1 + export 1 + prebake 3 = **15 passing**），全绿。

- [ ] **Step 8: Commit**

```
git add apps/desktop/e2e/specs/motif/
git add -A apps/desktop/e2e/specs/motif_capture.e2e.js apps/desktop/e2e/specs/motif_lower_third.e2e.js apps/desktop/e2e/specs/motif_live_preview.e2e.js apps/desktop/e2e/specs/motif_staleness.e2e.js apps/desktop/e2e/specs/motif_bake_status.e2e.js apps/desktop/e2e/specs/motif_filewatch.e2e.js
git commit -m "test(e2e): motif suite — merge capture/state, move export/prebake, use shared helpers"
```

### Task 11: export — 7 个文件移入子目录 + 换 helper（保持 1:1）

**Files:**
- Move（各自）：`conformance.e2e.js`, `color_conformance.e2e.js`, `export_10bit.e2e.js`, `export_range_audio.e2e.js`, `export_overlap_same_source.e2e.js`, `export_eos_tail.e2e.js`, `export_content_modes.e2e.js` → `specs/export/`

- [ ] **Step 1: 逐个 git mv**

```
git mv apps/desktop/e2e/specs/conformance.e2e.js apps/desktop/e2e/specs/export/conformance.e2e.js
git mv apps/desktop/e2e/specs/color_conformance.e2e.js apps/desktop/e2e/specs/export/color_conformance.e2e.js
git mv apps/desktop/e2e/specs/export_10bit.e2e.js apps/desktop/e2e/specs/export/export_10bit.e2e.js
git mv apps/desktop/e2e/specs/export_range_audio.e2e.js apps/desktop/e2e/specs/export/export_range_audio.e2e.js
git mv apps/desktop/e2e/specs/export_overlap_same_source.e2e.js apps/desktop/e2e/specs/export/export_overlap_same_source.e2e.js
git mv apps/desktop/e2e/specs/export_eos_tail.e2e.js apps/desktop/e2e/specs/export/export_eos_tail.e2e.js
git mv apps/desktop/e2e/specs/export_content_modes.e2e.js apps/desktop/e2e/specs/export/export_content_modes.e2e.js
```

- [ ] **Step 2: 每个文件换 helper + 修路径**

对 7 个文件逐一：
- `"../lib/analyze.mjs"` → `"../../lib/analyze.mjs"`。
- 本地 `MEDIA_DIR`/`SOURCE`/`OUTPUT` 自算 → import `helpers/media.mjs` 的 `MEDIA_DIR`/`fixture()`/`tmpOut()`。
- 导出"等 hook + fire-and-forget + 轮询"整块 → `driveExport`。注意调用方语义：
  - 期望成功（conformance/color/10bit/eos/overlap/range_audio）：`const r = await driveExport(args, {label}); if (!r.done.ok) throw new Error("exportClip failed: " + r.done.error);`
  - content_modes 的 `runExportClip` 改为内部调用 `driveExport`，返回 `{ done: r.done, kind: r.lastKind }`，三个 `it` 的 `done.ok===false` 断言不变。
- app/preview 本地 helper（若有）→ import。
- **不改** samples/SSIM 阈值/range 参数/keyframe interval 断言等。

- [ ] **Step 3: 语法自检（全部）**

Run: `for f in conformance color_conformance export_10bit export_range_audio export_overlap_same_source export_eos_tail export_content_modes; do node --check apps/desktop/e2e/specs/export/$f.e2e.js || echo "FAIL $f"; done`
Expected: 无 `FAIL`。

- [ ] **Step 4: 跑 export suite（慢，重 pipeline）**

Run:
```
npm --prefix apps/desktop/e2e run e2e:export
```
Expected: 7 文件 → 7 session；用例数 = 7 spec 的 it 之和（content_modes 3 + 10bit 4 + color 4 + range_audio 6 + overlap 3 + eos 1 + conformance 1 = **22 passing**），全绿。逐帧日志正常推进，无 stall。

- [ ] **Step 5: Commit**

```
git add apps/desktop/e2e/specs/export/
git commit -m "test(e2e): export suite — move 7 specs into subdir, use shared helpers (kept 1:1)"
```

---

## Phase 3 — 全量等价 + 收尾

### Task 12: 全量验证 + 用例计数 + 清理

- [ ] **Step 1: 确认 specs/ 根目录已清空（全部进了子目录）**

Run: `node -e "const g=require('fs').readdirSync('apps/desktop/e2e/specs'); console.log(g)"`
Expected: 仅 `['audio','export','motif','smoke','ui']`（无散落的 `*.e2e.js`）。

- [ ] **Step 2: 全量跑（等价性）**

Run（已设 `WEFTCUT_E2E_NO_BUILD=1`）:
```
npm --prefix apps/desktop/e2e run e2e
```
Expected: 15 文件 → 15 session；**总用例数 = 1 + 6 + 22 + (三矩阵+4) + 15** 与改造前 22 个 spec 的总 it 数一致；全绿。

- [ ] **Step 3: 确认 `tools/` 未被纳入**

Run: `node -e "const c=require('fs').readFileSync('apps/desktop/e2e/wdio.conf.mjs','utf8'); console.log(c.includes('tools')?'REFERENCES tools (BAD)':'tools not referenced (OK)')"`
Expected: `tools not referenced (OK)`。

- [ ] **Step 4: 更新 e2e 文档/README（若存在）**

若 `apps/desktop/e2e/` 下有 README 或 `docs/` 提到运行方式，新增 suite 用法说明：`npm run e2e:<smoke|ui|export|audio|motif>` 与 `WEFTCUT_E2E_NO_BUILD=1` 复用构建。无则跳过（不新建）。

- [ ] **Step 5: 最终 Commit（若 Step 4 有改动）**

```
git add <改动的文档路径>
git commit -m "docs(e2e): document suite runners + build-skip"
```

---

## Self-Review（计划对照 spec）

- **5 类 suite** → Task 6（config）+ Task 7–11（各类落子目录）。✓
- **22→15 平衡合并**（export 1:1 保留）→ Task 8/9/10 合并，Task 11 export 仅移动。✓
- **共享 helper 消重** → Task 1–4 + 各 Task 的换 helper 步骤。✓
- **wdio suites + Windows 安全运行** → Task 5（run-suite.mjs）+ Task 6（suites）。✓
- **opt-in 跳过构建 + 二进制缺失报错** → Task 6 Step 3，Task 7 Step 3 验证。✓
- **不动 tools/** → Task 12 Step 3 显式断言。✓
- **每 it 仍 newProject 隔离、用例数不减** → 各换 helper 步骤明确"不改测什么" + Task 12 Step 2 计数。✓
- **audio flaky 回退** → Task 9 Step 5 备注。✓
- **并行会话/按路径暂存** → 前置说明 + 各 Task 显式 `git add <path>`。✓

类型/签名一致性：`driveExport(args,{timeout,label}) → {done,lastFrame,lastKind,lastDetail}`、`newProject({parentFolder,name,canvas})`、`sampleAt(tUs,x,y,settleMs?)`、`MEDIA_DIR`/`fixture()`/`tmpOut()` 在 Task 1–4 定义，Task 7–11 一致引用。✓
