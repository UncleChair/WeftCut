# MCP 2026-07-28 Migration Plan

> Status: planned
>
> Last reviewed: 2026-07-29
>
> Target: MCP `2026-07-28` with the TypeScript SDK v2
>
> Scope: future protocol migration only

## Decision

WeftCut can migrate to MCP `2026-07-28`. The repository already requires
Node.js `>=22`, while the evaluated TypeScript SDK v2 packages require Node.js
`>=20`, so there is no runtime-version blocker.

This is a protocol and transport migration, not a dependency-only update. The
recommended design is a dual-era `/mcp` endpoint:

- keep the current sessionful handler for existing clients;
- route modern requests to a v2 `createMcpHandler`;
- preserve bearer authentication and localhost binding;
- add the Origin validation required by the modern transport;
- retire the legacy path only after real client adoption has been measured.

Installing v2 packages alone does not enable the modern protocol. A manually
constructed v2 `Client`, `Server`, or `McpServer` still needs explicit version
negotiation or the modern HTTP handler described in the
[official adoption guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).

## Evaluated dependency baseline

Re-check the latest stable versions and the Hono dependency before
implementation. The stable baseline evaluated for this plan is:

| Package | Version | Purpose |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `2.0.0` | Server APIs and `createMcpHandler` |
| `@modelcontextprotocol/node` | `2.0.0` | Node HTTP adapter and `toNodeHandler` |
| `@modelcontextprotocol/client` | `2.0.0` | Modern and legacy E2E clients |
| `@modelcontextprotocol/core` | transitive | Shared protocol types; add directly only if source code imports it |
| `@modelcontextprotocol/express` | optional | Not required for the current hand-written Express host |
| `@modelcontextprotocol/codemod` | `2.0.0`, one-time | Mechanical v1-to-v2 import and API assistance |

During the dual-era period, add the v2 packages alongside the monolithic SDK
used by the existing sessionful handler. Remove the monolithic package only
after that handler has been reimplemented or retired.

Pin the v2 packages exactly for the first migration. Restore semver ranges only
after both protocol paths and the packaged Electron application are stable.

### Hono dependency gate

At the time of review, `@modelcontextprotocol/node@2.0.0` still declared
`@hono/node-server: ^1.19.9`. A fresh install therefore selected a 1.x release,
while the reviewed security advisory marks every version below `2.0.5` as
affected.

Before adding the Node adapter, choose one of these options:

1. use a temporary root override and run the full regression matrix:

   ```json
   {
     "overrides": {
       "@hono/node-server": "^2.0.5"
     }
   }
   ```

2. wait for an `@modelcontextprotocol/node` patch that admits the fixed Hono
   range.

The override crosses the adapter's declared major-version range. Upstream has
verified that its `getRequestListener` usage is compatible with Hono 2.x, but
the override must remain temporary and explicitly tested.

