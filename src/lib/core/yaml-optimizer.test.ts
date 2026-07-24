import { describe, it, expect } from "vitest";
import { optimizeManifest } from "./yaml-optimizer";

const MESSY = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: default
  creationTimestamp: "2023-01-01T00:00:00Z"
  generation: 4
  resourceVersion: "12345"
  uid: 0d9e-aaa
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"foo":"bar"}'
    team: platform
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      creationTimestamp: null
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
status:
  observedGeneration: 4
  readyReplicas: 3
`;

describe("optimizeManifest", () => {
  it("removes server-managed metadata fields", () => {
    const r = optimizeManifest(MESSY);
    expect(r.valid).toBe(true);
    expect(r.output).not.toContain("creationTimestamp");
    expect(r.output).not.toContain("resourceVersion");
    expect(r.output).not.toContain("uid:");
    expect(r.output).not.toContain("generation:");
  });

  it("removes the top-level status block", () => {
    const r = optimizeManifest(MESSY);
    expect(r.output).not.toContain("status:");
    expect(r.output).not.toContain("observedGeneration");
  });

  it("removes tooling annotations but keeps user annotations", () => {
    const r = optimizeManifest(MESSY);
    expect(r.output).not.toContain("last-applied-configuration");
    expect(r.output).toContain("team: platform");
  });

  it("preserves the meaningful spec", () => {
    const r = optimizeManifest(MESSY);
    expect(r.output).toContain("replicas: 3");
    expect(r.output).toContain("image: nginx:1.27");
    expect(r.output).toContain("name: web");
  });

  it("reports every removal with a reason", () => {
    const r = optimizeManifest(MESSY);
    expect(r.changes.length).toBeGreaterThan(0);
    const paths = r.changes.map((c) => c.path);
    expect(paths).toContain("metadata.creationTimestamp");
    expect(r.changes.every((c) => c.reason.length > 0)).toBe(true);
  });

  it("handles multi-document manifests", () => {
    const multi = `apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
data:
  key: value
---
apiVersion: v1
kind: Service
metadata:
  name: svc
spec:
  ports:
    - port: 80
