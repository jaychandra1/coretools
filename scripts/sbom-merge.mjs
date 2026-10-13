/**
 * Merge per-ecosystem CycloneDX SBOMs into the single release SBOM (audit F-30).
 *
 *   node scripts/sbom-merge.mjs --name CoreTools --version 1.2.0 \
 *     --npm npm.cdx.json --cargo cargo.cdx.json \
 *     [--cargo-lock committed|resolved-at-release] --out CoreTools-sbom.cdx.json
 *
 * Inputs come from the ecosystems' own generators:
 *   --npm    `npm sbom --sbom-format cyclonedx --package-lock-only`
 *            (package-lock.json; dev dependencies carry the
 *            `cdx:npm:package:development` property — the Svelte runtime is a
 *            devDependency yet ships in the bundle, so none are dropped)
 *   --cargo  `cargo cyclonedx --format json --spec-version 1.5 --target all`
 *            (src-tauri/Cargo.lock, every target platform)
 *
 * Output: one CycloneDX JSON document whose root component is the app,
 * depending on the npm package and the Rust crate, with every component and
 * dependency edge of both inputs. bom-refs must stay unique (the script
 * fails otherwise). The release workflow lists the file in SHA256SUMS.txt,
 * so the Sigstore signature covers it. Zero dependencies.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith("--")) fail(`Unexpected argument: ${argv[i]}`);
  args[argv[i].slice(2)] = argv[i + 1];
}

function fail(message) {
  console.error(`sbom-merge: ${message}`);
  process.exit(1);
}

function need(name) {
  if (!args[name]) fail(`--${name} is required`);
  return args[name];
}

const name = need("name");
const version = need("version");
const out = need("out");
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) fail(`--version must be semver, got "${version}"`);

function load(path, label) {
  let bom;
  try {
    bom = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} SBOM ${path}: ${error.message}`);
  }
  if (bom.bomFormat !== "CycloneDX") fail(`${label} SBOM ${path} is not CycloneDX JSON`);
  if (!bom.metadata?.component?.["bom-ref"]) fail(`${label} SBOM ${path} has no root component`);
  return bom;
}

const inputs = [
  { label: "npm", bom: load(need("npm"), "npm") },
  { label: "cargo", bom: load(need("cargo"), "cargo") },
];

// Declare the newest spec version among the inputs (both generators emit 1.5).
const specVersion = inputs
  .map(({ bom }) => String(bom.specVersion ?? "1.5"))
  .sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]))
  .at(-1);

/** metadata.tools in either the legacy array or the 1.5 object form → components. */
function tools(bom) {
  const t = bom.metadata?.tools;
  if (Array.isArray(t)) {
    return t.map((tool) => ({
      type: "application",
      ...(tool.vendor ? { group: tool.vendor } : {}),
      name: tool.name,
      ...(tool.version ? { version: tool.version } : {}),
    }));
  }
  return t?.components ?? [];
}

const roots = inputs.map(({ bom }) => bom.metadata.component);
const rootRef = `release:${name}@${version}`;

// Every bom-ref (nested components included) must be unique once merged. A
// repeat inside one input (e.g. its root also listed as a component) is
// dropped; a clash between the two inputs is an error.
const owner = new Map([[rootRef, "merge"]]);
function register(component, label) {
  const ref = component["bom-ref"];
  if (ref) {
    if (owner.has(ref)) fail(`duplicate bom-ref after merging (${owner.get(ref)} and ${label}): ${ref}`);
    owner.set(ref, label);
  }
  for (const child of component.components ?? []) register(child, label);
}
const components = [];
for (const { label, bom } of inputs) {
  for (const component of [bom.metadata.component, ...(bom.components ?? [])]) {
    const ref = component["bom-ref"];
    if (ref && owner.get(ref) === label) continue;
    register(component, label);
    components.push(component);
  }
}
const refs = new Set(owner.keys());

const dependencies = [
  { ref: rootRef, dependsOn: roots.map((c) => c["bom-ref"]) },
  ...inputs.flatMap(({ bom }) => bom.dependencies ?? []),
];
const dangling = new Set(
  dependencies.flatMap((d) => [d.ref, ...(d.dependsOn ?? [])]).filter((ref) => !refs.has(ref)),
);
if (dangling.size) {
  console.warn(`sbom-merge: warning: ${dangling.size} dependency reference(s) name no component, e.g. ${[...dangling][0]}`);
}

const properties = [
  ...inputs.flatMap(({ bom }) => bom.metadata.properties ?? []),
  ...(args["cargo-lock"] ? [{ name: `${name.toLowerCase()}:cargo-lock`, value: args["cargo-lock"] }] : []),
];

const sbom = {
  $schema: `http://cyclonedx.org/schema/bom-${specVersion}.schema.json`,
  bomFormat: "CycloneDX",
  specVersion,
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    lifecycles: [{ phase: "build" }],
    tools: {
      components: [
        ...inputs.flatMap(({ bom }) => tools(bom)),
        { type: "application", name: "sbom-merge.mjs", description: "Merges the npm and Rust SBOMs" },
      ],
    },
    component: {
      type: "application",
      "bom-ref": rootRef,
      name,
      version,
      ...(roots[0].description ? { description: roots[0].description } : {}),
    },
    ...(properties.length ? { properties } : {}),
  },
  components,
  dependencies,
};

writeFileSync(out, `${JSON.stringify(sbom, null, 2)}\n`);
const counts = inputs.map(({ label, bom }) => `${label} ${(bom.components ?? []).length}`).join(", ");
console.log(`Wrote ${out}: CycloneDX ${specVersion}, ${components.length} components (inputs: ${counts}, plus roots)`);
