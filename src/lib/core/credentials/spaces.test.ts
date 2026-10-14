import { describe, it, expect } from "vitest";
import {
  canonicalSpace,
  inSpace,
  normalizeSpaceName,
  spaceCounts,
  spaceHue,
  spaceNameError,
  spaceNames,
  SPACE_NAME_MAX,
} from "./spaces";

const logins = [
  { platform: "GitHub", space: "Dev team" },
  { platform: "AWS", space: "Dev team" },
  { platform: "ADP", space: "Organisation" },
  { platform: "Netflix", space: "Personal" },
  { platform: "Old login", space: "" },
];

describe("spaces", () => {
  it("normalizes names: whitespace, control characters, length", () => {
    expect(normalizeSpaceName("  Dev \t  team ")).toBe("Dev team");
    expect(normalizeSpaceName("Dev\u0000team\n")).toBe("Dev team");
    expect(normalizeSpaceName("   ")).toBe("");
    expect(normalizeSpaceName("x".repeat(60))).toHaveLength(SPACE_NAME_MAX);
  });

  it("refuses an empty name and the reserved 'All'", () => {
    expect(spaceNameError("Dev team")).toBeNull();
    expect(spaceNameError("  ")).toMatch(/Enter a name/);
    expect(spaceNameError(" all ")).toMatch(/All/);
  });

  it("files a differently-cased name into the existing space", () => {
    const existing = ["Dev team", "Personal"];
    expect(canonicalSpace("dev  TEAM", existing)).toBe("Dev team");
    expect(canonicalSpace("Organisation", existing)).toBe("Organisation");
    expect(canonicalSpace(" ", existing)).toBe("");
  });

  it("lists distinct spaces alphabetically, with extra (empty) ones", () => {
    expect(spaceNames(logins)).toEqual(["Dev team", "Organisation", "Personal"]);
    expect(spaceNames(logins, ["Clients", "personal", ""])).toEqual([
      "Clients",
      "Dev team",
      "Organisation",
      "Personal",
    ]);
  });

  it("counts logins per space and keeps everything under All", () => {
    const counts = spaceCounts(logins);
    expect(counts.get("Dev team")).toBe(2);
    expect(counts.get("")).toBe(1);
    expect(inSpace(logins, "").map((l) => l.platform)).toHaveLength(5);
    expect(inSpace(logins, "Dev team").map((l) => l.platform)).toEqual(["GitHub", "AWS"]);
    expect(inSpace(logins, "Missing")).toEqual([]);
  });

  it("gives each space a stable colour, whatever the case", () => {
    expect(spaceHue("Dev team")).toBe(spaceHue("dev team"));
    expect(spaceHue("Dev team")).toBeGreaterThanOrEqual(0);
    expect(spaceHue("Dev team")).toBeLessThan(360);
  });
});
