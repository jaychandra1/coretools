import { describe, it, expect } from "vitest";
import { displayUrl, normalizeUrl, UrlError } from "./url";
import {
  facets,
  filterCredentials,
  matchesQuery,
  parseTags,
  EMPTY_FILTER,
} from "./search";
import { generatePassword, passwordStrength } from "./generate";
import { credentialKey } from "./types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13);

function item(over: Partial<Parameters<typeof matchesQuery>[0]> = {}) {
  return {
    platform: "AWS Production",
    url: "https://console.aws.amazon.com/",
    username: "devops-admin",
    category: "Cloud",
    owner: "Platform team",
    tags: ["prod", "infra"],
    space: "Dev team",
    createdAt: NOW - 2 * DAY,
    ...over,
  };
}

describe("normalizeUrl", () => {
  it("upgrades bare hosts to https", () => {
    expect(normalizeUrl("console.aws.amazon.com")).toBe("https://console.aws.amazon.com/");
    expect(normalizeUrl("  github.com/login ")).toBe("https://github.com/login");
  });

  it("keeps http(s) URLs", () => {
    expect(normalizeUrl("http://intranet.local:8080/x?y=1")).toBe("http://intranet.local:8080/x?y=1");
  });

  it("returns empty for empty input", () => {
    expect(normalizeUrl("   ")).toBe("");
  });

  it("rejects dangerous or non-web schemes", () => {
    for (const bad of ["javascript:alert(1)", "file:///C:/x", "ms-settings:privacy", "data:text/html,hi"]) {
      expect(() => normalizeUrl(bad)).toThrow(UrlError);
    }
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() => normalizeUrl("https://user:pw@example.com")).toThrow(/username or password/);
  });

  it("formats for display", () => {
    expect(displayUrl("https://console.aws.amazon.com/")).toBe("console.aws.amazon.com");
    expect(displayUrl("https://github.com/login")).toBe("github.com/login");
  });
});

describe("search & filters", () => {
  it("matches every term across platform, url, username, tags, category, owner, space", () => {
    expect(matchesQuery(item(), "aws admin")).toBe(true);
    expect(matchesQuery(item(), "#prod")).toBe(true);
    expect(matchesQuery(item(), "cloud platform")).toBe(true);
    expect(matchesQuery(item(), "aws github")).toBe(false);
    expect(matchesQuery(item(), "dev team")).toBe(true);
    expect(matchesQuery(item(), "")).toBe(true);
  });

  it("filters by category, owner and creation date", () => {
    const items = [
      item({ platform: "A", category: "Cloud", createdAt: NOW - 3 * DAY }),
      item({ platform: "B", category: "Banking", owner: "Me", createdAt: NOW - 40 * DAY }),
      item({ platform: "C", category: "Cloud", owner: "Me", createdAt: NOW - 400 * DAY }),
    ];
    const names = (f: Partial<typeof EMPTY_FILTER>) =>
      filterCredentials(items, { ...EMPTY_FILTER, ...f }, NOW).map((i) => i.platform);
    expect(names({ category: "Cloud" })).toEqual(["A", "C"]);
    expect(names({ owner: "Me" })).toEqual(["B", "C"]);
    expect(names({ created: "7d" })).toEqual(["A"]);
    expect(names({ created: "90d" })).toEqual(["A", "B"]);
    expect(names({ created: "older" })).toEqual(["C"]);
    expect(names({ category: "Cloud", owner: "Me" })).toEqual(["C"]);
  });

  it("collects distinct facets", () => {
    const f = facets([item(), item({ category: "Banking", owner: "", tags: ["prod", "money"] })]);
    expect(f.categories).toEqual(["Banking", "Cloud"]);
    expect(f.owners).toEqual(["Platform team"]);
    expect(f.tags).toEqual(["infra", "money", "prod"]);
  });

  it("parses tags leniently", () => {
    expect(parseTags("aws, prod , #infra,,Prod")).toEqual(["aws", "prod", "infra"]);
    expect(parseTags("")).toEqual([]);
  });

  it("builds a case-insensitive identity key", () => {
    expect(credentialKey({ platform: "AWS ", url: "https://A.com/", username: "Me" })).toBe(
      credentialKey({ platform: "aws", url: "https://a.com/", username: "me" }),
    );
  });
});

describe("generatePassword", () => {
  it("has the requested length and every character class", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword(20);
      expect(pw).toHaveLength(20);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^a-zA-Z0-9]/);
      expect(pw).not.toMatch(/[O0lI1]/);
    }
  });

  it("can omit symbols", () => {
    expect(generatePassword(16, false)).toMatch(/^[a-zA-Z0-9]{16}$/);
  });

  it("doesn't repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(seen.size).toBe(200);
  });

  it("rates strength sensibly", () => {
    expect(passwordStrength("").strength).toBe("empty");
    expect(passwordStrength("password").strength).toBe("weak");
    expect(passwordStrength("aaaaaaaaaaaaaaaaaaaa").strength).toBe("weak");
    expect(passwordStrength(generatePassword(20)).strength).toBe("strong");
  });
});
