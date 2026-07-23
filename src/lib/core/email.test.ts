import { describe, it, expect } from "vitest";
import { polishEmail } from "./email";

describe("polishEmail", () => {
  it("returns empty output for empty input", () => {
    expect(polishEmail("   ", "professional").output).toBe("");
  });

  it("adds a greeting and sign-off when missing", () => {
    const r = polishEmail("the report is ready for review", "professional");
    expect(r.output.startsWith("Hi [Name],")).toBe(true);
    expect(r.output).toContain("Best regards,");
    expect(r.output).toContain("[Your Name]");
    const reasons = r.issues.map((i) => i.reason).join(" ");
    expect(reasons).toContain("missing greeting");
    expect(reasons).toContain("missing sign-off");
  });

  it("normalizes a casual greeting and capitalizes the name", () => {
    const r = polishEmail("hey john\ncan you review the doc", "professional");
    expect(r.output.startsWith("Hi John,")).toBe(true);
    expect(r.issues.some((i) => i.reason.includes("casual greeting"))).toBe(true);
  });

  it("keeps an existing formal greeting and sign-off", () => {
    const r = polishEmail(
      "Dear Ms. Chen,\n\nThe report is attached.\n\nSincerely,\nJay",
      "professional",
    );
    expect(r.output.startsWith("Dear Ms. Chen,")).toBe(true);
    expect(r.output).toContain("Sincerely,");
    expect(r.output).toContain("Jay");
    expect(r.issues.filter((i) => i.reason.includes("greeting")).length).toBe(0);
  });

  it("replaces a casual sign-off with a corporate one", () => {
    const r = polishEmail("Hi Sam,\n\nSee attached.\n\ncheers\nJay", "professional");
    expect(r.output).toContain("Best regards,");
    expect(r.output).toContain("Jay");
    expect(r.output).not.toMatch(/cheers/i);
  });

  it("softens shouting caps but keeps business acronyms", () => {
    const r = polishEmail("Hi Sam,\n\nthis is URGENT, need the PDF by EOD\n\nThanks,\nJay", "professional");
    expect(r.output).not.toContain("URGENT");
    expect(r.output).toContain("PDF");
    expect(r.output).toContain("EOD");
    expect(r.issues.some((i) => i.reason.includes("shouting"))).toBe(true);
  });

  it("softens exclamation marks in professional mode", () => {
    const r = polishEmail("Hi Sam,\n\nsend it today!!\n\nThanks,\nJay", "professional");
    expect(r.output).not.toContain("!");
    expect(r.issues.some((i) => i.reason.includes("pushy"))).toBe(true);
  });

  it("keeps exclamations in Gen Z style", () => {
    const r = polishEmail("Hi Sam,\n\nthis is great!\n\nThanks,\nJay", "genz");
    expect(r.output).toContain("!");
  });

  it("runs grammar + style rewriting on the body", () => {
    const r = polishEmail(
      "hey,\n\ni dont think the report is gonna be ready becuase we was late\n\nthx\nJay",
      "professional",
    );
    expect(r.output).toContain("I do not think");
    expect(r.output).toContain("because");
    expect(r.output).toContain("we were");
    expect(r.output).toContain("Thanks,");
    const reasons = r.issues.map((i) => i.reason);
    expect(reasons).toContain("spelling");
    expect(reasons).toContain("subject–verb agreement");
  });

  it("preserves multi-paragraph structure", () => {
    const r = polishEmail(
      "Hi Sam,\n\nfirst point here\n\nsecond point here\n\nThanks,\nJay",
      "professional",
    );
    const body = r.output.split("\n\n");
    expect(body.length).toBeGreaterThanOrEqual(4); // greeting, 2 paragraphs, closing
    expect(r.output).toContain("First point here.");
    expect(r.output).toContain("Second point here.");
  });
});

describe("polishEmail — pasted single-line emails", () => {
  it("splits a greeting off a single-line email instead of swallowing the body", () => {
    const r = polishEmail("hi sam, can you send the report today", "professional");
    expect(r.output.startsWith("Hi Sam,")).toBe(true);
    expect(r.output).toContain("Can you send the report today.");
  });

  it("extracts a greeting buried mid-text and moves it to the top", () => {
    const r = polishEmail(
      "Please find the details below: Hello john.doe@corp.com, I want to update the policy.",
      "professional",
    );
    expect(r.output.startsWith("Hello john.doe@corp.com,")).toBe(true);
    expect(r.output).not.toContain("Hi [Name]");
    expect(r.issues.some((i) => i.reason.includes("buried mid-text"))).toBe(true);
  });

  it("detects an inline sign-off and does not append a duplicate", () => {
    const r = polishEmail(
      "Hi Sam,\n\nsee the attached file. Thank you and Regards, Jaya Chandra K.",
      "professional",
    );
    expect(r.output).toContain("Thank you and regards,\nJaya Chandra K.");
    expect(r.output).not.toContain("[Your Name]");
    expect((r.output.match(/regards/gi) || []).length).toBe(1);
  });

  it("keeps DOB and other business acronyms intact", () => {
    const r = polishEmail("Hi Sam,\n\nDOB: 16-03-2026 PAN: ABCDE1234F\n\nThanks,\nJay", "professional");
    expect(r.output).toContain("DOB:");
    expect(r.output).toContain("PAN:");
    expect(r.issues.every((i) => !i.reason.includes("shouting"))).toBe(true);
  });

  it("formats a details block one per line and resumes the courtesy sentence", () => {
    const input =
      "Please find the requested details below: Hello @deepthikalyani@visistarisk.com, I want to update my baby name as Kalla Ganvika Sri gayatri in the insurance policy. Baby Name: Baby Of Velagala Deepika DOB: 16-03-2026 Gender: Female Relationship: Daughter Please please inform me if any further information is required. Thank you and Regards, Jaya Chandra K.";
    const r = polishEmail(input, "professional");
    // Greeting extracted, not duplicated.
    expect(r.output.startsWith("Hello @deepthikalyani@visistarisk.com,")).toBe(true);
    expect(r.output).not.toContain("[Name]");
    // Details one per line, DOB preserved.
    expect(r.output).toContain("Baby Name: Baby Of Velagala Deepika\nDOB: 16-03-2026\nGender: Female\nRelationship: Daughter");
    // Courtesy sentence resumes as text with the repeated word fixed.
    expect(r.output).toContain("Please inform me if any further information is required.");
    expect(r.output).not.toContain("Please please");
    // Inline sign-off detected, no duplicate closing.
    expect(r.output).not.toContain("[Your Name]");
    expect(r.output.trimEnd().endsWith("Jaya Chandra K.")).toBe(true);
    expect((r.output.match(/regards/gi) || []).length).toBe(1);
  });
});

describe("grammar tense rules (via email body)", () => {
  it("fixes auxiliary + wrong verb form", () => {
    const r = polishEmail("Hi Sam,\n\nhe has went home and we have ate\n\nThanks,\nJay", "complete");
    expect(r.output).toContain("has gone");
    expect(r.output).toContain("have eaten");
  });
});
