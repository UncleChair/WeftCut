# WebCodecs 跨平台尾帧、flush 与时间基调查

**记录日期：** 2026-07-22

> **Postscript 2026-07-23 (the Linux tail issue is closed):** both obstacles
> this note recorded — "this host cannot create a VideoEncoder" and "the full
> export never ran" — are resolved. (a) The blocker was the export's
> unconditional `prefer-hardware` request for H.264: Chromium treats the hint
> as mandatory and Linux has no WebCodecs hardware encoder at all (a
> codec-matrix boundary), platform-gated in `bfd0e0ee`. (b) On current main, Gate B's
> output encode is native-first anyway and no longer touches VideoEncoder.
> On the original Linux/RTX 3050 host: Gate B then passed ten sequential runs
> 10/10 (300 frames on both legs, every sample aligned, byte-identical
> measurements run to run), and a wider 9-case matrix passed 9/9 (24/25/50/60,
> 30000/1001, 60000/1001, non-zero start PTS 3.2 s, B-frame + edit-list
> input, and a range ending mid-frame). The historical `N→N+1` is judged
> **not reproducible on current main** (no retained artifacts, so this is
> closure by non-reproduction; likely fixes: the `56f09adf` REORDER_MARGIN
> lead-in plus the ExportFrameStore duration-eviction/identity rework).
> Gate B's Linux skip was removed in `49b7f57e` and the tracker thread is
> closed. VFR remains uncovered — the analyzer and composition grid assume
> CFR, so VFR alignment needs its own verdict semantics first. The rest of
> this document is kept as the historical record of the investigation.

**范围：** Linux 尾部 `source + 1`、macOS 解码尾部滞留、Linux 硬件帧黑屏，以及三者是否源自同一个设计问题。

本文用三种标签区分证据强度：

- **[直接证据]** 规范、上游源码、仓库代码、提交或本机探针直接证明的事实。
- **[相似案例]** 上游出现过相似症状，但没有证据表明与 WeftCut 根因相同。
- **[推断]** 由现有证据得到、仍需用失败产物或日志验证的判断。

## 结论先行

1. **Linux“尾帧 +1”不是“多导出了一帧”。** 它指的是尾部某个输出样本 `output[N]` 的画面，经 SSIM 搜索后最佳匹配 `source[N+1]`；也就是输出时间格标成 N，像素内容却来自后一帧。历史失败没有保留样本 JSON、PTS 日志或媒体产物。2026-07-22 在当前 Linux/Electron 42.4.1 上补做的生产 decoder/ring 探针连续 10 次没有 logical frame-index mismatch，当前 full proxy 直接对原片的 5 个 gate 样本也全部对齐；但该主机无法创建 VideoEncoder，完整导出仍未跑通。因此它现在是**历史观察、当前未完整复现**，不能把根因写成既定事实。

2. **三个平台现象不是同一个 bug。**

   - macOS：解码器在输入窗口尾部保留 2 帧（有 B 帧时观察到 4 帧），`decodeQueueSize === 0` 但输出尚未齐；这是平台解码延迟暴露了 WeftCut 对“输入已接收 = 输出已完成”的错误假设。
   - Linux 硬件帧黑屏：本机探针中硬件 BGRA 帧通过 `drawImage`、`createImageBitmap`、WebGL 和 `copyTo()` 均为纯黑，而软件 I420 全部正确；这是 Chromium/驱动/硬件帧 backing 的平台边界，不能用时间基设计解释。
   - Linux 尾帧 +1：当前 decoder/ring 与 proxy-before-export 两阶段都未复现整帧错位；若换到有可用 VideoEncoder 的 Linux 设备后仍能复现，再按完整导出下游、历史 clamp/时序和时间基边界依次缩小范围。“只在 Linux 被看见”不足以证明 Linux 解码器改错了 PTS。

3. **macOS workaround 的判断方向正确，但实现是经验上界，不是协议级证明。** WebCodecs 明确允许内部 pending output 只在后续输入到来时输出，只有 `flush()` 必须排空；`decodeQueueSize` 只表示待解码请求，不表示待输出帧。给窗口多喂 `REORDER_MARGIN = 16` 个包能推动已观察到的 H.264 尾部滞留，并已修复该测试，但 `16` 不是 WebCodecs 对所有 codec/backend 的完成保证。

