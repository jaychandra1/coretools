import { describe, expect, it } from "vitest";
import { planMerge, type MergeInput } from "./merge";
import { tombstoneKey } from "./tombstones";

interface Rec {
  id: string;
  key: string;
  changed: number;
}

function input(over: Partial<MergeInput<Rec, Rec>>): MergeInput<Rec, Rec> {
  return {
    mode: "merge",
    local: [],
    incoming: [],
    localKey: (r) => r.key,
    incomingKey: (r) => r.key,
    changedAt: (r) => r.changed,
    tombstones: { local: [], remote: [] },
    ...over,
  };
}

const rec = (key: string, changed = 100): Rec => ({ id: `id-${key}`, key, changed });

describe("planMerge", () => {
  it("keeps local records and adds only new ones, in backup order", async () => {
    const plan = await planMerge(
      input({ local: [rec("a")], incoming: [rec("c"), rec("a"), rec("b")] }),
    );
    expect(plan.kept.map((r) => r.key)).toEqual(["a"]);
    expect(plan.added.map((r) => r.key)).toEqual(["c", "b"]);
    expect(plan.skipped).toBe(1);
    expect(plan.removed).toBe(0);
    expect(plan.revived).toEqual([await tombstoneKey("c"), await tombstoneKey("b")]);
  });

  it("adds a duplicate within the backup only once", async () => {
    const plan = await planMerge(input({ incoming: [rec("x"), rec("x")] }));
    expect(plan.added).toHaveLength(1);
    expect(plan.skipped).toBe(1);
  });

  it("doesn't bring back what this device deleted", async () => {
    const plan = await planMerge(
      input({
        incoming: [rec("gone"), rec("new")],
        tombstones: { local: [{ k: await tombstoneKey("gone"), at: 50 }], remote: [] },
      }),
    );
    expect(plan.added.map((r) => r.key)).toEqual(["new"]);
    expect(plan.skipped).toBe(1);
  });

  it("drops local records another device deleted after they last changed here", async () => {
    const plan = await planMerge(
      input({
        local: [rec("old", 100), rec("edited-later", 300)],
        tombstones: {
          local: [],
          remote: [
            { k: await tombstoneKey("old"), at: 200 },
            { k: await tombstoneKey("edited-later"), at: 200 },
          ],
        },
      }),
    );
    expect(plan.kept.map((r) => r.key)).toEqual(["edited-later"]);
    expect(plan.removed).toBe(1);
  });

  it("replace: exactly the backup, ignoring local records and tombstones", async () => {
    const plan = await planMerge(
      input({
        mode: "replace",
        local: [rec("a")],
        incoming: [rec("a"), rec("b")],
        tombstones: { local: [{ k: await tombstoneKey("b"), at: 1 }], remote: [] },
      }),
    );
    expect(plan.kept).toEqual([]);
    expect(plan.added.map((r) => r.key)).toEqual(["a", "b"]);
    expect(plan.skipped).toBe(0);
  });
});
