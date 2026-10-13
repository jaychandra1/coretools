/**
 * Search and filters for the credential list — pure, so they're unit-tested.
 * Search covers metadata only (platform, URL, username, tags, category,
 * owner); passwords and notes are encrypted and never searched.
 */

import type { CredentialFields } from "./types";

export type CreatedRange = "any" | "7d" | "30d" | "90d" | "year" | "older";

export const CREATED_RANGES: Array<{ value: CreatedRange; label: string }> = [
  { value: "any", label: "Any time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "year", label: "Last 12 months" },
  { value: "older", label: "Older than a year" },
];

export interface CredentialFilter {
  query: string;
  category: string;
  owner: string;
  created: CreatedRange;
}

export const EMPTY_FILTER: CredentialFilter = {
  query: "",
  category: "",
  owner: "",
  created: "any",
};

type Searchable = CredentialFields & { createdAt: number };

const DAY = 24 * 60 * 60 * 1000;

function inRange(createdAt: number, range: CreatedRange, now: number): boolean {
  const age = now - createdAt;
  switch (range) {
    case "any":
      return true;
    case "7d":
      return age <= 7 * DAY;
    case "30d":
      return age <= 30 * DAY;
    case "90d":
      return age <= 90 * DAY;
    case "year":
      return age <= 365 * DAY;
    case "older":
      return age > 365 * DAY;
  }
}

/** Every whitespace-separated term must match some searchable field. */
export function matchesQuery(item: Searchable, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    item.platform,
    item.url,
    item.username,
    item.category,
    item.owner,
    ...item.tags.map((t) => `#${t}`),
    ...item.tags,
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterCredentials<T extends Searchable>(
  items: readonly T[],
  filter: CredentialFilter,
  now: number,
): T[] {
  return items.filter(
    (item) =>
      matchesQuery(item, filter.query) &&
      (!filter.category || item.category === filter.category) &&
      (!filter.owner || item.owner === filter.owner) &&
      inRange(item.createdAt, filter.created, now),
  );
}

/** Distinct, sorted values for the filter dropdowns and form suggestions. */
export function facets(items: readonly CredentialFields[]): {
  categories: string[];
  owners: string[];
  tags: string[];
} {
  const sorted = (values: Iterable<string>) =>
    [...new Set([...values].filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  return {
    categories: sorted(items.map((i) => i.category)),
    owners: sorted(items.map((i) => i.owner)),
    tags: sorted(items.flatMap((i) => i.tags)),
  };
}

/** "aws, prod , #infra,,prod" → ["aws", "prod", "infra"] */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const tag = raw.trim().replace(/^#+/, "").slice(0, 40);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags.slice(0, 20);
}