4. **跨平台差异有平台成分，也有设计责任。** Chromium 在 Linux、macOS、Windows 会选择不同软件/硬件 backend、帧池和内存 backing；延迟、池容量和可读性确实可能不同。应用仍须只依赖 WebCodecs 保证的契约：按 PTS 选帧、显式 EOS drain、有限背压、及时 `close()`，并在硬件帧不可用时降级。当前自定义的“有限 GOP 调度 + ring + clamp”把这些复杂度留在了 WeftCut 内部。

5. **后续实现审计发现并修复了一个能确定产生 `N→N+1` 的 ring 漏洞，但它仍不是历史 Linux 失败根因的证明。** 旧 `evictBefore()` 按 `pts + duration <= target` 删除帧；当独立量化的 duration 在两个 PTS 间留下 1µs gap 时，它会先删掉最大 `PTS <= target` 的 lower neighbour，随后 `frameAt()` 只能返回 future frame。回归测试已用 `PTS=66,666 / next=100,000 / target=99,999` 固化该错误形状。当前实现改为始终保留 lower neighbour、按最大 `PTS <= target` 选帧，并仅在 exact PTS、收到严格更晚 PTS或 EOS 后确认身份。历史失败缺少 PTS 产物，不能倒推它必然走过同一分支。

## Linux 尾帧 +1 到底是什么

**[直接证据]** `export-prores-fidelity.spec.ts` 对同一 10 秒、30 fps 时间线做两次 300 帧导出：

- native leg：直接从 ProRes 原片经 native/FFmpeg decoder 导出；
- proxy leg：先由 FFmpeg 生成全尺寸 H.264 proxy，再由 Mediabunny + WebCodecs 解码并导出。

分析器针对输出样本 N，在源文件的 `N ± window` 中逐帧做 SSIM，烧录的帧计数器让相邻帧可区分。历史注释记录的是 proxy leg 尾部样本最佳匹配 `N+1`，而 native leg 正常。因此准确描述是：

> Lite/WebCodecs 代理链的尾部存在一次已观察到、尚未重新固化的“内容索引领先输出格一帧”。

历史证据不能回答：具体哪个 N、是否每次复现、以及 `56f09adf` 之后是否仍存在。旧记录 `linux-lite-export-off-by-one-tail.md` 本身也将这些列为未知项。

### 2026-07-22 当前 Linux 诊断

临时诊断绕开不可用的 VideoEncoder，在独立 diagnostic Worker 中直接实例化生产 `ExportSourceHandle`，用 60-frame chunk 走与导出一致的 `decodeRange()`、`waitForPts()`、`frameAt()` 和 `evictBefore()`：

- **[直接证据]** 300 帧完整跑完 10 次；每次 `dispatchedTotal = 300`，300 个 target 全部得到 frame，按 `round(selectedTimestampUs * 30 / 1e6)` 映射后 index mismatch 均为 0。
- **[直接证据]** 每次都有 100 帧出现稳定的 `selectedTimestampUs - targetUs = -1µs`，即每第三个 30 fps 格点的 rational→integer 量化差。尾帧 `i=299` 的 target 是 `9,966,667µs`，实际选中 PTS `9,966,666µs`，两者仍属于 logical frame 299。
- **[直接证据]** 将生成出的 full proxy 在进入 WebCodecs/export 之前直接交给 `media_conformance`，样本 `[30, 90, 150, 210, 285]` 分别最佳匹配原片同 index，全部 aligned。
- **[限制]** 该容器报 `No available adapters` / VideoEncoder creation error，所以没有覆盖 composite capture → VideoEncoder → mux → 最终输出分析这一段。PTS 探针证明的是 ring 选中的 timestamp index，不是最终编码文件的像素 identity。

**[判断]** 当前证据已排除“这份 full proxy 在 gate 样本处本身提前一帧”，也排除“当前主机上生产 decoder/ring 稳定选择相邻 PTS index”。它同时证明 1µs 量化差真实存在，但在这份 30 fps 素材上**没有变成整帧 +1**。历史问题可能已经被后续调度修复，也可能只存在于尚未覆盖的完整输出段；现在还不能关闭问题。

**[推断]** 若换设备后的完整导出在相同尾部位置稳定 `+1`，优先检查 capture/encode/mux 是否发生 drop/duplicate，并把该机的生产 ring PTS 探针并排运行；若 ring 结果本身随运行变化，才更像 decoder 输出时序触发了 clamp/evict race。

