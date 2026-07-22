/**
 * Kubernetes manifest optimizer.
 *
 * Parses one or more YAML documents *safely* (data-only, no custom tags, with
 * an alias-expansion limit to prevent "billion laughs" style resource attacks),
 * validates that each document looks like a Kubernetes object, then strips
 * server-managed and redundant fields to produce a clean, apply-ready manifest.
 *
 * Everything runs in memory and returns a plain result object. No I/O.
 */

import { parseAllDocuments, stringify } from "yaml";

export interface OptimizeChange {
  /** Dotted path of the affected field, e.g. `metadata.creationTimestamp`. */
  path: string;
  /** What happened. */
  action: "removed" | "added";
  /** Human-readable justification, surfaced in the UI. */
  reason: string;
}

export interface OptimizeResult {
  /** Optimized manifest, or "" when the input could not be optimized. */
  output: string;
  /** Ordered log of every field that was removed or added. */
  changes: OptimizeChange[];
  /** Number of YAML documents processed. */
  documents: number;
  /** Whether every document passed Kubernetes shape validation. */
  valid: boolean;
  /** Validation / parse errors (empty when `valid` is true). */
  errors: string[];
}

/**
 * Fields the API server populates and that should never be committed to source
 * control or re-applied. Safe to remove wherever they appear.
 */
const SERVER_MANAGED_FIELDS = new Set([
  "creationTimestamp",
  "resourceVersion",
  "uid",
  "selfLink",
  "generation",
  "managedFields",
  "finalizers", // controller-managed; almost never authored by hand
]);

/** Annotations written by tooling that add noise to a source manifest. */
const NOISE_ANNOTATIONS = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
]);

/** Top-level keys that must survive even if they end up empty after cleaning. */
const REQUIRED_TOP_LEVEL = new Set(["apiVersion", "kind", "metadata", "spec"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Recursively clean a parsed value, recording every removal against `changes`.
 * `topLevel` is true only for the root object of a document, which lets us
 * apply rules (like stripping `status`) that only make sense there.
 */
function clean(
  value: unknown,
  path: string,
  changes: OptimizeChange[],
  topLevel: boolean,
): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item, i) => clean(item, `${path}[${i}]`, changes, false))
      .filter((item) => item !== undefined);
  }

  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;

    if (SERVER_MANAGED_FIELDS.has(key)) {
      changes.push({ path: childPath, action: "removed", reason: "server-managed field" });
      continue;
    }

    if (topLevel && key === "status") {
      changes.push({ path: childPath, action: "removed", reason: "cluster-reconciled status block" });
      continue;
    }

    if (NOISE_ANNOTATIONS.has(key)) {
      changes.push({ path: childPath, action: "removed", reason: "tooling-generated annotation" });
      continue;
    }

    const cleaned = clean(raw, childPath, changes, false);

    if (cleaned === null) {
      changes.push({ path: childPath, action: "removed", reason: "null value" });
      continue;
    }

    // Never drop required scaffolding keys, even if empty after cleaning.
    if (isEmptyContainer(cleaned) && !(topLevel && REQUIRED_TOP_LEVEL.has(key))) {
      changes.push({ path: childPath, action: "removed", reason: "empty value" });
      continue;
    }

    result[key] = cleaned;
  }

  return result;
}

/**
 * Canonical `apiVersion` for the standard Kubernetes kinds, used to repair
 * manifests that omit the field. Only unambiguous, current API groups are
 * listed — anything else stays a validation error rather than a guess.
 */
const KIND_TO_API_VERSION: Record<string, string> = {
  // core/v1
  Pod: "v1",
  Service: "v1",
  ConfigMap: "v1",
  Secret: "v1",
  Namespace: "v1",
  ServiceAccount: "v1",
  PersistentVolume: "v1",
  PersistentVolumeClaim: "v1",
  ReplicationController: "v1",
  ResourceQuota: "v1",
  LimitRange: "v1",
  Endpoints: "v1",
  Node: "v1",
  // apps/v1
  Deployment: "apps/v1",
  StatefulSet: "apps/v1",
  DaemonSet: "apps/v1",
  ReplicaSet: "apps/v1",
  // batch/v1
  Job: "batch/v1",
  CronJob: "batch/v1",
  // networking.k8s.io/v1
  Ingress: "networking.k8s.io/v1",
  IngressClass: "networking.k8s.io/v1",
  NetworkPolicy: "networking.k8s.io/v1",
  // rbac.authorization.k8s.io/v1
  Role: "rbac.authorization.k8s.io/v1",
  RoleBinding: "rbac.authorization.k8s.io/v1",
  ClusterRole: "rbac.authorization.k8s.io/v1",
  ClusterRoleBinding: "rbac.authorization.k8s.io/v1",
  // other stable groups
  HorizontalPodAutoscaler: "autoscaling/v2",
  PodDisruptionBudget: "policy/v1",
  StorageClass: "storage.k8s.io/v1",
  CustomResourceDefinition: "apiextensions.k8s.io/v1",
};

