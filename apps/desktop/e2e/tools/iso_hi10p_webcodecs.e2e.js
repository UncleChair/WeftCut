// ONE-OFF PROBE: does the D3D11VideoDecoder flag unlock Hi10P (H.264 High 10 Profile)
// hardware decode in WebView2?
//
// Background: WebView2 routes WebCodecs through Windows MFT, which doesn't expose
// the 10-bit H.264 DXVA profile. Chrome's D3D11VideoDecoder bypasses MFT and can
// reach it directly. --enable-features=D3D11VideoDecoder in tauri.conf.json may
// enable that path in WebView2.
//
// This test has two levels:
//   Level 1 (no test file needed): isConfigSupported probe + configure-only probe.
//     configure() without decode() tells us if the codec string is accepted,
//     even if we can't confirm actual frame output.
//   Level 2 (requires WEFTCUT_TEST_HI10P env var pointing to a real Hi10P file):
//     Full raceFirstDecode probe via probeSourceDecodable — the only definitive test.
//
// Run:
//   npx wdio run wdio.conf.mjs --spec ./tools/iso_hi10p_webcodecs.e2e.js
//   WEFTCUT_TEST_HI10P=/path/to/hi10p.mp4 npx wdio run wdio.conf.mjs --spec ./tools/iso_hi10p_webcodecs.e2e.js

// H.264 High 10 Profile, Level 4.0
// avc1.PPCCLL: PP=profile_idc hex, CC=constraint flags, LL=level_idc hex
//   6e = 110 decimal = High 10 Profile IDC
//   00 = no constraint flags
//   28 = 40 decimal = Level 4.0
const HI10P_CODEC = "avc1.6e0028";

describe("Hi10P WebCodecs decode probe (D3D11VideoDecoder flag verification)", function () {
  it("Level 1 — isConfigSupported and configure-only for Hi10P", async function () {
    const result = await browser.executeAsync((codec, done) => {
      (async () => {
        const config = {
          codec,
          codedWidth: 1920,
          codedHeight: 1080,
          colorSpace: { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false },
        };

        // --- isConfigSupported (known to be optimistic, but shows what MFT reports) ---
        let supported = null;
        let supportedHw = null;
        let supportedSw = null;
        try {
          const r = await VideoDecoder.isConfigSupported(config);
          supported = r.supported ?? null;
        } catch (e) {
          supported = { error: String(e) };
        }
        try {
          const r = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: "prefer-hardware" });
          supportedHw = r.supported ?? null;
        } catch (e) {
          supportedHw = { error: String(e) };
        }
        try {
          const r = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: "prefer-software" });
          supportedSw = r.supported ?? null;
        } catch (e) {
          supportedSw = { error: String(e) };
        }

        // --- configure-only probe: does configure() throw? ---
        // A rejected configure means the codec string is completely rejected.
        // A passing configure without decode is necessary-but-not-sufficient.
        const configureResults = {};
        for (const hw of [undefined, "prefer-hardware", "prefer-software"]) {
          const label = hw ?? "default";
          let dec = null;
          try {
            dec = new VideoDecoder({ output: (f) => f.close(), error: () => {} });
            dec.configure({ ...config, ...(hw ? { hardwareAcceleration: hw } : {}) });
            configureResults[label] = "ok";
          } catch (e) {
            configureResults[label] = "threw: " + String(e);
          } finally {
            try { dec?.close(); } catch {}
          }
        }

        done({
          codec,
          ua: navigator.userAgent,
          isConfigSupported: { default: supported, preferHw: supportedHw, preferSw: supportedSw },
          configureOnly: configureResults,
        });
      })().catch((e) => done({ error: "threw: " + String(e) }));
    }, HI10P_CODEC);

    console.log("\n[hi10p] ===== Level 1: Hi10P capability probe =====");
    console.log("[hi10p] codec:", result.codec);
    console.log("[hi10p] UA:", result.ua?.slice(0, 80));
    if (result.error) {
      console.log("[hi10p] ERROR:", result.error);
    } else {
      console.log("[hi10p] isConfigSupported (unreliable, for reference only):");
      console.log("  default     :", result.isConfigSupported?.default);
      console.log("  prefer-hw   :", result.isConfigSupported?.preferHw);
      console.log("  prefer-sw   :", result.isConfigSupported?.preferSw);
      console.log("[hi10p] configure() (no decode — necessary but not sufficient):");
      for (const [k, v] of Object.entries(result.configureOnly ?? {})) {
        console.log(`  ${k.padEnd(16)}: ${v}`);
      }
    }

    // Level 1 always passes — we're probing, not gating.
    expect(result.error).toBeUndefined();
  });

  // Level 2: only runs when WEFTCUT_TEST_HI10P is set to a real Hi10P file path.
  // This is the only definitive test — configure + decode one real frame.
  const hi10pPath = process.env.WEFTCUT_TEST_HI10P;
  const maybeIt = hi10pPath ? it : it.skip;

  maybeIt("Level 2 — full raceFirstDecode from a real Hi10P file", async function () {
    // Convert the OS path to an asset:// URL Tauri can serve.
    // The asset protocol scope in tauri.conf.json is ["**"] so any path works in dev.
    const assetUrl = hi10pPath
      ? "asset://localhost/" + hi10pPath.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1")
      : null;

    const result = await browser.executeAsync((url, done) => {
      (async () => {
        if (!url) return done({ error: "no file URL" });

        // Import the probeSourceDecodable helper dynamically.
        // In the Tauri dev bundle, this module is available via the Vite dev server.
        let probeSourceDecodable;
        try {
          const mod = await import("/src/render/decoder/probeSourceDecodable.ts");
          probeSourceDecodable = mod.probeSourceDecodable;
        } catch (e) {
          return done({ error: "import failed: " + String(e) });
        }

        const t0 = performance.now();
        const ok = await probeSourceDecodable(url, 5000);
        const ms = Math.round(performance.now() - t0);
        done({ ok, ms, url });
      })().catch((e) => done({ error: "threw: " + String(e) }));
    }, assetUrl);

    console.log("\n[hi10p] ===== Level 2: real Hi10P decode probe =====");
    console.log("[hi10p] file:", hi10pPath);
    if (result.error) {
      console.log("[hi10p] ERROR:", result.error);
    } else {
      const verdict = result.ok
        ? "✅ DECODABLE — D3D11VideoDecoder flag appears to be working"
        : "❌ NOT DECODABLE — flag had no effect (or file isn't actually Hi10P)";
      console.log(`[hi10p] result: ${verdict} (${result.ms}ms)`);
    }

    // Level 2 always passes as a gate — we're probing.
    expect(result.error).toBeUndefined();
  });
});
