// Shared extraction of pi message/tool-result content blocks, used by BOTH the live
// (event-map) and replay (history-map) paths so a reloaded transcript carries the same
// text + image data the live one produced. pi's content is `(TextContent | ImageContent)[]`
// (pi-ai types.ts): a text block is `{type:"text",text}`, an image block is
// `{type:"image",data:<base64>,mimeType}`.

import type { ImageContent } from "@pilot/protocol";

function isImageBlock(
  b: unknown,
): b is { type: "image"; data: string; mimeType: string } {
  return (
    !!b &&
    typeof b === "object" &&
    (b as { type?: unknown }).type === "image" &&
    typeof (b as { data?: unknown }).data === "string" &&
    typeof (b as { mimeType?: unknown }).mimeType === "string"
  );
}

/** The image content blocks of a message/result content array, as typed `ImageContent`.
 *  `undefined` when there are none (so callers leave the optional `images` field unset)
 *  or when `content` isn't pi's block array (a plain string carries no images). */
export function imagesFromContent(
  content: unknown,
): readonly ImageContent[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const imgs: ImageContent[] = [];
  for (const b of content) {
    if (isImageBlock(b))
      imgs.push({ type: "image", data: b.data, mimeType: b.mimeType });
  }
  return imgs.length ? imgs : undefined;
}

/** The text of a message/result content array — text blocks joined, image blocks
 *  dropped (NOT turned into a "[image]" placeholder; the image renders separately as a
 *  thumbnail now). A plain string passes through unchanged. Use for transcript bubbles /
 *  tool output where the image is also surfaced as a thumbnail. `contentToText` (which
 *  keeps the "[image]" placeholder) stays for the surfaces with no thumbnail: session-list
 *  previews and the customMessage inject item. */
export function textFromContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .join("");
}

/** Split a live pi tool result into the `output` we surface and the `images` we lift out.
 *  Image blocks are removed from `output.content` so the base64 isn't shipped twice (once
 *  in `output`, once in `images`); text blocks and `details` stay intact. A non-object
 *  result (or one with no images) passes through untouched. */
export function splitToolResult(result: unknown): {
  output: unknown;
  images?: readonly ImageContent[];
} {
  if (!result || typeof result !== "object") return { output: result };
  const content = (result as { content?: unknown }).content;
  const images = imagesFromContent(content);
  if (!images) return { output: result };
  const stripped = (content as unknown[]).filter((b) => !isImageBlock(b));
  return { output: { ...(result as object), content: stripped }, images };
}
