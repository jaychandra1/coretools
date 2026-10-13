/**
 * Login-URL handling. Only http(s) links are stored, so "Open link" can never
 * launch file:, javascript: or custom-protocol handlers. A bare host such as
 * "console.aws.amazon.com" is accepted and upgraded to https.
 */

export class UrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlError";
  }
}

/** Normalize user input to an http(s) URL, or "" for empty input. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new UrlError("That doesn't look like a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UrlError("Only http:// and https:// links can be saved.");
  }
  if (!url.hostname || !/[a-z0-9]/i.test(url.hostname)) {
    throw new UrlError("That doesn't look like a web address.");
  }
  if (url.username || url.password) {
    throw new UrlError("Don't put the username or password in the link — use the fields below.");
  }
  return url.href;
}

/** Compact display form: host + path, without scheme or trailing slash. */
export function displayUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}
