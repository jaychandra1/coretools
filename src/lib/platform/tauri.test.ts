import { afterEach, describe, expect, it, vi } from "vitest";

// The Store marker is read once, when the module loads — as in the app,
// where Rust sets it before any page script runs.
async function loadWith(win: object) {
  vi.stubGlobal("window", win);
  vi.resetModules();
  return (await import("./tauri")).tauriPlatform;
}

describe("tauriPlatform updates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers update checks in a copy installed from the website", async () => {
    const platform = await loadWith({});
    expect(platform.storeInstall).toBe(false);
    expect(platform.updates).toBeDefined();
  });

  it("leaves updates to the Microsoft Store in a Store install", async () => {
    const platform = await loadWith({ __CORETOOLS_STORE__: true });
    expect(platform.storeInstall).toBe(true);
    expect(platform.updates).toBeUndefined();
  });

  it("ignores a marker that isn't exactly true", async () => {
    const platform = await loadWith({ __CORETOOLS_STORE__: "yes" });
    expect(platform.storeInstall).toBe(false);
    expect(platform.updates).toBeDefined();
  });
});
