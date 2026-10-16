/**
 * Update notifications: when the app checks, what it remembers, and what it
 * shows. A fake clock, a stub release index and an in-memory localStorage.
 * (Builds report __APP_VERSION__ "0.0.0-test" here.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridge, openExternal, record } = vi.hoisted(() => ({
  bridge: { check: vi.fn(), install: vi.fn() },
  openExternal: vi.fn(),
  record: vi.fn(),
}));
vi.mock("./platform", () => ({
  getPlatform: () => ({ updates: bridge, openExternal, diagnostics: { record } }),
}));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key),
});

const { UpdateController, compareVersions, CHECK_EVERY_MS, RETRY_AFTER_MS, TICK_MS } = await import(
  "./updates.svelte"
);

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 14, 9, 0);

function release(version: string, extra: Record<string, unknown> = {}) {
  return {
    version,
    date: "2026-10-14",
    releaseUrl: `https://github.com/jaychandra1/artifacts/releases/tag/coretools-v${version}`,
    notice: null,
    security: false,
    downloadUrl: `https://github.com/jaychandra1/artifacts/releases/download/coretools-v${version}/CoreTools-Windows-Setup.exe`,
    ...extra,
  };
}

function started(prefs: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(prefs)) storage.set(key, value);
  const controller = new UpdateController();
  controller.start();
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  storage.clear();
  bridge.check.mockReset();
  bridge.install.mockReset();
  openExternal.mockReset();
  record.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("update notifications", () => {
  it("compares dotted versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.3")).toBe(1);
    expect(compareVersions("1.2.1", "1.2.1")).toBe(0);
    expect(compareVersions("1.2.0", "1.2.1")).toBe(-1);
  });

  it("checks when the app opens if one is due, and keeps checking while it stays open", async () => {
    bridge.check.mockResolvedValue(release("1.2.2"));
    const updates = started({
      "coretools.updates": "on",
      "coretools.updates.checkedAt": String(NOW - 7 * HOUR),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.check).toHaveBeenCalledTimes(1);
    expect(updates.banner?.version).toBe("1.2.2");

    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - TICK_MS);
    expect(bridge.check).toHaveBeenCalledTimes(1); // not due yet
    await vi.advanceTimersByTimeAsync(2 * TICK_MS);
    expect(bridge.check).toHaveBeenCalledTimes(2); // a release published meanwhile is found
  });

  it("remembers a found release across a restart, without asking again early", async () => {
    storage.set("coretools.updates.latest", JSON.stringify(release("1.2.2")));
    const updates = started({
      "coretools.updates": "on",
      "coretools.updates.checkedAt": String(NOW - CHECK_EVERY_MS / 2),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.check).not.toHaveBeenCalled();
    expect(updates.available?.version).toBe("1.2.2");
  });

  it("ignores a remembered release that points outside the release repository", () => {
    storage.set(
      "coretools.updates.latest",
      JSON.stringify(release("1.2.2", { releaseUrl: "https://evil.example/setup.exe" })),
    );
    const updates = started({
      "coretools.updates": "on",
      "coretools.updates.checkedAt": String(NOW - CHECK_EVERY_MS / 2),
    });
    expect(updates.available).toBeNull();
  });

  it("hides the banner after Later for that version only", async () => {
    bridge.check.mockResolvedValue(release("1.2.2"));
    const updates = started({ "coretools.updates": "on" });
    await vi.advanceTimersByTimeAsync(0);
    updates.dismiss();
    expect(updates.banner).toBeNull();
    expect(updates.available?.version).toBe("1.2.2"); // the header pill stays

    bridge.check.mockResolvedValue(release("1.2.3"));
    const restarted = started({ "coretools.updates.checkedAt": "0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(restarted.banner?.version).toBe("1.2.3");
  });

  it("retries a failed check after a while, not on every tick", async () => {
    bridge.check.mockRejectedValue("update_network");
    started({ "coretools.updates": "on" });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.check).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("updates", "update_network");

    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - TICK_MS);
    expect(bridge.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(bridge.check).toHaveBeenCalledTimes(2);
  });

  it("never checks while off, and turning it off forgets the release", async () => {
    started({ "coretools.updates": "off" });
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(bridge.check).not.toHaveBeenCalled();

    bridge.check.mockResolvedValue(release("1.2.2"));
    const updates = started({ "coretools.updates": "on" });
    await vi.advanceTimersByTimeAsync(0);
    updates.setPref("off");
    expect(updates.available).toBeNull();
    expect(storage.has("coretools.updates.latest")).toBe(false);
  });

  it("drops a remembered download link outside the release downloads", () => {
    storage.set(
      "coretools.updates.latest",
      JSON.stringify(release("1.2.2", { downloadUrl: "https://evil.example/setup.exe" })),
    );
    const updates = started({
      "coretools.updates": "on",
      "coretools.updates.checkedAt": String(NOW - CHECK_EVERY_MS / 2),
    });
    expect(updates.available?.version).toBe("1.2.2");
    expect(updates.available?.downloadUrl).toBeNull();
  });

  it("updates in the app, reporting the download and then the install", async () => {
    bridge.check.mockResolvedValue(release("1.2.2"));
    const seen: unknown[] = [];
    bridge.install.mockImplementation(async (onProgress: (p: unknown) => void) => {
      onProgress({ phase: "downloading", downloaded: 0, total: null });
      seen.push(updates.installing);
      onProgress({ phase: "downloading", downloaded: 512, total: 2048 });
      seen.push(updates.installing);
      onProgress({ phase: "installing" });
      seen.push(updates.installing);
    });
    const updates = started({ "coretools.updates": "on" });
    await vi.advanceTimersByTimeAsync(0);
    await updates.update();
    expect(seen).toEqual([
      { phase: "downloading", percent: null },
      { phase: "downloading", percent: 25 },
      { phase: "installing", percent: 100 },
    ]);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("downloads the installer instead when this build or release has no signed update", async () => {
    bridge.check.mockResolvedValue(release("1.2.2"));
    const updates = started({ "coretools.updates": "on" });
    await vi.advanceTimersByTimeAsync(0);

    bridge.install.mockRejectedValue("update_unavailable");
    await updates.update();
    expect(openExternal).toHaveBeenLastCalledWith(
      "https://github.com/jaychandra1/artifacts/releases/download/coretools-v1.2.2/CoreTools-Windows-Setup.exe",
    );
    expect(updates.installing).toBeNull();
    expect(updates.installError).toBe("");

    // A release that lists no installer for this platform: its page.
    updates.available = release("1.2.2", { downloadUrl: null });
    bridge.install.mockRejectedValue("update_none");
    await updates.update();
    expect(openExternal).toHaveBeenLastCalledWith(
      "https://github.com/jaychandra1/artifacts/releases/tag/coretools-v1.2.2",
    );
  });

  it("explains a failed update and leaves the download to the user", async () => {
    bridge.check.mockResolvedValue(release("1.2.2"));
    const updates = started({ "coretools.updates": "on" });
    await vi.advanceTimersByTimeAsync(0);

    bridge.install.mockRejectedValue("update_network");
    await updates.update();
    expect(updates.installError).toMatch(/connection/);
    bridge.install.mockRejectedValue("update_failed");
    await updates.update();
    expect(updates.installError).toMatch(/Download the installer/);
    expect(openExternal).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith("updates", "update_failed");
  });

  it("shows nothing for a release that isn't newer than this build", async () => {
    bridge.check.mockResolvedValue(release("0.0.0"));
    const updates = started({ "coretools.updates": "on" });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.available).toBeNull();
    expect(updates.banner).toBeNull();
  });
});
