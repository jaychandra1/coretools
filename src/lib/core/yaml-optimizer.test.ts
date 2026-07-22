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

  it("emits clean formatting with no blank lines", () => {
    const r = optimizeManifest(
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\ndata:\n  k: v\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\ndata:\n  k: v\n",
    );
    expect(r.output).not.toMatch(/\n{2,}/);
    expect(r.output.endsWith("\n")).toBe(true);
    expect(r.output).toContain("\n---\n");
  });
});
