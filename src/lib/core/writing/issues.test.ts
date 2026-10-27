import { describe, expect, it } from "vitest";
import {
  applyAll,
  applyFix,
  categoryOf,
  countWords,
  fixLabel,
  ignoreKey,
  issueAt,
  messageParts,
  rebase,
  segments,
  stillValid,
  visibleIssues,
  type Issue,
} from "./issues";

function issueIn(text: string, problem: string, fixes: Issue["fixes"], extra: Partial<Issue> = {}): Issue {
  const start = text.indexOf(problem);
  if (start < 0) throw new Error(`"${problem}" not in "${text}"`);
  return {
    id: `t:${start}`,
    start,
    end: start + problem.length,
    category: "spelling",
    rule: "Spelling",
    title: "Spelling",
    message: "Did you mean `x`?",
    problem,
    fixes,
    ...extra,
  };
}

describe("applying fixes", () => {
  const text = "We recieve teh report.";

  it("replaces, removes and inserts exactly at the issue", () => {
    const recieve = issueIn(text, "recieve", [{ kind: "replace", text: "receive" }]);
    expect(applyFix(text, recieve, recieve.fixes[0])).toEqual({ text: "We receive teh report.", caret: 10 });
    const teh = issueIn(text, "teh ", [{ kind: "remove", text: "" }]);
    expect(applyFix(text, teh, teh.fixes[0]).text).toBe("We recieve report.");
    const start = { ...issueIn(text, "We", []), end: 0 };
    expect(applyFix(text, start, { kind: "insert-before", text: "Hi,\n\n" }).text).toBe("Hi,\n\nWe recieve teh report.");
    const end = issueIn(text, "report", []);
    expect(applyFix(text, end, { kind: "insert-after", text: "s" }).text).toBe("We recieve teh reports.");
  });

  it("fixes everything that has exactly one fix, from the end backwards", () => {
    const issues = [
      issueIn(text, "recieve", [{ kind: "replace", text: "receive" }]),
      issueIn(text, "teh", [{ kind: "replace", text: "the" }]),
      issueIn(text, "report", [{ kind: "replace", text: "reports" }, { kind: "replace", text: "result" }]),
    ];
    expect(applyAll(text, issues)).toEqual({ text: "We receive the report.", applied: 2 });
  });

  it("skips overlapping and outdated issues in Fix all", () => {
    const a = issueIn(text, "recieve teh", [{ kind: "replace", text: "receive the" }]);
    const b = issueIn(text, "teh", [{ kind: "replace", text: "the" }]);
    const outdated = { ...issueIn(text, "report", [{ kind: "replace", text: "x" }]), problem: "repo" };
    // The later fix applies; the one overlapping it waits for the next check.
    expect(applyAll(text, [a, b, outdated])).toEqual({ text: "We recieve the report.", applied: 1 });
  });
});

describe("keeping issues in place while typing", () => {
  const before = "Teh cat sat on teh mat.";
  const first = issueIn(before, "Teh", [{ kind: "replace", text: "The" }]);
  const second = { ...issueIn(before, "teh mat", [{ kind: "replace", text: "the mat" }]), id: "second" };

  it("shifts issues after the edit and keeps those before it", () => {
    const after = "Teh big cat sat on teh mat.";
    const moved = rebase([first, second], before, after);
    expect(moved).toHaveLength(2);
    for (const issue of moved) expect(stillValid(after, issue)).toBe(true);
  });

  it("drops an issue the edit touched", () => {
    const after = "The cat sat on teh mat.";
    const moved = rebase([first, second], before, after);
    expect(moved.map((i) => i.id)).toEqual(["second"]);
    expect(stillValid(after, moved[0])).toBe(true);
  });

  it("is a no-op without an edit", () => {
    expect(rebase([first], before, before)).toEqual([first]);
  });
});

describe("display helpers", () => {
  const text = "Teh cat sat.";
  const issue = issueIn(text, "Teh", [{ kind: "replace", text: "The" }]);

  it("splits text into plain and underlined runs, skipping zero-width issues", () => {
    const zero = { ...issue, id: "z", start: 12, end: 12 };
    expect(segments(text, [issue, zero])).toEqual([
      { text: "Teh", issue },
      { text: " cat sat.", issue: null },
    ]);
  });

  it("finds the issue under the caret", () => {
    expect(issueAt([issue], 1)?.id).toBe(issue.id);
    expect(issueAt([issue], 3)?.id).toBe(issue.id);
    expect(issueAt([issue], 5)).toBeNull();
  });

  it("hides ignored issues wherever they reappear", () => {
    const elsewhere = { ...issue, id: "other", start: 40, end: 43 };
    expect(visibleIssues([issue, elsewhere], new Set([ignoreKey(issue)]))).toEqual([]);
  });

  it("labels fixes and splits messages without rendering markup", () => {
    expect(fixLabel({ kind: "replace", text: "The" })).toBe("The");
    expect(fixLabel({ kind: "replace", text: "" })).toBe("Remove");
    expect(fixLabel({ kind: "replace", text: " " })).toBe("Fix spacing");
    expect(fixLabel({ kind: "insert-before", text: "Hi,\n\n" })).toBe("Add “Hi,”");
    expect(messageParts("Did you mean `<b>x</b>`?")).toEqual([
      { text: "Did you mean ", code: false },
      { text: "<b>x</b>", code: true },
      { text: "?", code: false },
    ]);
  });

  it("groups Harper's lint kinds", () => {
    expect(categoryOf("Spelling")).toBe("spelling");
    expect(categoryOf("Typo")).toBe("spelling");
    expect(categoryOf("Agreement")).toBe("grammar");
    expect(categoryOf("Punctuation")).toBe("grammar");
    expect(categoryOf("Redundancy")).toBe("style");
    expect(categoryOf("SomethingNew")).toBe("grammar");
  });

  it("counts words", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("It's a well-known fact — 42 times.")).toBe(6);
  });
});
