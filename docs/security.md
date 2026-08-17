# Security

WeftCut is a local-first desktop app: the renderer loads only the app's own bundled
UI, and every window runs with Electron's isolation defaults hardened on
(`contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`). This document
records the **Content-Security-Policy** posture — why each CSP is shaped the way it is,
and the invariants that must hold when the app is extended. (Window, IPC, and
filesystem hardening live in `src/main/`; this doc focuses on CSP.)

There are two distinct CSPs, for two distinct trust contexts.

## The app renderer

The editor UI is first-party code that loads no remote content. Its CSP is injected
into the packaged `index.html` at build time (`electron.vite.config.ts`); the dev
server is left untouched, because HMR needs inline + eval + websockets.

- `default-src 'self'`, `object-src 'none'`, `base-uri 'self'` — no `<base>` hijack, no
  plugins.
- **`frame-src motif:`** — the only embeddable context is a Motif's own parameter page
  (see [`motifs.md`](motifs.md)), framed by the property panel with
  `sandbox="allow-scripts"` and no `allow-same-origin`. `'self'` is deliberately absent:
  the renderer frames none of its own documents, so the app bundle stays unembeddable in
  itself. The grant widens what may be *framed*; what the framed page may *reach* is
  still bounded by the `motif:` CSP below.
- `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:`. WASM (the eval leaf,
  mediabunny) needs the narrow `wasm-unsafe-eval` compile grant. `'unsafe-eval'` is
  granted for PixiJS's `new Function` shader/uniform codegen: the no-eval
  `pixi.js/unsafe-eval` polyfill we previously used to *avoid* this grant renders
  every **filtered** object EMPTY on the **WebGPU** backend (filters work on WebGL
  either way), which kills the per-layer effects subsystem in the WebGPU-preferring
  preview and export. Real codegen + `'unsafe-eval'` is the accepted trade. The grant
  widens the eval surface but not the *content* surface — the renderer still loads no
  remote or inline `<script>`, so the practical XSS vector (the thing CSP exists to
  block here) stays closed.
- `img-/media-/connect-src` include the app's own privileged schemes (`weftcut-media:`,
  `motif:`) plus `blob:`/`data:` — the editor legitimately fetches imported media and
  Motif assets.

The renderer is allowed to reach its own privileged schemes because it **is** the
trusted shell. This is the exact opposite of the Motif document context below.

## Motif documents

A Motif is **untrusted, user- or agent-authored web content** that the app executes to
capture animation frames (see [`motifs.md`](motifs.md)). It runs in a dedicated
offscreen capture window, and its security rests on **two orthogonal axes**:

- **Process isolation (the sandbox axis).** The capture host runs at the same hardened
  baseline as every app window — `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, and **no preload** — so a Motif's JavaScript reaches neither
  Node, the OS, nor any IPC bridge (none is exposed to it). This bounds what a Motif can
  *do to the host*.
- **Content confinement (the CSP axis).** Every Motif document is served by the `motif:`
  scheme with:

  ```
  default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: motif:; font-src data: motif:
  ```

  With no `connect-src` (and no `https:` anywhere) the page can make **no network
  request** — no fetch/XHR/WebSocket, no remote `<script>`, no beacon, no iframe. It is
  fully offline. This bounds what a Motif can *reach*.

  A Motif's **parameter page** (`params.html`, the one document the app frames rather
  than captures) is served with exactly one delta: `script-src` and `style-src`
  additionally allow the `motif:` scheme, so a parameter UI may split into companion
  `.js`/`.css` files instead of cramming everything inline — a render document is one
  self-contained file by construction, a parameter UI is not. Everything else,
  including `default-src 'none'` and therefore the absent `connect-src`, is identical:
  the page is offline too. `'self'` is used in neither CSP, because the page is framed
  with `sandbox="allow-scripts"` and no `allow-same-origin`, so its origin is opaque
  and `'self'` would match nothing.

**The two axes are not redundant.** The sandbox does not restrict the network, so a
sandboxed-but-unconfined Motif could still read whatever it can reach and exfiltrate it;
the CSP is what closes that. Conversely, the CSP would not stop a renderer exploit from
reaching the OS; the sandbox does. Both are load-bearing — neither substitutes for the
other.

### Why `script-src 'unsafe-inline'` is deliberate, not a gap

A Motif *is* untrusted author code that we intentionally run — that is the whole feature.
So `script-src`'s usual anti-XSS role is moot here: a wholly-untrusted document has no
trusted-vs-injected boundary to enforce, and a nonce/hash allowlist would add machinery
for no security gain. The CSP's entire security value for Motifs lives in its *other*
directives — the egress and remote-load controls (`default-src 'none'`, the absent
`connect-src`, `img-src`/`font-src` limited to `data:`/`motif:`).

### Invariant: keep the egress axis closed

Never add `https:` or `*` to a Motif CSP directive. When Motifs gain the ability to
reference **project media** (a planned feature — the end-user binds an imported photo or
clip to a Motif instance), that capability must be granted through a dedicated,
capability-scoped privileged scheme: the app resolves an instance's bound media to
opaque, per-render URLs the Motif can load, and the handler serves only the media that
instance was granted. It must **never** be granted by loosening `connect-src`/`img-src`
toward the network. The rule: widen *what a Motif may display*, never *where it may
connect*.