/**
 * If `apiVersion` is missing but the `kind` is a standard Kubernetes kind,
 * add the canonical apiVersion (as the first key, matching convention) and
 * record the addition. Returns the (possibly repaired) document.
 */
function repairApiVersion(
  obj: Record<string, unknown>,
  changes: OptimizeChange[],
): Record<string, unknown> {
  if (obj.apiVersion || typeof obj.kind !== "string") return obj;
  const inferred = KIND_TO_API_VERSION[obj.kind];
  if (!inferred) return obj;
  changes.push({
    path: "apiVersion",
    action: "added",
    reason: `was missing — set to "${inferred}" (standard for kind ${obj.kind})`,
  });
  return { apiVersion: inferred, ...obj };
}

/** Validate the Kubernetes-required scaffolding of a single document. */
function validateManifest(obj: unknown, index: number, errors: string[]): void {
  const label = `document ${index + 1}`;
  if (!isPlainObject(obj)) {
    errors.push(`${label}: not a YAML mapping`);
    return;
  }
  if (!obj.apiVersion) {
    errors.push(
      typeof obj.kind === "string"
        ? `${label}: missing required field "apiVersion" (could not infer it for kind "${obj.kind}")`
        : `${label}: missing required field "apiVersion"`,
    );
  }
  if (!obj.kind) errors.push(`${label}: missing required field "kind"`);

  const metadata = obj.metadata;
  if (!isPlainObject(metadata)) {
    errors.push(`${label}: missing required field "metadata"`);
  } else if (!metadata.name && !metadata.generateName) {
    errors.push(`${label}: missing required field "metadata.name"`);
  }
}

/**
 * Optimize a (possibly multi-document) Kubernetes YAML manifest.
 *
 * Parsing is intentionally strict and data-only:
 *  - `maxAliasCount` caps alias expansion to defuse resource-exhaustion attacks.
 *  - No custom/JS tags are enabled, so parsing can never instantiate arbitrary
 *    objects or execute code — it only ever produces plain data.
 */
export function optimizeManifest(input: string): OptimizeResult {
  const errors: string[] = [];
  const changes: OptimizeChange[] = [];

  if (input.trim() === "") {
    return { output: "", changes, documents: 0, valid: false, errors: ["Input is empty"] };
  }

  let parsed;
  try {
    parsed = parseAllDocuments(input, {
      strict: true,
      // Data-only core schema: no `!!js` / custom tags, no code execution.
      schema: "core",
    });
  } catch (e) {
    return { output: "", changes, documents: 0, valid: false, errors: [`Parse error: ${String(e)}`] };
  }

  // Surface parser-level errors (malformed YAML, alias-limit exceeded, ...).
  for (const doc of parsed) {
    for (const err of doc.errors) errors.push(err.message);
  }

  const cleanedDocs: unknown[] = [];
  parsed.forEach((doc, index) => {
    // `maxAliasCount` caps alias expansion to defuse "billion laughs" style
    // resource-exhaustion attacks (this is also the library default).
    let js = doc.toJS({ maxAliasCount: 100 });
    if (js === null || js === undefined) return; // skip empty documents
    // Repair a missing apiVersion (inferred from the kind) before validating,
    // so a repaired document validates clean.
    if (isPlainObject(js)) js = repairApiVersion(js, changes);
    validateManifest(js, index, errors);
    cleanedDocs.push(clean(js, "", changes, true));
  });

  if (cleanedDocs.length === 0) {
    return {
      output: "",
      changes,
      documents: 0,
      valid: false,
      errors: errors.length ? errors : ["No Kubernetes documents found"],
    };
  }

  const rendered = cleanedDocs
    .map((doc) => stringify(doc, { lineWidth: 0, sortMapEntries: false }))
    .join("---\n");

  return {
    output: rendered,
    changes,
    documents: cleanedDocs.length,
    valid: errors.length === 0,
    errors,
  };
}
