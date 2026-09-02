<script lang="ts">
  import { studioStore } from "./studio-store.svelte";
  import { validateOpenApi, type OpenApiFlavor } from "../../core/json-studio/openapi";
  import { yamlToJson } from "../../core/json-studio/convert/yaml";
  import type { JsonValue, ValidationMessage } from "../../core/json-studio/types";

  type Verdict =
    | { state: "invalid-input"; error: string }
    | { state: "done"; flavor: OpenApiFlavor; messages: ValidationMessage[]; fromYaml: boolean };

  const verdict = $derived.by((): Verdict => {
    void studioStore.docText;
    let value: JsonValue | null = studioStore.parsedValue();
    let fromYaml = false;
    if (value === null) {
      // OpenAPI documents are frequently YAML; accept that here.
      const asYaml = yamlToJson(studioStore.docText);
      if (asYaml.ok && asYaml.value !== null && typeof asYaml.value === "object") {
        value = asYaml.value;
        fromYaml = true;
      } else {
        return {
          state: "invalid-input",
          error: "The document is neither valid JSON nor valid YAML.",
        };
      }
    }
    const { flavor, messages } = validateOpenApi(value);
    return { state: "done", flavor, messages, fromYaml };
  });

  function flavorLabel(flavor: OpenApiFlavor): string {
    if (flavor.kind === "openapi") return `OpenAPI ${flavor.version}`;
    if (flavor.kind === "swagger") return `Swagger ${flavor.version}`;
    return "not an OpenAPI document";
  }
</script>

<div class="openapi-panel">
  <p class="muted hint">
    Structural validation for OpenAPI 3.0 / 3.1 and Swagger 2.0: required
    top-level objects, path templates vs. declared parameters, HTTP operations
    and responses, operationId uniqueness, and local $ref resolution.
    Runs fully offline — external $refs are skipped, not fetched.
  </p>

  {#if verdict.state === "invalid-input"}
    <p class="error" role="alert">{verdict.error}</p>
  {:else}
    <p class="flavor">
      Detected: <strong>{flavorLabel(verdict.flavor)}</strong>
      {#if verdict.fromYaml}<span class="badge">parsed as YAML</span>{/if}
    </p>

    {#if verdict.flavor.kind !== "none" && verdict.messages.length === 0}
      <p class="ok">✓ No structural problems found</p>
    {:else if verdict.messages.length > 0}
      <p class="fail">
        ✗ {verdict.messages.length}
        {verdict.messages.length === 1 ? "finding" : "findings"}
      </p>
      <ul>
        {#each verdict.messages.slice(0, 150) as message, i (message.path + i)}
          <li>
            <code class="path">{message.path || "(root)"}</code>
            <span>{message.message}</span>
            <span class="keyword muted">{message.keyword}</span>
          </li>
        {/each}
        {#if verdict.messages.length > 150}
          <li class="muted">…and {verdict.messages.length - 150} more</li>
        {/if}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .openapi-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
    min-height: 0;
  }
  .hint {
    font-size: 11.5px;
    margin: 0;
  }
  .flavor {
    margin: 0;
    font-size: 13px;
  }
  .badge {
    margin-left: 8px;
    font-size: 10.5px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 4px;
    padding: 2px 6px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ok {
    color: var(--added-fg);
    font-weight: 600;
    margin: 0;
  }
  .fail {
    color: var(--removed-fg);
    font-weight: 600;
    margin: 0;
  }
  .error {
    color: var(--danger);
    margin: 0;
    font-size: 12.5px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface);
    font-size: 11.5px;
  }
  .path {
    font-family: var(--mono);
    font-weight: 600;
    color: var(--accent);
    flex: none;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .keyword {
    margin-left: auto;
    font-size: 10.5px;
    text-transform: uppercase;
  }
</style>
