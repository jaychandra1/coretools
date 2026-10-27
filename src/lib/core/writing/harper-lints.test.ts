/**
 * The real engine, in Node: Harper's inlined build (the WebAssembly file as a
 * data: URL; the app loads the same engine from a file in its worker).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { LocalLinter } from "harper.js";
import { slimBinaryInlined } from "harper.js/slimBinaryInlined";
import { harperDialect, lintText } from "./harper-lints";
import { applyAll, applyFix, stillValid, type Issue } from "./issues";

let linter: LocalLinter;

beforeAll(async () => {
  linter = new LocalLinter({ binary: slimBinaryInlined, dialect: harperDialect("american") });
  await linter.setup();
}, 60_000);

async function check(text: string): Promise<Issue[]> {
  return lintText(linter, text);
}

describe("Harper finds real mistakes", () => {
  it.each([
    ["The the report is ready.", "Repetition", "The"],
    ["The report is due tommorow.", "spelling", "tomorrow"],
    ["We recieve feedback weekly.", "spelling", "receive"],
    ["We get feedback alot.", "grammar", "a lot"],
    ["He go to the office every day.", "grammar", "goes"],
    ["Its a big issue for the team.", "grammar", "It's"],
    ["Irregardless of the outcome, we ship.", "spelling", "Regardless"],
  ])("%s", async (text, expected, fix) => {
    const issues = await check(text);
    expect(issues.length).toBeGreaterThan(0);
    const issue = issues[0];
    expect([issue.category, issue.rule]).toContain(expected);
    expect(issue.fixes.map((f) => f.text)).toContain(fix);
    expect(stillValid(text, issue)).toBe(true);
  });

  it("produces correct text when its fixes are applied", async () => {
    const text = "The the report is due tommorow and we get feedback alot.";
    const fixed = applyAll(text, await check(text)).text;
    expect(fixed).toBe("The report is due tomorrow and we get feedback a lot.");
    // The mistakes are gone. (Harper may still offer a style hint without a fix.)
    const left = (await check(fixed)).filter((issue) => issue.fixes.length > 0);
    expect(left).toEqual([]);
  });
});

describe("Harper leaves good text alone", () => {
  it.each([
    "Please find the attached document for your reference.",
    "Can you help me with the deployment? I also need the logs.",
    "The release is delayed because of an issue in our build pipeline.",
    "Our users love it. Do you have any idea when it will be ready?",
    "Thanks for the quick reply — I'll review the draft this afternoon.",
    "Visit https://example.com/docs or email me at jane.doe@example.com today.",
  ])("%s", async (text) => {
    expect(await check(text)).toEqual([]);
  });

  it("returns nothing for empty text", async () => {
    expect(await check("   \n")).toEqual([]);
  });
});

describe("Harper's settings", () => {
  it("accepts words from the user's dictionary", async () => {
    const text = "Priya reviewed the Kubeflow pipeline.";
    expect((await check(text)).map((i) => i.problem)).toContain("Priya");
    await linter.importWords(["Priya", "Kubeflow"]);
    expect(await check(text)).toEqual([]);
    await linter.clearWords();
  });

  it("follows the chosen dialect", async () => {
    const text = "The colour of the logo changed.";
    await linter.setDialect(harperDialect("american"));
    expect((await check(text)).map((i) => i.problem)).toContain("colour");
    await linter.setDialect(harperDialect("british"));
    expect(await check(text)).toEqual([]);
    await linter.setDialect(harperDialect("american"));
  });

  it("reports positions as JavaScript string offsets, emoji included", async () => {
    const text = "😀😀 Teh cat sat on teh mat.";
    const issues = await check(text);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(stillValid(text, issue)).toBe(true);
    const fixed = issues.reduceRight((acc, issue) => applyFix(acc, issue, issue.fixes[0]).text, text);
    expect(fixed).toBe("😀😀 The cat sat on the mat.");
  });
});