`;
    const r = optimizeManifest(multi);
    expect(r.valid).toBe(true);
    expect(r.documents).toBe(2);
    expect(r.output).toContain("kind: ConfigMap");
    expect(r.output).toContain("kind: Service");
  });

  it("adds a missing apiVersion inferred from a standard kind", () => {
    const r = optimizeManifest("kind: Pod\nmetadata:\n  name: p\n");
    expect(r.valid).toBe(true);
    expect(r.output.startsWith("apiVersion: v1\n")).toBe(true);
    const added = r.changes.find((c) => c.action === "added");
    expect(added?.path).toBe("apiVersion");
  });

  it("infers group apiVersions (Deployment → apps/v1, Ingress → networking)", () => {
    const dep = optimizeManifest("kind: Deployment\nmetadata:\n  name: d\nspec:\n  replicas: 1\n");
    expect(dep.output).toContain("apiVersion: apps/v1");
    expect(dep.valid).toBe(true);
    const ing = optimizeManifest("kind: Ingress\nmetadata:\n  name: i\n");
    expect(ing.output).toContain("apiVersion: networking.k8s.io/v1");
  });

  it("keeps an existing apiVersion untouched", () => {
    const r = optimizeManifest("apiVersion: apps/v1beta2\nkind: Deployment\nmetadata:\n  name: d\n");
    expect(r.output).toContain("apiVersion: apps/v1beta2");
    expect(r.changes.some((c) => c.action === "added" && c.path === "apiVersion")).toBe(false);
  });

  it("still flags a missing apiVersion for unknown kinds", () => {
    const r = optimizeManifest("kind: MyCustomThing\nmetadata:\n  name: x\n");
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("apiVersion");
  });

  it("defaults a missing metadata.name", () => {
    const r = optimizeManifest("apiVersion: v1\nkind: Pod\nmetadata: {}\n");
    expect(r.valid).toBe(true);
    expect(r.output).toContain("name: unnamed-pod");
    expect(r.changes.some((c) => c.action === "added" && c.path === "metadata.name")).toBe(true);
  });

  it("rejects invalid YAML with a parse error, not a crash", () => {
    const r = optimizeManifest("key: [unterminated\n");
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("treats empty input as invalid", () => {
    const r = optimizeManifest("   ");
    expect(r.valid).toBe(false);
    expect(r.output).toBe("");
  });

  it("strips shell prompts, code fences and heredoc wrappers from input", () => {
    const r = optimizeManifest(
      "$ kubectl apply -f -\ncat <<EOF\n```yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  k: v\n```\nEOF\n",
    );
    expect(r.valid).toBe(true);
    expect(r.output).toContain("kind: ConfigMap");
    expect(r.output).not.toContain("kubectl");
    expect(r.output).not.toContain("```");
    expect(r.output).not.toContain("EOF");
  });

  it("adds selector and template labels for a Deployment missing them", () => {
    const r = optimizeManifest(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.27\n",
    );
    expect(r.valid).toBe(true);
    expect(r.output).toContain("matchLabels");
    expect(r.output).toContain("app: web");
    const added = r.changes.filter((c) => c.action === "added").map((c) => c.path);
    expect(added).toContain("spec.selector");
    expect(added).toContain("spec.template.metadata.labels");
  });

  it("adds a minimal pod template when a workload has none", () => {
    const r = optimizeManifest("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 1\n");
    expect(r.valid).toBe(true);
    expect(r.output).toContain("template:");
    expect(r.output).toContain("your-image:latest");
    expect(r.output).toContain("matchLabels");
  });

  it("derives template labels from an existing selector", () => {
    const r = optimizeManifest(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  selector:\n    matchLabels:\n      app: custom\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.27\n",
    );
    expect(r.valid).toBe(true);
    expect(r.output).toContain("app: custom");
    expect(r.errors).toEqual([]);
  });

  it("adds defaults for a Service missing selector and ports", () => {
    const r = optimizeManifest("apiVersion: v1\nkind: Service\nmetadata:\n  name: svc\n");
    expect(r.valid).toBe(true);
    expect(r.output).toContain("port: 80");
    expect(r.output).toContain("app: svc");
  });

  it("adds serviceName for a StatefulSet", () => {
    const r = optimizeManifest(
      "apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: db\nspec:\n  template:\n    metadata:\n      labels:\n        app: db\n    spec:\n      containers:\n        - name: db\n          image: postgres:16\n",
    );
    expect(r.valid).toBe(true);
    expect(r.output).toContain("serviceName: db");
  });

  it("flags a selector that does not match template labels", () => {
    const r = optimizeManifest(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  selector:\n    matchLabels:\n      app: other\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.27\n",
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("does not match");
  });

  it("renames invalid field 'serviceaccount' to serviceAccountName", () => {
    const r = optimizeManifest(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      serviceaccount: qa-cashier-sa\n      containers:\n        - name: web\n          image: nginx:1.27\n",
    );
    expect(r.valid).toBe(true);
    expect(r.output).toContain("serviceAccountName: qa-cashier-sa");
    expect(r.output).not.toContain("serviceaccount:");
    const renamed = r.changes.find((c) => c.action === "renamed");
    expect(renamed?.path).toBe("spec.template.spec.serviceaccount");
    expect(renamed?.reason).toContain("serviceAccountName");
  });

  it("upgrades the deprecated serviceAccount field", () => {
    const r = optimizeManifest(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  serviceAccount: my-sa\n  containers:\n    - name: c\n      image: nginx\n",
    );
    expect(r.output).toContain("serviceAccountName: my-sa");
    expect(r.output).not.toContain("serviceAccount: my-sa");
  });

  it("fixes wrong-cased field names throughout the document", () => {
    const r = optimizeManifest(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  restartpolicy: Always\n  imagepullsecrets:\n    - name: regcred\n  containers:\n    - name: c\n      image: nginx\n      imagepullpolicy: Always\n      volumemounts:\n        - name: v\n          mountpath: /data\n          subpath: logs\n",
    );
    expect(r.output).toContain("restartPolicy: Always");
    expect(r.output).toContain("imagePullSecrets:");
    expect(r.output).toContain("imagePullPolicy: Always");
    expect(r.output).toContain("volumeMounts:");
    expect(r.output).toContain("mountPath: /data");
    expect(r.output).toContain("subPath: logs");
    expect(r.changes.filter((c) => c.action === "renamed").length).toBe(6);
  });

  it("drops a misspelled field that duplicates the canonical one", () => {
    const r = optimizeManifest(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  serviceaccount: wrong\n  serviceAccountName: right\n  containers:\n    - name: c\n      image: nginx\n",
    );
    expect(r.output).toContain("serviceAccountName: right");
    expect(r.output).not.toContain("wrong");
    expect(r.changes.some((c) => c.reason.includes("duplicate"))).toBe(true);
  });

  it("never renames keys inside user-data maps", () => {
    const r = optimizeManifest(
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  labels:\n    imagepullpolicy: keep-me\ndata:\n  restartpolicy: some-config-value\n  nodeselector: another-value\n",
    );
    expect(r.output).toContain("imagepullpolicy: keep-me");
    expect(r.output).toContain("restartpolicy: some-config-value");
    expect(r.output).toContain("nodeselector: another-value");
    expect(r.changes.filter((c) => c.action === "renamed").length).toBe(0);
  });

  it("keeps user annotations by default", () => {
    const r = optimizeManifest(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n      annotations:\n        instrumentation.opentelemetry.io/inject-java: \"true\"\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.27\n",
    );
    expect(r.output).toContain("instrumentation.opentelemetry.io/inject-java");
  });

  it("strips all annotations when the option is enabled", () => {
    const r = optimizeManifest(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  annotations:\n    team: platform\nspec:\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n      annotations:\n        cloudwatch.aws.amazon.com/auto-annotate-java: \"true\"\n        instrumentation.opentelemetry.io/inject-java: \"true\"\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.27\n",
      { stripAnnotations: true },
    );
    expect(r.valid).toBe(true);
    expect(r.output).not.toContain("annotations");
    expect(r.output).not.toContain("opentelemetry");
    expect(r.output).not.toContain("team: platform");
    const stripped = r.changes.filter((c) => c.reason.includes("disabled by option"));
    expect(stripped.map((c) => c.path)).toEqual([
      "metadata.annotations",
      "spec.template.metadata.annotations",
    ]);
    expect(stripped[1].reason).toContain("2 entries");
  });

  it("emits clean formatting with no blank lines", () => {
    const r = optimizeManifest(
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\ndata:\n  k: v\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\ndata:\n  k: v\n",
    );
    expect(r.output).not.toMatch(/\n{2,}/);
    expect(r.output.endsWith("\n")).toBe(true);
    expect(r.output).toContain("\n---\n");
  });
});
