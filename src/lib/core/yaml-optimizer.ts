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
  action: "removed" | "added" | "renamed";
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

/**
 * Strip non-YAML noise that commonly rides along with pasted manifests:
 * Markdown code fences, shell prompts, and heredoc wrappers. Conservative on
 * purpose — anything that could be real YAML is left alone.
 */
function sanitizeInput(input: string, changes: OptimizeChange[]): string {
  const kept: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    const isNoise =
      /^```/.test(trimmed) || // Markdown code fence
      /^\$\s+\S/.test(trimmed) || // shell prompt: "$ kubectl apply -f -"
      /^cat\s+<<-?\s*['"]?EOF['"]?/.test(trimmed) || // heredoc opener
      trimmed === "EOF"; // heredoc terminator
    if (isNoise) {
      changes.push({
        path: "(input)",
        action: "removed",
        reason: `non-YAML line stripped: "${trimmed.slice(0, 40)}"`,
      });
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Canonical camelCase Kubernetes field names. Keys that match one of these
 * case-insensitively but are cased differently (e.g. `imagepullsecrets`,
 * `serviceaccount`) are invalid — the API server's strict decoding rejects
 * them — and get renamed to the canonical form.
 */
const CANONICAL_FIELD_NAMES = [
  // metadata / common
  "apiVersion", "generateName", "ownerReferences",
  // workloads
  "revisionHistoryLimit", "progressDeadlineSeconds", "minReadySeconds",
  "serviceName", "podManagementPolicy", "updateStrategy", "volumeClaimTemplates",
  "matchLabels", "matchExpressions", "rollingUpdate", "maxSurge", "maxUnavailable",
  "activeDeadlineSeconds", "backoffLimit", "ttlSecondsAfterFinished", "jobTemplate",
  "concurrencyPolicy", "startingDeadlineSeconds", "successfulJobsHistoryLimit",
  "failedJobsHistoryLimit",
  // pod spec
  "initContainers", "imagePullSecrets", "imagePullPolicy", "serviceAccount",
  "serviceAccountName", "automountServiceAccountToken", "nodeSelector", "nodeName",
  "hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace", "securityContext",
  "restartPolicy", "terminationGracePeriodSeconds", "dnsPolicy", "dnsConfig",
  "hostAliases", "priorityClassName", "runtimeClassName", "enableServiceLinks",
  "topologySpreadConstraints", "schedulerName", "readinessGates",
  "ephemeralContainers", "setHostnameAsFQDN",
  // containers
  "containerPort", "hostPort", "hostIP", "envFrom", "valueFrom", "fieldRef",
  "fieldPath", "resourceFieldRef", "configMapRef", "configMapKeyRef", "secretRef",
  "secretKeyRef", "volumeMounts", "mountPath", "mountPropagation", "subPath",
  "subPathExpr", "readOnly", "volumeDevices", "devicePath", "livenessProbe",
  "readinessProbe", "startupProbe", "initialDelaySeconds", "periodSeconds",
  "timeoutSeconds", "failureThreshold", "successThreshold", "httpGet", "tcpSocket",
  "httpHeaders", "workingDir", "terminationMessagePath", "terminationMessagePolicy",
  "postStart", "preStop",
  // security context
  "runAsUser", "runAsGroup", "runAsNonRoot", "readOnlyRootFilesystem",
  "allowPrivilegeEscalation", "fsGroup", "seLinuxOptions", "seccompProfile",
  "supplementalGroups", "procMount", "fsGroupChangePolicy",
  // volumes
  "persistentVolumeClaim", "claimName", "hostPath", "emptyDir", "configMap",
  "secretName", "defaultMode", "sizeLimit", "storageClassName", "accessModes",
  "volumeMode", "volumeName", "downwardAPI", "serviceAccountToken",
  "expirationSeconds",
  // service / networking
  "clusterIP", "clusterIPs", "externalIPs", "targetPort", "nodePort",
  "appProtocol", "sessionAffinity", "externalName", "externalTrafficPolicy",
  "internalTrafficPolicy", "healthCheckNodePort", "loadBalancerIP",
  "loadBalancerClass", "loadBalancerSourceRanges", "publishNotReadyAddresses",
  "ipFamilies", "ipFamilyPolicy", "ingressClassName", "defaultBackend", "pathType",
  // autoscaling
  "scaleTargetRef", "minReplicas", "maxReplicas",
  "targetCPUUtilizationPercentage", "averageUtilization", "averageValue",
] as const;

const CANONICAL_BY_LOWER = new Map(
  CANONICAL_FIELD_NAMES.map((f) => [f.toLowerCase(), f]),
);

/** Deprecated field aliases upgraded to the current API field. */
const FIELD_UPGRADES: Record<string, string> = {
  serviceAccount: "serviceAccountName",
};

/**
 * Keys whose values are user-defined maps (labels, config data, resource
 * quantities) — their child keys are data, not schema fields, and must never
 * be renamed.
 */
const USER_DATA_KEYS = new Set([
  "labels", "annotations", "data", "stringData", "binaryData", "matchLabels",
  "nodeSelector", "limits", "requests",
]);

/**
 * Recursively fix invalid field-name casing and deprecated aliases, recording
 * every rename. Runs before validation and repair so downstream logic sees
 * canonical names.
 */
function normalizeFieldNames(
  value: unknown,
  path: string,
  changes: OptimizeChange[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => normalizeFieldNames(item, `${path}[${i}]`, changes));
  }
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;

    // Resolve the canonical name: case fix first, then deprecated upgrade.
    let target = key;
    const canonical = CANONICAL_BY_LOWER.get(key.toLowerCase());
    if (canonical && key !== canonical) target = canonical;
    if (FIELD_UPGRADES[target]) target = FIELD_UPGRADES[target];

    if (target !== key) {
      if (target in value || target in out) {
        // The canonical field also exists — the misspelled one is a duplicate.
        changes.push({
          path: childPath,
          action: "removed",
          reason: `duplicate of "${target}" — invalid field name dropped`,
        });
        continue;
      }
      changes.push({
        path: childPath,
        action: "renamed",
        reason:
          key.toLowerCase() === target.toLowerCase()
            ? `invalid field name — the API expects "${target}"`
            : `deprecated/invalid field — the API expects "${target}"`,
      });
    }

    // Child keys of user-data maps are data, never schema fields.
    out[target] = USER_DATA_KEYS.has(target)
      ? raw
      : normalizeFieldNames(raw, path ? `${path}.${target}` : target, changes);
  }
  return out;
}

/** Workload kinds whose spec requires a selector and a pod template. */
const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"]);

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/**
 * Rebuild an object with `priority` keys first (in that order), then the
 * remaining keys in their original order. Used to emit conventional
 * Kubernetes key ordering regardless of input or repair insertion order.
 */
function orderKeys(
  obj: Record<string, unknown>,
  priority: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of priority) {
    if (key in obj) out[key] = obj[key];
  }
  for (const [key, value] of Object.entries(obj)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * Add missing mandatory fields with sensible, clearly-flagged defaults so the
 * output is structurally apply-ready. Every addition is recorded. Existing
 * values are never overwritten.
 */
function repairMandatoryFields(
  obj: Record<string, unknown>,
  changes: OptimizeChange[],
): Record<string, unknown> {
  const kind = typeof obj.kind === "string" ? obj.kind : "";

  // --- metadata.name ------------------------------------------------------
  const metadata = asObject(obj.metadata);
  if (!isPlainObject(obj.metadata)) {
    obj.metadata = metadata;
  }
  if (!metadata.name && !metadata.generateName) {
    const name = kind ? `unnamed-${kind.toLowerCase()}` : "unnamed-resource";
    metadata.name = name;
    changes.push({
      path: "metadata.name",
      action: "added",
      reason: `was missing — defaulted to "${name}" (rename before applying)`,
    });
  }
  const name = String(metadata.name ?? metadata.generateName ?? "app");

  // --- workload spec: template, labels, selector --------------------------
  if (WORKLOAD_KINDS.has(kind)) {
    const spec = asObject(obj.spec);
    if (!isPlainObject(obj.spec)) {
      obj.spec = spec;
      changes.push({ path: "spec", action: "added", reason: "was missing — required" });
    }

    // Pod template.
    if (!isPlainObject(spec.template)) {
      spec.template = {
        metadata: { labels: { app: name } },
        spec: {
          containers: [{ name, image: "your-image:latest" }],
        },
      };
      changes.push({
        path: "spec.template",
        action: "added",
        reason: 'was missing — added minimal pod template (set a real container image)',
      });
    }
    const template = asObject(spec.template);
    const templateMeta = asObject(template.metadata);
    if (!isPlainObject(template.metadata)) template.metadata = templateMeta;

    // Template labels (needed for the selector to match).
    let labels = asObject(templateMeta.labels);
    if (!isPlainObject(templateMeta.labels) || Object.keys(labels).length === 0) {
      // Derive from an existing selector if there is one, else app: <name>.
      const existingSelector = asObject(asObject(spec.selector).matchLabels);
      labels = Object.keys(existingSelector).length ? { ...existingSelector } : { app: name };
      templateMeta.labels = labels;
      changes.push({
        path: "spec.template.metadata.labels",
        action: "added",
        reason: "was missing — labels are required for the selector to match",
      });
    }

    // Selector matching the template labels.
    if (!isPlainObject(spec.selector)) {
      spec.selector = { matchLabels: { ...labels } };
      changes.push({
        path: "spec.selector",
        action: "added",
        reason: "was missing — set to match the pod template labels",
      });
    }

    // StatefulSet additionally requires serviceName.
    if (kind === "StatefulSet" && !spec.serviceName) {
      spec.serviceName = name;
      changes.push({
        path: "spec.serviceName",
        action: "added",
        reason: `was missing — defaulted to "${name}"`,
      });
    }
  }

  // --- Job pod template ----------------------------------------------------
  if (kind === "Job") {
    const spec = asObject(obj.spec);
    if (!isPlainObject(obj.spec)) {
      obj.spec = spec;
      changes.push({ path: "spec", action: "added", reason: "was missing — required" });
    }
    if (!isPlainObject(spec.template)) {
      spec.template = {
        spec: {
          containers: [{ name, image: "your-image:latest" }],
          restartPolicy: "Never",
        },
      };
      changes.push({
        path: "spec.template",
        action: "added",
        reason: 'was missing — added minimal pod template (set a real container image)',
      });
    }
  }

  // --- Service: selector and ports -----------------------------------------
  if (kind === "Service") {
    const spec = asObject(obj.spec);
    if (!isPlainObject(obj.spec)) {
      obj.spec = spec;
      changes.push({ path: "spec", action: "added", reason: "was missing — required" });
    }
    if (!isPlainObject(spec.selector) || Object.keys(asObject(spec.selector)).length === 0) {
      spec.selector = { app: name };
      changes.push({
        path: "spec.selector",
        action: "added",
        reason: `was missing — defaulted to app: ${name} (match your pod labels)`,
      });
    }
    if (!Array.isArray(spec.ports) || spec.ports.length === 0) {
      spec.ports = [{ port: 80, targetPort: 80 }];
      changes.push({
        path: "spec.ports",
        action: "added",
        reason: "was missing — defaulted to port 80 (adjust to your app)",
      });
    }
  }

  // --- conventional key ordering -------------------------------------------
  if (isPlainObject(obj.spec)) {
    const spec = obj.spec as Record<string, unknown>;
    if (isPlainObject(spec.template)) {
      spec.template = orderKeys(spec.template as Record<string, unknown>, ["metadata", "spec"]);
    }
    obj.spec = orderKeys(spec, ["replicas", "serviceName", "selector", "template"]);
  }
  return orderKeys(obj, ["apiVersion", "kind", "metadata", "spec"]);
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

  // Per-kind schema checks (run after repair, so failures mean the repair
  // could not fix the document).
  const kind = typeof obj.kind === "string" ? obj.kind : "";
  const spec = isPlainObject(obj.spec) ? obj.spec : undefined;

  if (WORKLOAD_KINDS.has(kind)) {
    if (!spec) {
      errors.push(`${label}: missing required field "spec"`);
    } else {
      if (!isPlainObject(spec.selector)) {
        errors.push(`${label}: missing required field "spec.selector"`);
      }
      if (!isPlainObject(spec.template)) {
        errors.push(`${label}: missing required field "spec.template"`);
      } else {
        const sel = isPlainObject(spec.selector)
          ? (spec.selector as Record<string, unknown>).matchLabels
          : undefined;
        const labels = isPlainObject((spec.template as Record<string, unknown>).metadata)
          ? ((spec.template as Record<string, unknown>).metadata as Record<string, unknown>).labels
          : undefined;
        if (isPlainObject(sel) && isPlainObject(labels)) {
          const mismatch = Object.entries(sel).some(([k, v]) => labels[k] !== v);
          if (mismatch) {
            errors.push(
              `${label}: spec.selector.matchLabels does not match spec.template.metadata.labels`,
            );
          }
        }
      }
    }
  }

  if (kind === "Service" && spec) {
    if (!Array.isArray(spec.ports) || spec.ports.length === 0) {
      errors.push(`${label}: missing required field "spec.ports"`);
    }
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

  // Drop pasted-along noise (code fences, shell prompts, heredoc wrappers)
  // before parsing, so it can never surface in the output.
  const sanitized = sanitizeInput(input, changes);
  if (sanitized.trim() === "") {
    return { output: "", changes, documents: 0, valid: false, errors: ["No YAML content found"] };
  }

  let parsed;
  try {
    parsed = parseAllDocuments(sanitized, {
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
    // 1. Fix invalid field-name casing / deprecated aliases so validation
    //    and repair see canonical names; 2. repair missing mandatory fields
    //    (apiVersion inferred from kind, name, selector, template, ports)
    //    so a repaired document validates clean.
    if (isPlainObject(js)) {
      js = normalizeFieldNames(js, "", changes) as Record<string, unknown>;
      js = repairApiVersion(js, changes);
      js = repairMandatoryFields(js, changes);
    }
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

  // Canonical formatting: 2-space indent, no line wrapping, single trailing
  // newline per document, and no blank lines between documents.
  const rendered = cleanedDocs
    .map((doc) =>
      stringify(doc, { indent: 2, lineWidth: 0, sortMapEntries: false })
        .replace(/\n{2,}/g, "\n")
        .trimEnd(),
    )
    .join("\n---\n")
    .concat("\n");

  return {
    output: rendered,
    changes,
    documents: cleanedDocs.length,
    valid: errors.length === 0,
    errors,
  };
}
