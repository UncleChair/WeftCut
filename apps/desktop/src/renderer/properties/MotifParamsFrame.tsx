// A Motif's own parameter page, embedded in the property panel.
//
// The page is author-written HTML served over the `motif:` protocol and framed
// with `sandbox="allow-scripts"` and NO `allow-same-origin`: it runs its own
// scripts on an opaque origin, can reach neither the app's DOM nor the network
// (see the params CSP in main/motif/protocol.ts), and talks to the host only
// through the validated postMessage seam in `motifParamsHost.ts`.
//
// Focus (ADR 0041): the iframe is an ordinary focusable element inside the
// attribute panel's focus region. Key events inside the page never cross the
// document boundary, so the page keeps its own keys for free and the host adds
// no trap and no escape hatch — deliberately no new focus machinery here.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { PARAMS_PAGE_FILE } from "../../shared/motifs/catalog";
import {
  motifCatalogRevision,
  subscribeMotifCatalog,
  type MotifManifest,
} from "../render/motifs/catalog";
import {
  createMotifParamsHost,
  PARAMS_DEFAULT_HEIGHT_PX,
  readThemeTokens,
  type MotifParamsHost,
} from "./motifParamsHost";

/// `motif://<id>/params.html?v=<revision>`. The revision is the runtime
/// catalog's, which the directory watcher bumps on any Motif file change — so
/// editing the page on disk reloads it here rather than serving a cached copy.
export function motifParamsPageUrl(motifId: string, revision: number): string {
  return `motif://${motifId}/${PARAMS_PAGE_FILE}?v=${revision}`;
}

export function MotifParamsFrame({
  layerId,
  motifId,
  manifest,
  props,
  commit,
}: {
  layerId: string;
  motifId: string;
  manifest: MotifManifest;
  /// The layer's committed props.
  props: Record<string, unknown>;
  /// One `update_layer_params` per call — the panel's normal commit path, so a
  /// page commit is one history entry like every other control.
  commit: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const { i18n, t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<MotifParamsHost | null>(null);
  const [height, setHeight] = useState(PARAMS_DEFAULT_HEIGHT_PX);
  const revision = useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision);

  // Live reads for values that change under a host built once per document.
  const manifestRef = useRef(manifest);
  manifestRef.current = manifest;
  const propsRef = useRef(props);
  propsRef.current = props;
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const localeRef = useRef(i18n.language);
  localeRef.current = i18n.language;

  const src = motifParamsPageUrl(motifId, revision);

  // One host per loaded document. A new layer, a new Motif, or a watcher-driven
  // reload tears the old one down — which also drops any preview it had
  // pending, so a mid-gesture reload can't strand the canvas on stale props.
  useEffect(() => {
    const host = createMotifParamsHost({
      layerId,
      motifId,
      manifest: () => manifestRef.current,
      props: () => propsRef.current,
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      post: (message) => frameRef.current?.contentWindow?.postMessage(message, "*"),
      commit: (patch) => commitRef.current(patch),
      setHeight,
      locale: () => localeRef.current,
      themeTokens: () => readThemeTokens(),
    });
    hostRef.current = host;
    const onMessage = (event: MessageEvent) => host.handleMessage(event);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      hostRef.current = null;
      host.dispose();
    };
  }, [layerId, motifId, src]);

  // External prop changes (undo, an agent edit) reach the page. The host drops
  // the redundant echo of the page's own commit.
  useEffect(() => {
    hostRef.current?.syncProps(props);
  }, [props]);

  return (
    <iframe
      ref={frameRef}
      className="motif-params-frame"
      // Scripts only: no same-origin (the page must not reach the app's DOM),
      // no forms, no popups, no top-navigation.
      sandbox="allow-scripts"
      src={src}
      title={t("property_panel.props")}
      style={{ height: `${height}px` }}
      onLoad={() => hostRef.current?.sendInit()}
    />
  );
}
