<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  // The shared button primitive. Three emphasis levels (the taxonomy promoted from
  // Settings' proven btn/ghost/danger) crossed with a size axis, because the heaviest
  // consumers span a real range — compact chrome buttons (sm/md) up to full-width dialog
  // actions (lg). `block` makes it fill its container / share a flex row equally.
  //
  // `title` stays optional here: a text button's label already names the action, so a
  // title that just duplicates it is noise. Pass one when it adds what the label can't —
  // e.g. a hotkey ("Save (⌘S)"). IconButton is where `title` becomes required, since an
  // icon has no text label, so the repo's "every clickable is labelled" rule is enforced
  // where it actually matters.
  type Variant = "primary" | "secondary" | "danger";
  type Size = "sm" | "md" | "lg";

  interface Props extends HTMLButtonAttributes {
    variant?: Variant;
    size?: Size;
    block?: boolean;
    children: Snippet;
  }

  let {
    variant = "secondary",
    size = "md",
    block = false,
    type = "button",
    class: extra = "",
    children,
    ...rest
  }: Props = $props();
</script>

<button
  class="btn {variant} {size}{block ? ' block' : ''}{extra ? ' ' + extra : ''}"
  {type}
  {...rest}
>
  {@render children()}
</button>

<style>
  .btn {
    font-family: inherit;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid transparent;
    line-height: 1.2;
    white-space: nowrap;
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* Emphasis — promoted verbatim from Settings' btn / ghost / danger. */
  .primary {
    background: var(--accent);
    color: var(--accent-text);
    border-color: transparent;
  }
  .secondary {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .danger {
    background: transparent;
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }

  /* Size — sm = compact chrome, md = standard action (Settings .btn), lg = dialog action. */
  .sm {
    padding: 4px 10px;
    font-size: 12px;
  }
  .md {
    padding: 7px 13px;
    font-size: 13px;
  }
  .lg {
    padding: 12px;
    font-size: 15px;
  }
  .lg.primary {
    font-weight: 550;
  }

  /* Full width standalone; equal share inside a flex row (the dialog two-button row). */
  .block {
    width: 100%;
    flex: 1 1 0;
  }
</style>
