// Preview-only overlay shown when the on-screen clip's media resolves to
// `status: "unsupported"` — no decode engine can produce a frame for it (only
// reachable on the Lite/webcodecs engine, or a pinned Standard engine with no
// usable component). `PixiPreview` renders this as an absolute sibling of the
// canvas, driven by `Compositor`'s `onUnsupported` callback. The Compositor
// recomputes the unsupported set per composite and fires the callback on
// membership change — never per-frame.
//
// Plan: .superpowers/sdd/task-12-brief.md

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { setAppSettings } from "../settings/appSettingsStore";
import { useDecodeComponentStore } from "../settings/decodeComponentStore";
import { generateQuickProxy } from "../ipc";
import { setProxyOverride } from "../state/proxyPreferenceStore";

export function UnsupportedClipCard({ mediaId }: { mediaId: string }) {
  const { t } = useTranslation();
  const componentAvailable = useDecodeComponentStore((s) => s.available);
  return (
    <div
      className="absolute inset-0 grid place-items-center bg-black/70 text-center text-sm text-white"
      data-testid="unsupported-clip-card"
    >
      <div className="max-w-sm space-y-3 p-4">
        <div className="font-medium">{t("settings.decode_unsupported_title")}</div>
        <div className="text-white/70">
          {t(
            componentAvailable
              ? "settings.decode_unsupported_body"
              : "settings.decode_unsupported_body_no_component",
          )}
        </div>
        <div className="flex justify-center gap-2">
          {componentAvailable && (
            <Button
              variant="secondary"
              onClick={() => {
                void setAppSettings({ decode_engine: "ffmpeg" });
              }}
            >
              {t("settings.decode_unsupported_switch")}
            </Button>
          )}
          <Button
            variant="secondary"
            data-testid="unsupported-generate-proxy"
            onClick={() => {
              void generateQuickProxy(mediaId);
              void setProxyOverride(mediaId, true);
            }}
          >
            {t("settings.decode_unsupported_generate_proxy")}
          </Button>
        </div>
      </div>
    </div>
  );
}
