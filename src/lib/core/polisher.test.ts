import { describe, it, expect } from "vitest";
import { polish } from "./polisher";

describe("polish — professional", () => {
  it("formalizes casual phrasing and expands contractions", () => {
    const out = polish(
      "hey, i think the report is gonna be late but its really good stuff",
      "professional",
    );
    expect(out).toBe(
      "Hello, I think the report is going to be late, however, it is good material.",
    );
  });

  it("expands txt-speak", () => {
    const out = polish("u should send me the docs asap", "professional");
    expect(out).toBe("You should send me the documentation as soon as possible.");
  });

  it("rewrites sentence-opening conjunctions", () => {
    expect(polish("but we missed the deadline", "professional")).toBe(
      "However, we missed the deadline.",
    );
    expect(polish("so we shipped it", "professional")).toBe(
      "Therefore, we shipped it.",
    );
  });

  it("removes filler words", () => {
    const out = polish("this is just really very important", "professional");
    expect(out).toBe("This is important.");
  });

  it("expands n't contractions", () => {
    const out = polish("I don't think he doesn't know", "professional");
    expect(out).toBe("I do not think he does not know.");
  });
});

describe("polish — genz", () => {
  it("applies slang and drops the final period", () => {
    const out = polish(
      "this restaurant is amazing and the food is delicious, honestly the best",
      "genz",
    );
    expect(out).toBe("this restaurant is fire and the food is bussin, ngl the goat");
  });

  it("lowercases and appends 'no cap' when no slang marker present", () => {
    const out = polish("The meeting went well.", "genz");
    expect(out.endsWith("no cap")).toBe(true);
    expect(out).toBe(out.toLowerCase());
  });

  it("contracts formal phrasing", () => {
    expect(polish("I am going to be late", "genz")).toContain("i'm gonna");
  });
});

describe("polish — complete", () => {
  it("expands abbreviations and contractions into full sentences", () => {
    const out = polish("u should send me the docs asap cuz idk the specs", "complete");
    expect(out).toBe(
      "You should send me the documentation as soon as possible because I do not know the specifications.",
    );
  });

  it("fixes casing and terminal punctuation", () => {
    expect(polish("it works. i checked twice", "complete")).toBe(
      "It works. I checked twice.",
    );
  });
});

describe("polish — edge cases", () => {
  it("returns empty string for empty/whitespace input", () => {
    expect(polish("", "professional")).toBe("");
    expect(polish("   ", "genz")).toBe("");
  });

  it("never throws on punctuation-heavy input", () => {
    expect(() => polish("wow!!! really??  ...ok", "professional")).not.toThrow();
  });
});