References:
[GitHub advisory](https://github.com/advisories/GHSA-frvp-7c67-39w9) and
[upstream compatibility work](https://github.com/modelcontextprotocol/typescript-sdk/pull/2549).

## Protocol changes that affect WeftCut

| Area | Current behavior | MCP `2026-07-28` target |
| --- | --- | --- |
| Lifecycle | `initialize`, `notifications/initialized`, UUID sessions | No initialization phase or protocol sessions |
| Routing | `Mcp-Session-Id` selects a stored transport | Every modern request is independently described |
| Discovery | Server information comes from initialization | Implement `server/discover` |
| HTTP | Sessionful Streamable HTTP transport | One new POST per JSON-RPC message |
| Metadata | Negotiated once per session | Protocol/capability information in request `_meta`; server information in result `_meta` |
| Notifications | Unsolicited `notifications/weftcut/change` per session | Long-lived `subscriptions/listen` response stream |
| Results | Existing application payloads | Wire results include `resultType` and cache hints |
| Resource errors | Resource absence currently maps to `-32601` | Resource absence maps to `-32602 Invalid Params` |
| Browser security | Host validation; Origin deliberately unrestricted | Validate every supplied Origin and return `403` for invalid values |

The modern Streamable HTTP transport removes the old GET event stream,
`Last-Event-ID` recovery, resource `subscribe`/`unsubscribe`, and protocol
sessions. Localhost binding and authentication remain appropriate.

The v2 handler supplies wire-level result bookkeeping, including conservative
cache defaults. The Rust business payloads are therefore unlikely to need a
large redesign, but protocol-level tests must verify the serialized results.

## Repository migration surface

### HTTP host

[`apps/desktop/src/main/mcp/index.ts`](../../apps/desktop/src/main/mcp/index.ts)
currently:

- stores `StreamableHTTPServerTransport` instances by session ID;
- accepts a new connection only when the body is an initialize request;
- generates and returns `Mcp-Session-Id`;
- validates Host but intentionally leaves Origin unrestricted;
- broadcasts `notifications/weftcut/change` to active servers.

Keep this path intact for legacy clients while introducing a separate modern
handler. Authentication must run before either handler.

### MCP server API

[`apps/desktop/src/main/mcp/server.ts`](../../apps/desktop/src/main/mcp/server.ts)
uses the v1 schema-first form:

```ts
server.setRequestHandler(ListToolsRequestSchema, handler)
```

The v2 API registers method strings and provides a structured request context:

```ts
server.setRequestHandler("tools/list", handler)
```

Migrate handler registration, callback context, manifest construction, and
error creation deliberately. Prefer v2 `ProtocolError` APIs rather than plain
`Error` objects with an attached `code`, because plain-error serialization is
not a stable protocol contract.

### Resources and errors

[`apps/desktop/src/main/state/resource-views.ts`](../../apps/desktop/src/main/state/resource-views.ts)
and the error mapping in
[`apps/desktop/src/main/mcp/server.ts`](../../apps/desktop/src/main/mcp/server.ts)
currently conflate missing resources with JSON-RPC method-not-found. Split
those cases:

- missing resource or invalid resource URI: `-32602`;
- unknown JSON-RPC method: the method-not-found error;
- tool/domain failures: retain their intentional domain mapping.

### Electron bundling

[`apps/desktop/electron.vite.config.ts`](../../apps/desktop/electron.vite.config.ts)
externalizes only `@modelcontextprotocol/sdk` and its subpaths. Extend the
externalization rule to the v2 package family so Electron resolves those
packages from `node_modules` at runtime.

Verify both the development build and the packaged application. Passing
TypeScript alone does not prove that ESM subpath exports survive bundling.

### Clients, probes, and documentation

Seven Electron E2E specifications import `Client` and
`StreamableHTTPClientTransport` from the monolithic SDK. Move modern coverage
to `@modelcontextprotocol/client` and set either:

```ts
versionNegotiation: { mode: "auto" }
```

or an explicit `2026-07-28` pin. A hand-created v2 client without explicit
negotiation can still exercise only legacy behavior.

Also update:

- [`scripts/mcp_probe.py`](../../scripts/mcp_probe.py), which assumes
  initialization and sessions;
- [`docs/mcp.md`](../mcp.md), which documents the current session lifecycle and
  custom notification;
- package-lock and license review for coexisting Zod 3 and Zod 4 copies.

## Target endpoint architecture

```text
POST /mcp
  |
  +-- bearer authentication
  |
  +-- Host and supplied-Origin validation
  |
  +-- isLegacyRequest(request)
        |
        +-- true  --> existing sessionful handler
        |             initialize + Mcp-Session-Id
        |
        +-- false --> toNodeHandler(
                        createMcpHandler(factory, { legacy: "reject" })
                      )
                      server/discover + stateless modern requests
```

Important routing properties:

- a missing Origin remains valid for non-browser MCP clients;
- a supplied Origin must match the explicit allowlist;
- bearer failures remain `401` before protocol routing;
- invalid modern Origins return `403`;
- the modern handler must not claim sessionful legacy traffic;
- closing the desktop MCP host must release both legacy transports and modern
  response streams.

The exact `createMcpHandler` options should be taken from the installed stable
SDK version rather than copied blindly from this planning note.

## Change notification design

The current `notifications/weftcut/change` message is an unsolicited,
session-scoped custom notification. It has no direct modern-core equivalent.

Use this core mapping:

1. the client opens `subscriptions/listen`;
2. a project mutation emits `resourceUpdated("project://current")`;
3. the client reads the project resource again.

If clients still need the compact change summary, define it as an explicitly
negotiated MCP extension that is disabled by default. Do not continue sending
an undeclared custom notification on the modern path.

This recommendation follows the standard subscription model and the
[MCP extension negotiation model](https://modelcontextprotocol.io/extensions/overview).

## Implementation sequence

### 1. Freeze the compatibility contract

- preserve the current legacy E2E suite;
- add fixtures for authentication, stale sessions, resources, prompts, and
  project-change notifications;
- record the current tool/resource/prompt catalogs;
- decide the allowed Origin set for loopback clients.

### 2. Add v2 packages and migrate API surfaces

- add `server`, `node`, and `client` at the reviewed exact versions;
- apply the Hono gate described above;
- optionally run the official codemod on a clean worktree:

  ```sh
  npx @modelcontextprotocol/codemod@2.0.0 v1-to-v2 .
  ```

- manually review imports, method registration, context types, errors,
  manifests, Electron externalization, and E2E helpers.

The codemod does not understand WeftCut's transport architecture and must not be
treated as the completed migration.

### 3. Introduce the modern handler

- create the modern server through `createMcpHandler`;
- adapt it to the existing Node/Express host with `toNodeHandler`;
- use `isLegacyRequest` to preserve the existing sessionful path;
- configure the modern handler to reject legacy requests handled elsewhere;
- implement and test `server/discover`;
- verify request and result metadata on the wire.

### 4. Migrate security, subscriptions, and errors

- validate supplied Origins while continuing to allow clients that omit the
  header;
- keep bearer and Host checks ahead of both handlers;
- implement `subscriptions/listen`;
- map project changes to `resourceUpdated("project://current")`;
- separate resource-not-found from method-not-found;
- verify v2 result and cache metadata.

### 5. Expand protocol and packaging tests

- add an auto-negotiating or modern-pinned client suite;
- retain the legacy session client suite;
- test concurrent legacy sessions and modern streams;
- exercise token rotation and host shutdown;
- build main, preload, and renderer outputs;
- run packaged smoke tests on Windows, macOS, and Linux.

### 6. Retire legacy behavior separately

Do not remove initialization, session routing, or the custom legacy
notification as an incidental part of the v2 package migration. Retirement is
a later compatibility decision based on supported-client adoption.

## Acceptance checklist

- [ ] A modern client discovers the service with `server/discover`.
- [ ] Modern requests neither create nor require `Mcp-Session-Id`.
- [ ] Protocol, method, and name headers plus request/result `_meta` are correct.
- [ ] A legacy client can still initialize and call tools, resources, and
      prompts.
- [ ] Modern `tools/list`, `tools/call`, `resources/list`, `resources/read`,
      `prompts/list`, and `prompts/get` succeed.
- [ ] Serialized list/read results contain valid `resultType`, `ttlMs`, and
      `cacheScope`.
- [ ] Missing or incorrect bearer credentials return `401`.
- [ ] An invalid supplied Origin returns `403`.
- [ ] A missing resource returns `-32602`; an unknown JSON-RPC method retains
      method-not-found semantics.
- [ ] `subscriptions/listen` receives
      `resourceUpdated("project://current")`.
- [ ] Host shutdown releases legacy sessions and modern streams.
- [ ] Electron output resolves every v2 package and subpath correctly.
- [ ] Loopback Host and Origin handling works on Windows, macOS, and Linux.
- [ ] The lockfile contains no vulnerable nested Hono copy introduced by the
      Node adapter.

Optionally use `@modelcontextprotocol/inspector@2.0.0` for manual wire-level
inspection after automated coverage passes.

## Open decisions

- the exact allowlist for supplied browser Origins;
- whether the compact WeftCut change summary warrants a negotiated extension;
- whether the modern and legacy server factories should share one handler
  registry or use thin adapters over the same domain operations;
- the client-adoption threshold and release window for legacy retirement;
- whether an upstream Node-adapter patch has removed the temporary Hono
  override requirement by implementation time.

## Primary sources

Sources reviewed on 2026-07-29:

- [MCP `2026-07-28` specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP `2026-07-28` changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Version negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP `2026-07-28` release](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28)
- [TypeScript SDK v2 upgrade guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [TypeScript SDK `2026-07-28` adoption guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
- [`@modelcontextprotocol/server@2.0.0` release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fserver%402.0.0)
- [MCP extensions overview](https://modelcontextprotocol.io/extensions/overview)
