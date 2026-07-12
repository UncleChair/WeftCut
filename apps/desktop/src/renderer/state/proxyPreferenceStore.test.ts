import { beforeEach, describe, expect, it } from "vitest";
import { useProxyPrefStore, proxyIntent } from "./proxyPreferenceStore";

describe("proxyPreferenceStore", () => {
  beforeEach(() => {
    useProxyPrefStore.setState({ preferProxies: false, overrides: {} });
  });

  it("proxyIntent follows the global toggle when no override is set", () => {
    useProxyPrefStore.setState({ preferProxies: true, overrides: {} });
    expect(proxyIntent("m1")).toBe(true);
  });

  it("a per-clip override wins over the global toggle", () => {
    useProxyPrefStore.setState({ preferProxies: true, overrides: { m1: false } });
    expect(proxyIntent("m1")).toBe(false);
    useProxyPrefStore.setState({ preferProxies: false, overrides: { m1: true } });
    expect(proxyIntent("m1")).toBe(true);
  });
});
