import { describe, expect, it } from "vitest";
import { rewrite } from "./rewrite";

describe("rewrite — professional", () => {
  it("spells out chat shorthand and contractions", () => {
    expect(rewrite("hey team, pls send the report asap. I'm gonna review it, can't wait", "professional")).toBe(
      "Hello team, please send the report as soon as possible. I am going to review it, cannot wait",
    );
  });

  it("keeps an all-capitals abbreviation lowercase mid-sentence", () => {
    expect(rewrite("Send it ASAP please", "professional")).toBe("Send it as soon as possible please");
    expect(rewrite("ASAP is fine", "professional")).toBe("As soon as possible is fine");
  });

  it("leaves ambiguous contractions alone", () => {
    expect(rewrite("He's been here and she'd know.", "professional")).toBe("He's been here and she'd know.");
  });

  it("doesn't mistake U.S. for you", () => {
    expect(rewrite("Sales in the U.S. grew", "professional")).toBe("Sales in the U.S. grew");
  });
});

describe("rewrite — friendly", () => {
  it("uses contractions and everyday words", () => {
    expect(rewrite("Dear Sam,\nI am writing regarding the invoice. Please do not hesitate to contact me.", "friendly")).toBe(
      "Hi Sam,\nI'm writing about the invoice. Feel free to reach out.",
    );
  });

  it("never contracts at the end of a clause", () => {
    expect(rewrite("That is how it is.", "friendly")).toBe("That's how it is.");
    expect(rewrite("I know who you are.", "friendly")).toBe("I know who you are.");
  });

  it("keeps meanings: kindly and sincerely only where they're formulas", () => {
    expect(rewrite("She kindly agreed. I sincerely apologize.", "friendly")).toBe(
      "She kindly agreed. I sincerely apologize.",
    );
    expect(rewrite("Kindly review it.\n\nSincerely,\nAna", "friendly")).toBe("Please review it.\n\nBest,\nAna");
  });
});

describe("rewrite — concise", () => {
  it("cuts filler and wordy phrases", () => {
    expect(
      rewrite("Basically, we need to meet in order to make a decision due to the fact that the deadline is very close.", "concise"),
    ).toBe("We need to meet to decide because the deadline is close.");
  });

  it("keeps fillers that carry meaning", () => {
    for (const text of [
      "It's not just a bug.",
      "Thank you very much.",
      "Really?",
      "We found quite a few issues.",
      "Very well, let's go.",
    ]) {
      expect(rewrite(text, "concise")).toBe(text);
    }
  });

  it("drops an opening phrase and capitalizes what follows", () => {
    expect(rewrite("Please be advised that the office is closed.", "concise")).toBe("The office is closed.");
  });
});

describe("rewrite — what is never touched", () => {
  const untouchable = [
    "Read https://example.com/docs/really-very-just and www.example.org/in-order-to",
    "Email jane.really@example.com about it",
    "Run `gonna --asap` in the shell",
    "Ping @just_really and #very-important",
    "Open src/very/basically.ts and config.yaml",
    "Set really_very_just to true",
  ];

  it.each(untouchable)("leaves links, addresses, code, mentions and file names alone: %s", (text) => {
    for (const tone of ["professional", "friendly", "concise"] as const) {
      const out = rewrite(text, tone);
      for (const token of text.match(/https?:\S+|www\.\S+|\S+@\S+|`[^`]+`|[@#]\S+|\S+\/\S+|\S+\.(?:ts|yaml)|\w+_\w+/g) ?? []) {
        expect(out).toContain(token);
      }
    }
  });

  it("keeps line breaks and indentation", () => {
    const text = "Hi,\n\n  - item one is really done\n  - item two\n\nThanks";
    expect(rewrite(text, "concise")).toBe("Hi,\n\n  - item one is done\n  - item two\n\nThanks");
  });

  it("returns the same string when there's nothing to change", () => {
    const text = "The deployment finished  at noon.";
    expect(rewrite(text, "concise")).toBe(text);
    expect(rewrite("", "professional")).toBe("");
  });
});
