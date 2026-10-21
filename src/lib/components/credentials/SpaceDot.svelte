<script lang="ts">
  import { spaceHue } from "../../core/credentials/spaces";

  /** A space's colour mark: the same hue on its tab, its chips and in Manage spaces. */
  let { name, size = 8 }: { name: string; size?: number } = $props();
</script>

<span
  class="dot"
  style="background: hsl({spaceHue(name)}, 60%, 55%); width: {size}px; height: {size}px"
  aria-hidden="true"
></span>

<style>
  .dot {
    flex: none;
    display: inline-block;
    border-radius: 50%;
  }
</style>
