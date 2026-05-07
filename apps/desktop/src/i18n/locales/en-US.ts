// English (US) is the source locale. New keys land here first, then propagate
// to other locales. Keep keys grouped by feature area, not by component.
const enUS = {
  app: {
    title: "Videtor",
    core_status: "core: {{status}}",
  },
  project: {
    loading: "loading project…",
    canvas: "{{width}}×{{height}} · {{fps}}",
    fps_simple: "{{fps}}fps",
    fps_rational: "{{fps}}fps",
    tracks_one: "{{count}} track",
    tracks_other: "{{count}} tracks",
    layers_one: "{{count}} layer",
    layers_other: "{{count}} layers",
    duration_seconds: "{{value}}s",
    history_position: "hist {{cursor}}/{{len}}",
  },
  actions: {
    add_track: "+ Track",
    add_color_layer: "+ Color layer (2s)",
    split_first: "Split first layer",
    compile: "Compile",
    import_media: "Import media…",
    export: "Export…",
    save_as: "Save as…",
    open: "Open…",
    undo: "Undo",
    redo: "Redo",
  },
  compiler: {
    panel_title: "Compiled filter graph ({{count}} nodes)",
    inputs_label: "Inputs",
    maps_label: "Maps",
    no_inputs: "(none)",
    close: "Close",
  },
  dialogs: {
    save_title: "Save Videtor project",
    open_title: "Open Videtor project",
    project_filter: "Videtor project",
    save_default_name: "untitled.vproj",
    import_title: "Import media",
    media_filter: "Media files",
    export_title: "Export to video",
    export_default_name: "videtor-export.mp4",
    export_filter: "MP4 video",
  },
  media_pool: {
    heading: "Media pool",
    empty: "No media imported yet — click \"Import media…\" to add a file.",
    duration: "{{seconds}}s",
    size_bytes: "{{bytes}} B",
    size_kib: "{{value}} KiB",
    size_mib: "{{value}} MiB",
    size_gib: "{{value}} GiB",
    no_duration: "—",
    preview: "Preview",
    preview_disabled_hint: "Build with --features mpv to enable preview",
  },
  preview: {
    surface_placeholder: "libmpv surface mounts here",
  },
  timeline: {
    empty_placeholder: "timeline (add a track to populate)",
    track_label: "track {{n}}",
  },
  errors: {
    refresh_failed: "refresh: {{detail}}",
    preview_failed: "preview: {{detail}}",
  },
  language: {
    switch_label: "Language",
    en_US: "English",
    zh_CN: "中文",
  },
  transport: {
    play: "▶ Play",
    pause: "⏸ Pause",
    play_pause_hint: "Toggle preview playback (libmpv)",
    preview_project: "🎬 Preview project",
    preview_project_hint:
      "Compile the project graph and load it in libmpv. Edits hot-reload from then on.",
    close_preview: "✕ Close preview",
    close_preview_hint: "Close the libmpv preview window.",
  },
  export: {
    starting: "Starting export…",
    progress_label:
      "{{percent}}% · frame {{frame}} · {{fps}}fps · {{speed}}x",
    complete: "Exported to {{path}}",
    failed: "Export failed: {{detail}}",
    cancel: "Cancel",
    dismiss: "Dismiss",
  },
  // Display labels for Rust-side enum discriminants. Keep keys lowercase so
  // `t("kinds." + value.toLowerCase())` works directly.
  kinds: {
    // MediaKind / TrackKind
    video: "Video",
    audio: "Audio",
    image: "Image",
    subtitle: "Subtitle",
    // LayerParams discriminants
    videoclip: "Video clip",
    imageoverlay: "Image overlay",
    text: "Text",
    template: "Template",
    subtitles: "Subtitles",
    color: "Color",
  },
};

export default enUS;
export type Resources = typeof enUS;