## WebCodecs 实际保证什么

以下均来自 [WebCodecs 规范](https://www.w3.org/TR/webcodecs/)：

- **[直接证据] pending output 合法存在。** 底层 codec 可以只在收到新输入时才继续产生输出，但响应 `flush()` 时必须交付全部内部 pending output。
- **[直接证据] `decodeQueueSize` 不是输出计数。** 它是待处理 decode request 的数量；底层 codec 一旦准备接收输入，该值就会减少。规范算法甚至先减少 queue size，再异步执行实际 decode 和 output callback。因此 `queue === 0` 不能证明输出已齐。
- **[直接证据] 输出必须是 presentation order。** 底层 codec 若以其他顺序产出，User Agent 必须重排。
- **[直接证据] `VideoFrame.timestamp` 和 `duration` 复制自对应的 `EncodedVideoChunk`。** 所以在输入 chunks 完全相同且实现遵守规范时，平台可以改变“何时输出”，不应把帧的 presentation PTS 改成相邻帧。
- **[直接证据] `flush()` 是一个边界操作。** 它要求排空所有 pending output，同时要求下一次 decode 从 key chunk 开始。这解释了为什么不能把 mid-range flush 当作无状态的“等一下输出”。
- **[直接证据] `VideoFrame` 持有 codec 资源。** 规范明确警告不及时 `close()` 可能令解码停滞；CPU/GPU 内存和硬件 handle 也可能快速耗尽。

这使 macOS 日志“61 包已喂、59 帧已出、queue 0、无 error”完全符合规范允许的内部延迟，而不是 `decodeQueueSize` 失真。

## 对 macOS 修复的复核

提交 [`56f09adf`](https://github.com/UncleChair/WeftCut/commit/56f09adf41c80b7e38da01221402ecf2039deb7b) 把 `REORDER_MARGIN = 16` 的额外输入从部分 lane 推广到全部 Lite decode lane。

**[直接证据] 修复与观察到的故障链一致：**

1. `decodeRange()` 只喂到当前范围/下一个 key 边界；
2. macOS software H.264 decoder 保留窗口尾部输出；
3. consumer 在 `waitForPts()` 等待被保留帧；
4. 继续喂真实输入会推动 pending output，因此额外 lead-in 打破等待。

**[判断]** 对当前 H.264 proxy 和已观察到的 2/4 帧延迟，这个 workaround 是正确且低风险的；它不会改写输入 chunk 的 PTS，后续范围也从 cursor 继续，因此按设计不会重复喂包。

**[限制]** `REORDER_MARGIN = 16` 是 codec/backend 经验策略。WebCodecs 没有承诺“最多保留 16 个输入”，其他 codec、线程流水线或未来 Chromium backend 也未必服从这个边界。真正应长期守住的是“无论输出延迟多少，调度器都有明确的 forward-progress/EOS 不变量”，而不是把 `16` 当作输出完成信号。

当前 `issueEosFlush()` 的方向是合理的：只在真 EOS flush，并让 flush 与 consumer 释放 frame-pool slot 并行；直接在 `decodeRange()` 中等待 flush，可能形成“flush 等空槽、consumer 因被阻塞无法 `close()`”的循环等待。

当前 full proxy recipe 明确使用 `-bf 0`，所以本 gate 的 proxy 不含 B 帧；macOS 仍观察到 2 帧 hold-back，说明底层流水线即使没有 B 帧也可以保留 pending output。此前“有 B 帧时 4 帧”的观察来自同一调度器覆盖的另一类流，不能反过来把本问题归因于 proxy 的 B 帧重排。

## Linux 硬件黑帧不是尾帧 +1

提交 [`3e677dd2`](https://github.com/UncleChair/WeftCut/commit/3e677dd2824ee02cba468528244c8834c981b054) 记录了同一 Linux/NVIDIA 主机上的隔离探针（结论同时归档在 codec-matrix 的 tracker 讨论里）：

- **[直接证据]** software I420 在 Window/Worker 以及四条导入/回读路径都正常；
- **[直接证据]** hardware BGRA 在四条路径都读成纯黑，包括 `VideoFrame.copyTo()`；
- **[直接证据]** 因此它既不是 OffscreenCanvas 特有问题，也不是 Worker transfer 特有问题。

Chromium 的 [VideoDecoder broker 源码](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webcodecs/video_decoder_broker.cc) 也直接显示 `prefer-software` 会排除 external/platform decoder，其他偏好则可能选择不同 decoder factory；Chromium 的 [decoder 类型列表](https://chromium.googlesource.com/chromium/src/+/main/media/base/decoder.h) 同时包含 FFmpeg、VA-API/V4L2/OOP Linux、D3D11、MediaCodec 和 VideoToolbox 等实现。

**[判断]** 在该设备上 pin `preferSoftware` 是正确的 correctness fallback。有效的非黑输入经公开读取路径无错误地变成全黑，更接近 Chromium/驱动互操作缺陷，而不是 WeftCut PTS 设计导致。应用层的设计责任是探测/降级和资源释放，不是“修正”硬件帧像素。

## 时间模型中已确认并修复的风险

当前 proxy leg 跨越了至少五个时间域：

1. FFmpeg/container 的整数 PTS + rational time base；
2. Mediabunny `EncodedPacket.timestamp` 的 JavaScript 秒数；
3. WebCodecs `EncodedVideoChunk` / `VideoFrame` 的整数微秒；
4. WeftCut normalized source-content 微秒；
5. composition 的 rational frame grid。

**[直接证据] 调查时存在两类风险：**

- Mediabunny 1.45.4 的 `EncodedPacket.microsecondTimestamp` 与 duration 用 `Math.trunc(seconds * 1e6)`，`toEncodedVideoChunk()` 将该值交给 WebCodecs；
- WeftCut 旧 `packetToSourceUs()` 却用 `Math.round(seconds * 1e6)` 判断 seek/dispatch 边界，导致同一首 packet 在非零起点可被调度成 source `0µs`、却由 decoder 输出为 `-1µs`；
- composition grid 用 `Math.round(i * 1e6 * fpsDen / fpsNum)`；
- `ExportFrameStore` 旧 eviction 以独立量化后的 PTS/duration 做半开区间删除，能在间隙中先删掉 lower neighbour，再让 `frameAt` 返回 future frame；
- export worker 的尾部 eviction 还包含 `srcBUs + 1` 这样的微秒哨兵。

一微秒差异本身不等于一帧偏移；但当它落在半开区间、seek key、eviction 或 EOS clamp 的判定边界上，确实可能改变所选相邻帧。WHATWG 的 [rational seek issue #609](https://github.com/whatwg/html/issues/609) 记录了同类基本问题：JS 浮点秒换算到媒体容器 rational integer 后，精确帧 seek 可能落到前一帧末尾；其 29.97 fps 例子建议保留 rational time。**这是同一问题类别的直接先例，不是 WeftCut +1 根因的证明。**

**[直接证据 + 限定]** 30 fps 探针把 composition target 与 decoder PTS 的量化差量出来：100/300 帧是 `-1µs`，但 10 次运行都没有 logical index mismatch。两种时钟允许有 1µs 数值差；真正的问题是旧代码让同一 source packet 在 dispatch 与 decoder output 中使用不同值，并让 duration/eviction 隐式改变帧身份。

**[已实施]** WebCodecs preview/export 现由一个 `DecodeClock` 模块拥有 container↔source 换算：origin 使用 Mediabunny 的 `microsecondTimestamp`，dispatch frontier 来自实际 `EncodedVideoChunk.timestamp`。`ExportFrameStore` 的身份规则改为最大 `PTS <= target`，eviction 始终保留该 lower neighbour，readiness 只由 exact PTS、严格更晚 PTS或 EOS 证明。native SW/GPU adapter 收敛到一个 Rust `media_time` 模块；TS/Rust 共用 golden vectors，覆盖非零/负 PTS、24、30、29.97 与 59.94。仍未消除的是 Mediabunny 在公开 packet interface 前已经把 container tick/timebase 转为 JavaScript 秒数这一长期精度边界。

FFmpeg 自身为此提供 [`av_rescale_q*` 和 `av_add_stable`](https://www.ffmpeg.org/doxygen/trunk/group__lavu__math.html)：前者在整数 rational time base 间按明确规则换算，后者专门保证重复累加不积累舍入误差。FFmpeg [`fps` filter 文档](https://ffmpeg.org/ffmpeg-filters.html#fps) 还把 PTS rounding 和 `eof_action` 暴露为显式策略，说明 EOF 最后一帧选择本来就依赖统一的量化约定。

**[推断]** 按当前新证据，后续排查顺序应调整为：

1. **先确认完整问题是否仍存在。** 当前 main 的 proxy 样本和 decoder/ring PTS 均正常；历史 issue 可能已被 `REORDER_MARGIN` 或其后的调度改动间接消除。
2. **若完整输出失败但 ring probe 正常，检查 ring 之后。** 对 composite capture、VideoEncoder 输入/输出和 mux 包逐 index 对账，寻找一次 drop/duplicate；这是当前主机唯一尚未覆盖的主路径。
3. **若另一台 Linux 的 ring probe 仍失败，确认是否越过新的 identity invariant。** 记录 target、lower/future PTS、eviction 前后 entries 与 readiness 分支；如果 `frameAt` 仍返回 future frame，就是新的确定性回归，而不是平台允许行为。
4. **长期再把 rational time 推进到 demux seam。** 当前修复统一了进入 WebCodecs/native adapter 之后的规则，但 Mediabunny packet 公开面仍是浮点秒；若换机矩阵暴露极端 timebase/VFR/edit-list 边界，再推动保留 container ticks/timebase。
5. **Chromium 把最后两帧交换**仍是低优先级。WebCodecs 要求 presentation order，且 frame PTS 源自对应 chunk；如果日志真显示 PTS 交换，应作为 Chromium conformance bug 或错误输入 PTS 单独处理，不能视为正常平台差异。

## 社区和上游是否遇到过

在本次检查的 WebCodecs 规范、Chromium issue/source、W3C WebCodecs issues、FFmpeg 文档与 Mediabunny 源码中，**没有找到与“Linux-only、导出完成、仅尾部像素从 N 稳定跳到 N+1”完全相同且根因已确认的公开案例**。找到的是下面这些强相关但不能等同的案例：

| 上游材料 | 证据分类 | 与 WeftCut 的关系 |
| --- | --- | --- |
| Chromium [issue 455794276](https://issues.chromium.org/issues/455794276)：同一代码在 macOS/desktop gLinux 正常，laptop gLinux 32 帧后 stall，`flush()` 超时；代码把输出 `VideoFrame` 长期留在 Map，最终以 intended behavior/Won't Fix 关闭 | **[相似案例]** | 直接证明 frame-pool 容量可以随设备而异，且未释放帧会让 flush 看似挂死；不证明 WeftCut macOS reorder-tail 或 Linux +1 是同一根因。 |
| W3C WebCodecs [issue #119](https://github.com/w3c/webcodecs/issues/119)：硬/软解码 frame 的 backing/crop/readback 行为不同；报告者观察约 10 个未销毁 frame 后 stall，维护者说明 zero-copy `ImageBitmap` 可能继续持有 frame clone | **[相似案例]** | 与 WeftCut 的 frame-pool deadlock 和 Linux hardware-frame 可读性同类；不是本机全黑探针的复现。 |
| Chromium 2026 变更 [“Don't always destroy decoders after flush()”](https://chromium.googlesource.com/chromium/src/+/854a999672f4d454fc363bff752e7c07c02fea54)：旧 flush/reinitialize 会使 Android 尚未渲染的 buffer 失效 | **[相似案例]** | 说明 flush 与 outstanding hardware frame 的生命周期确有平台实现陷阱；平台和 API 路径不同，不能据此认定 WeftCut 同根。 |
| FFmpeg [send/receive 解码 API](https://ffmpeg.org/doxygen/trunk/group__lavc__encdec.html)：输入/输出解耦，codec 可因 B 帧或流水线内部缓存，EOS 必须 drain 到 EOF | **[直接语义先例]** | 与 WebCodecs pending-output 语义一致，支持 macOS 根因判断；不是 Chromium bug 报告。 |
| Mediabunny [当前 `media-sink.ts`](https://github.com/Vanilagy/mediabunny/blob/main/src/media-sink.ts)：因 B 帧使 packet 迭代上界难定义，顺序 sample 路径不设 end packet；无输出时允许最多 40 的 decode queue，并在末尾 flush/close | **[直接设计对照]** | 说明成熟上层 sink 也必须处理“不知道要多喂多少包”和 decoder 启动延迟。WeftCut 绕过该高层 sink，自行承担 bounded range/ring/clamp 的正确性。 |
| WHATWG [issue #609](https://github.com/whatwg/html/issues/609)：浮点秒到 rational container time 的舍入可精确落到相邻帧 | **[相似问题类别]** | 强化“统一 rational time/rounding”方向；它讨论 HTML media seek，不是 WeftCut export。 |

因此，互联网资料支持两点：**跨设备 decode delay/frame pool/backing 差异是真实存在的；浮点时间换算造成相邻帧边界错误也是真实存在的。** 但没有资料替代我们对 Linux 失败产物做逐阶段 PTS 对账。

## 归责矩阵

| 现象 | 平台实现责任 | WeftCut 设计责任 | 当前结论 |
| --- | --- | --- | --- |
| macOS 窗口尾部少出 2/4 帧 | backend 决定具体延迟量 | 不应把 queue=0/有限输入当输出完成；需 progress/EOS 设计 | 主要是应用假设被平台差异暴露；workaround 与根因一致，但 16 是经验值。 |
| Linux HW frame 四路读回全黑 | 很高；有效 frame 的像素互操作失败 | 应探测并 software/native fallback | `preferSoftware` workaround 正确，与尾帧时间基无关。 |
| Linux 尾部 N→N+1 | 未证明；可能只改变时序 | 已修复一个可确定生成同形症状的 duration-eviction/identity 漏洞；完整输出下游仍未测 | 当前 proxy 样本和旧探针未复现，历史产物不足以证明同根；需换设备跑完整导出。 |
| 未关闭 frame 后 flush/stall | 池大小/backing 由平台决定 | frame 所有权、high-water 和 `close()` 由应用负责 | 共同边界；社区已有明确相似案例。 |

## 换设备时必须采集的证据

一次复现应把“原片 → proxy → decoder → ring selection → export”串成同一条可对账链：

1. 首先在有可用 Chromium VideoEncoder/GPU adapter 的 Linux 设备恢复完整 gate；保留失败的 source、proxy、native output、proxy output 和 analyzer JSON，并记录 Electron/Chromium、GPU、驱动、FFmpeg、Mediabunny 版本。
2. 对 source/proxy/output 用 `ffprobe -show_streams -show_packets -show_frames` 保存 `time_base`、`start_time`、PTS/DTS、duration、key flag 和总帧数。
3. 保留已经验证有效的 **proxy 对 source** analyzer 和生产 `ExportSourceHandle` PTS probe，和完整导出同次运行；不能只凭最终文件倒推 decoder。
4. 对尾 GOP 逐包记录：container tick/timebase（若可取）、Mediabunny seconds、`microsecondTimestamp`、`DecodeClock` source PTS 与实际 chunk timestamp；逐帧记录 output `VideoFrame.timestamp/duration`。
5. 对每个尾部 output grid 点记录：target source PTS、ring 内 lower/future 两项、eviction 前后 entries、最终选择、是否通过 exact/later-PTS/EOS 分支解除 waiter；另记录送入 VideoEncoder 的 frame index/timestamp 和 encoder 输出 chunk timestamp。
6. 在新设备至少重复 10 次。不要把已知的稳定 `-1µs` 直接判作失败；以像素 best-match 和 logical frame index 为准。稳定同位置整帧偏移支持确定性边界问题，漂移或偶现支持时序/race。
7. 覆盖 24/25/30/50/60、`30000/1001`、`60000/1001`，非零 start PTS、edit list、VFR、末尾不足一个 frame duration 和 B-frame 素材。

已完成的近期修正是：在 decode seam 统一 source 时钟，用“最大 `PTS <= target` 的已证明 presentation frame”确定 frame identity，duration 不再承担隐式改帧身份，EOS 只负责证明没有未来帧。长期目标仍是把 container integer tick + rational time base 保留到 demux/选帧 seam，再在定义明确的位置量化到微秒。

## 仓库内相关位置

- `apps/desktop/e2e/electron/export-prores-fidelity.spec.ts`
- `apps/desktop/native/src/bin/media_conformance.rs`
- `apps/desktop/native/src/jobs/proxy.rs`
- `apps/desktop/src/renderer/render/decoder/ExportDecoderPool.ts`
- `apps/desktop/src/renderer/render/decoder/decodeClock.ts`
- `apps/desktop/src/renderer/render/worker/frameGrid.ts`
- `apps/desktop/src/renderer/render/worker/exportWorker.ts`
- `docs/notes/linux-lite-export-off-by-one-tail.md`
- Mediabunny 1.45.4：`node_modules/mediabunny/src/packet.ts`
