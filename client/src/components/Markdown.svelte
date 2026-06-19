<script lang="ts">
  // Single place that owns how agent/tool markdown is rendered (markstream-svelte).
  // The transcript renders agent/tool markdown through here.
  import MarkdownRender from "markstream-svelte";
  import { isDark } from "../lib/dark.svelte.js";

  let { content, final = true }: { content: string; final?: boolean } = $props();
</script>

<!-- Render config:
     - htmlPolicy "safe": allowlisted HTML only; scripts/event-handlers/style dropped,
       js:/data:/vbscript: links blocked, target=_blank hardened with rel=noopener.
     - customMarkdownIt disables typographer so quotes/dashes render verbatim — don't
       smart-quote technical text (markstream defaults it on). `md` is contextually typed.
     - renderCodeBlocksAsPre: plain <pre> code blocks (no Monaco peer, themed in app.css). -->
<MarkdownRender
  {content}
  {final}
  htmlPolicy="safe"
  customMarkdownIt={(md) => md.set({ typographer: false })}
  renderCodeBlocksAsPre
  isDark={isDark()}
/>
