import type { Resources } from "./en-US";

// 简体中文 (zh-CN). Mirrors the en-US shape one-to-one — the `Resources` type
// will fail to type-check if a key is missing or extra.
const zhCN: Resources = {
  app: {
    title: "Videtor",
    core_status: "核心：{{status}}",
  },
  project: {
    loading: "正在加载项目…",
    canvas: "{{width}}×{{height}} · {{fps}}",
    fps_simple: "{{fps}}帧/秒",
    fps_rational: "{{fps}}帧/秒",
    // Chinese has no grammatical plural — both forms collapse to the same string.
    tracks_one: "{{count}} 条轨道",
    tracks_other: "{{count}} 条轨道",
    layers_one: "{{count}} 个图层",
    layers_other: "{{count}} 个图层",
    duration_seconds: "{{value}} 秒",
    history_position: "历史 {{cursor}}/{{len}}",
  },
  actions: {
    add_track: "+ 轨道",
    add_color_layer: "+ 颜色层（2秒）",
    split_first: "切分首个图层",
    compile: "编译",
    import_media: "导入素材…",
    export: "导出…",
    save_as: "另存为…",
    open: "打开…",
    undo: "撤销",
    redo: "重做",
  },
  compiler: {
    panel_title: "编译后的滤镜图（{{count}} 个节点）",
    inputs_label: "输入",
    maps_label: "映射",
    no_inputs: "（无）",
    close: "关闭",
  },
  dialogs: {
    save_title: "保存 Videtor 项目",
    open_title: "打开 Videtor 项目",
    project_filter: "Videtor 项目",
    save_default_name: "未命名.vproj",
    import_title: "导入素材",
    media_filter: "媒体文件",
    export_title: "导出视频",
    export_default_name: "videtor-导出.mp4",
    export_filter: "MP4 视频",
  },
  media_pool: {
    heading: "素材库",
    empty: "尚未导入素材 — 点击「导入素材…」添加文件。",
    duration: "{{seconds}} 秒",
    size_bytes: "{{bytes}} B",
    size_kib: "{{value}} KiB",
    size_mib: "{{value}} MiB",
    size_gib: "{{value}} GiB",
    no_duration: "—",
    preview: "预览",
    preview_disabled_hint: "需以 --features mpv 构建以启用预览",
  },
  preview: {
    surface_placeholder: "libmpv 视频画面将在此显示",
  },
  timeline: {
    empty_placeholder: "时间线（添加轨道开始）",
    track_label: "轨道 {{n}}",
  },
  errors: {
    refresh_failed: "刷新失败：{{detail}}",
    preview_failed: "预览失败：{{detail}}",
  },
  language: {
    switch_label: "语言",
    en_US: "English",
    zh_CN: "中文",
  },
  transport: {
    play: "▶ 播放",
    pause: "⏸ 暂停",
    play_pause_hint: "切换预览播放（libmpv）",
    preview_project: "🎬 预览项目",
    preview_project_hint: "编译项目图并在 libmpv 中加载。之后每次编辑会热更新。",
    close_preview: "✕ 关闭预览",
    close_preview_hint: "关闭 libmpv 预览窗口。",
  },
  export: {
    starting: "正在启动导出…",
    progress_label:
      "{{percent}}% · 第 {{frame}} 帧 · {{fps}}fps · {{speed}}x",
    complete: "已导出到 {{path}}",
    failed: "导出失败：{{detail}}",
    cancel: "取消",
    dismiss: "关闭",
  },
  kinds: {
    video: "视频",
    audio: "音频",
    image: "图片",
    subtitle: "字幕",
    videoclip: "视频片段",
    imageoverlay: "图片叠加",
    text: "文本",
    template: "模板",
    subtitles: "字幕",
    color: "颜色",
  },
};

export default zhCN;
