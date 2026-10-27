import { describe, expect, it } from "vitest";
import { checkEmail } from "./email-checks";
import { applyFix } from "./issues";

const rules = (text: string) => checkEmail(text).map((issue) => issue.rule);

describe("email checks", () => {
  it("accepts a well-formed email", () => {
    expect(checkEmail("Hi Sam,\n\nThe report is ready for review.\n\nBest regards,\nAna")).toEqual([]);
  });

  it("suggests a greeting and a sign-off when missing", () => {
    const text = "The report is ready.\nCan you review it?";
    expect(rules(text)).toEqual(["no-greeting", "no-sign-off"]);
    const [greeting, signOff] = checkEmail(text);
    expect(applyFix(text, greeting, greeting.fixes[0]).text).toBe("Hi,\n\nThe report is ready.\nCan you review it?");
    expect(applyFix(text, signOff, signOff.fixes[0]).text).toBe(
      "The report is ready.\nCan you review it?\n\nBest regards,\n",
    );
  });

  it("flags casual greetings and sign-offs with work-email alternatives", () => {
    const text = "hey sam,\n\nShipping today.\n\ncheers\nAna";
    const issues = checkEmail(text);
    expect(issues.map((i) => i.rule)).toEqual(["casual-greeting", "casual-sign-off"]);
    expect(issues[0].problem).toBe("hey");
    expect(issues[1].fixes[0].text).toBe("Best regards");
    expect(applyFix(text, issues[1], issues[1].fixes[0]).text).toBe("hey sam,\n\nShipping today.\n\nBest regards\nAna");
  });

  it("flags shouting and pushy punctuation, but not acronyms", () => {
    const text = "Hi team,\n\nThis is URGENT!! Send the PDF to HR by EOD.\n\nThanks,\nAna";
    const issues = checkEmail(text);
    expect(issues.map((i) => [i.rule, i.problem])).toEqual([
      ["all-caps", "URGENT"],
      ["exclamations", "!!"],
    ]);
    expect(issues[0].fixes[0].text).toBe("urgent");
  });

  it("capitalizes a lowered word at the start of a sentence", () => {
    const [caps] = checkEmail("Hi,\n\nPLEASE reply.\n\nThanks");
    expect(caps.fixes[0].text).toBe("Please");
  });

  it("flags a placeholder left in", () => {
    expect(rules("Hi [Name],\n\nDone.\n\nThanks,\n[Your Name]")).toEqual(["placeholder", "placeholder"]);
  });

  it("checks nothing in an empty text", () => {
    expect(checkEmail("  \n ")).toEqual([]);
  });
});
