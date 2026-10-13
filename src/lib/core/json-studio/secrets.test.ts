import { describe, it, expect } from "vitest";
import { findSecret } from "./secrets";

describe("findSecret", () => {
  it("spots common credential shapes", () => {
    const cases: Array<[string, RegExp]> = [
      ['{"key":"-----BEGIN RSA PRIVATE KEY-----\\nMII..."}', /private key/],
      ['{"id":"AKIAIOSFODNN7EXAMPLE"}', /AWS/],
      ['{"t":"ghp_' + "a".repeat(36) + '"}', /GitHub/],
      ['{"k":"AIza' + "b".repeat(35) + '"}', /Google/],
      ['{"slack":"xoxb-1234567890-abcdef"}', /Slack/],
      ['{"stripe":"sk_live_' + "c".repeat(24) + '"}', /Stripe/],
      ['{"jwt":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl"}', /JSON Web Token/],
      ['{"password": "hunter22!"}', /password or token/],
      ['{"client_secret":"GOCSPX-abcdef"}', /password or token/],
      ['{"Refresh_Token":"1//0gabcdef"}', /password or token/],
    ];
    for (const [text, label] of cases) {
      expect(findSecret(text), text).toMatch(label);
    }
  });

  it("leaves ordinary documents alone", () => {
    for (const text of [
      '{"project":"CoreTools","version":1,"features":["diff"]}',
      '{"password": ""}', // empty
      '{"password": null}',
      '{"passwordPolicy": {"minLength": 12}}',
      '{"token_type": "Bearer", "expires_in": 3600}',
      "",
    ]) {
      expect(findSecret(text), text).toBeNull();
    }
  });

  it("checks every text given", () => {
    expect(findSecret("{}", "", '{"api_key":"abcdef123"}')).toMatch(/token field/);
  });
});
