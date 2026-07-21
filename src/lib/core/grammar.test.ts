import { describe, it, expect } from "vitest";
import { checkGrammar } from "./grammar";

describe("checkGrammar", () => {
  it("returns empty result for empty input", () => {
    const r = checkGrammar("   ");
    expect(r.corrected).toBe("");
    expect(r.issues).toEqual([]);
  });

  it("reports no issues for a clean sentence", () => {
    const r = checkGrammar("The report is ready for review.");
    expect(r.corrected).toBe("The report is ready for review.");
    expect(r.issues).toEqual([]);
  });

  it("fixes common misspellings", () => {
    const r = checkGrammar("I definately recieve alot of mail.");
    expect(r.corrected).toBe("I definitely receive a lot of mail.");
    const reasons = r.issues.map((i) => i.reason);
    expect(reasons.filter((x) => x === "spelling").length).toBeGreaterThanOrEqual(2);
  });

  it("adds missing apostrophes", () => {
    const r = checkGrammar("I dont think they cant do it.");
    expect(r.corrected).toBe("I don't think they can't do it.");
    expect(r.issues.some((i) => i.from === "dont" && i.to === "don't")).toBe(true);
  });

  it('fixes "should of" family', () => {
    const r = checkGrammar("You should of told me.");
    expect(r.corrected).toBe("You should have told me.");
    expect(r.issues.some((i) => i.to === "should have")).toBe(true);
  });

  it("fixes subject-verb agreement", () => {
    const r = checkGrammar("He don't know and they was late.");
    expect(r.corrected).toBe("He doesn't know and they were late.");
  });

  it('fixes "a" vs "an" with exceptions', () => {
    const r = checkGrammar("She ate a apple at a university.");
    expect(r.corrected).toBe("She ate an apple at a university.");
    expect(r.issues.filter((i) => i.reason.includes("article")).length).toBe(1);
  });

  it("removes repeated words", () => {
    const r = checkGrammar("We reviewed the the document.");
    expect(r.corrected).toBe("We reviewed the document.");
    expect(r.issues.some((i) => i.reason === "repeated word")).toBe(true);
  });

  it('capitalizes standalone "i" and sentence starts, adds end punctuation', () => {
    const r = checkGrammar("i think this works");
    expect(r.corrected).toBe("I think this works.");
    const reasons = r.issues.map((i) => i.reason);
    expect(reasons).toContain('capitalize "I"');
    expect(reasons).toContain("missing end punctuation");
  });

  it('fixes the "its" typo but keeps the possessive', () => {
    const typo = checkGrammar("its a good plan.");
    expect(typo.corrected).toBe("It's a good plan.");
    const possessive = checkGrammar("The dog wagged its tail.");
    expect(possessive.corrected).toBe("The dog wagged its tail.");
    expect(possessive.issues).toEqual([]);
  });

  it('fixes "your welcome"', () => {
    const r = checkGrammar("Your welcome to join.");
    expect(r.corrected).toBe("You're welcome to join.");
  });

  it("collapses extra spaces and reports it once", () => {
    const r = checkGrammar("Too   many    spaces here.");
    expect(r.corrected).toBe("Too many spaces here.");
    expect(r.issues.filter((i) => i.reason === "extra spaces").length).toBe(1);
  });
});
