// A Svelte action: keep the keyboard-selected row scrolled into view as the user
// arrows past the fold. Attach to the element containing the rows and pass the selected
// index; each row must carry `data-i={index}`. `scrollIntoView({ block: "nearest" })`
// walks up to the nearest scrollable ancestor, so the host element need not be the
// scroller itself — it only has to contain the rows.
//
// This replaces a `$effect(() => listEl?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView())`
// that was copy-pasted verbatim across the menu components (slash / file / dir). Svelte's
// docs favour an action over `$effect` for DOM side effects like this; sharing one action
// also stops the next session copying a fourth slightly-different variant.
export function scrollIndexIntoView(node: HTMLElement, selected: number) {
  const scroll = (i: number): void => {
    node
      .querySelector<HTMLElement>(`[data-i="${i}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };
  scroll(selected);
  return {
    update(i: number): void {
      scroll(i);
    },
  };
}
