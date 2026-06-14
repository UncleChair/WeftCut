# E2E 套件分类与提速 — 设计

工作分支：`e2e-suite-categories`（worktree `videtor-wt1`，基于 main `4a16fe46`）。

## 背景与问题

`apps/desktop/e2e/` 目前有 **22 个 spec 文件**（外加 `tools/` 下约 12 个诊断探针，不默认运行）。痛点：

1. **全量太慢**。wdio 把**每个 spec 文件当作独立 worker + session**串行运行，每个文件都会完整重启 app（`tauri-driver` 进程树 + WebView2 启动 + `beforeSession`/`afterSession` 里的端口释放等待）。真正的时间大头是重 pipeline spec 里的**真实导出 + 分析**（10bit / range_audio / overlap / eos / conformance / color / audio×3 / motif×8），每个都带 180s 超时。
2. **无法选择性运行**。开发某一块功能时也得把无关的重导出测试全跑一遍。
3. **`onPrepare` 每次都做完整 `tauri build --debug`**，本地反复跑时这往往是最大的等待。
4. **helper 重复**。`invokeCmd` / `newProject` / `waitForHook` / 导出驱动等在 21 个 spec 里各写一份（127 处）。

## 目标

- **本地提速**：按类别选择性运行，只跑相关那块。
- **全量提速**：合并安全用例减少重启开销 + 抽公共 helper。
- **不削减任何领域覆盖**。"合并基础内容"= 抽公共 setup，不是砍测试。

## 非目标

- 不开 `maxInstances` 并行（`DRIVER_PORT` 硬编码 4444 + 单 app + WebView2，并行需改端口分配，风险大）→ 列为未来项。
- 不动 `tools/` 诊断探针（不进 suites、不默认运行，保持现状）。
- 不改任何产品代码、不改被测行为。

## 五个类别 → 目录结构

类别同时也是速度梯度（UI 快，export/audio/motif 慢）。把 `specs/` 按类别分子目录：

```
apps/desktop/e2e/specs/
  smoke/    launch
  ui/       layers, keyframe_authoring
  export/   conformance, color_conformance, export_10bit, export_range_audio,
            export_overlap_same_source, export_eos_tail, export_content_modes
  audio/    audio
  motif/    capture, state, export, prebake
```

## 文件合并映射（平衡策略）

规则：**便宜/安全的合并；有死锁史的重 export 保持独立**（卡死不波及别人、定位清晰）。

| 类别 | 合并后文件 | 来源 spec | 说明 |
|---|---|---|---|
| smoke | `smoke/launch.e2e.js` | launch | 不变，几乎瞬完 |
| ui | `ui/layers.e2e.js` | add_color_text_layer + image_support | 都只走预览/渲染，无导出，卡死风险低 |
| ui | `ui/keyframe_authoring.e2e.js` | keyframe_authoring | 独立保留（跑真实导出） |
| export | 7 个文件**全部 1:1 不合并** | conformance / color_conformance / export_10bit / export_range_audio / export_overlap_same_source / export_eos_tail / export_content_modes | 死锁高发，独立才能精准定位；提速靠"整类跳过"而非合并 |
| audio | `audio/audio.e2e.js` | audio_conformance + audio_formats + audio_envelope | 分析型导出，卡死风险低于视频编解码边角；⚠️ 若将来 flaky，把 envelope 拆出去 |
| motif | `motif/capture.e2e.js` | motif_capture + motif_lower_third + motif_live_preview | 纯抓帧/渲染，无导出 |
| motif | `motif/state.e2e.js` | motif_staleness + motif_bake_status + motif_filewatch | 轻量 UI/状态 |
| motif | `motif/export.e2e.js` | motif_export | 独立（导出） |
| motif | `motif/prebake.e2e.js` | motif_prebake | 独立（磁盘 GC 副作用） |

**22 → 15 文件。** Session 数 22 → 15。export 这块刻意几乎不合——它的提速靠选择性跳过。

合并不变量：每个 `it` 仍各自 `newProject` 隔离；合并文件内不共享可变项目状态。

## 共享 helper（消除 127 处重复）

新建 `apps/desktop/e2e/helpers/`：

- `app.mjs` — `waitForHook` / `invokeCmd`（走 `window.__TAURI__.core.invoke`）/ `newProject` / `summary` / `findLayer` / `findTrackOf`
- `preview.mjs` — `seekUs` / `sampleComposite` / `waitPreviewBridge`
- `export.mjs` — 驱动导出（fire-and-forget）+ 轮询 `window.__weftcutExportState.progress.frame` + 等完成
- `media.mjs` — `MEDIA_DIR`（尊重 `WEFTCUT_TEST_MEDIA`）/ fixture 路径 / tmp 输出路径

helper 是 node 侧模块，内部包裹 `browser.execute*`（`browser` 是 wdio 注入的全局，import 的模块可直接引用）。`lib/analyze.mjs` 保留不动。各 spec 改为 import，不再各写一份。

## 运行机制（wdio suites + Windows 安全调用）

- `wdio.conf.mjs` 加 `suites: { smoke, ui, export, audio, motif }`；默认 `specs` 仍指向全部（`./specs/**/*.e2e.js`，子目录自然纳入）。
- 新建 `scripts/run-suite.mjs <suite>`：内部 `spawn(process.execPath, ["node_modules/@wdio/cli/bin/wdio.js","run","wdio.conf.mjs","--suite",suite])`，**绕开 npm/PowerShell 吞 `--` 的坑**（见 `feedback_wdio_spec_filter_windows`），并在调用前确认只起 1 个 worker。未知 suite 名直接报错。
- `package.json` 加脚本：`e2e`（全量）、`e2e:smoke`、`e2e:ui`、`e2e:export`、`e2e:audio`、`e2e:motif`，各自 `node scripts/run-suite.mjs <suite>`（drivers 抓取仍前置）。

## 构建跳过（显式 opt-in）

- `onPrepare` 包一层：`if (!process.env.WEFTCUT_E2E_NO_BUILD) { …build… }`。
- 跳过分支里**断言二进制存在**（`apps/desktop/src-tauri/target/debug/weftcut.exe`），不存在直接报错，杜绝跑空/旧二进制。
- 默认仍重建（CI 安全）。本地用法：`$env:WEFTCUT_E2E_NO_BUILD=1; npm run e2e:ui`（先正常跑一次建好，之后反复跑各类不再重建）。
- 不做"自动判断二进制是否过期"——会踩 stale-binary 坑，责任显式交给开发者。

## 验证标准

- 每个 suite 单独可跑通，且日志确认"Execution of 1 workers"。
- 全量 `npm run e2e` 行为等价于现状（同样的测试、同样的断言全部执行）。
- `WEFTCUT_E2E_NO_BUILD=1` 二次运行确实跳过 `tauri build`；二进制缺失时报错而非静默跑空。
- 合并后的文件里每个 `it` 仍各自 `newProject` 隔离，互不串味。
- 合并文件的总用例数 = 来源 spec 用例数之和（无丢失）。

## 风险与回退

- **合并文件内连带失败**：某用例把 app 卡死会拖垮同文件后续用例。已用平衡策略把死锁高发的 export 全部隔离；audio 三合一是唯一略激进点，flaky 时拆 envelope。
- **并行会话/worktree**：main 正被其他会话推进（已观察到 4a16fe46）。本分支只动 `apps/desktop/e2e/` 与新增 `docs/` spec，按路径精确暂存，提交前重查 status（见 `feedback_parallel_sessions_git`）。
