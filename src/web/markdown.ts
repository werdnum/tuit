import { raw } from "hono/html";
import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { Html } from "./layout.ts";

// Single newlines stay line breaks, as they were when briefs and notes rendered as plain text.
const marked = new Marked({ gfm: true, breaks: true, async: false });

/**
 * Task text is written by people and agents, and agents relay content from email and the web, so
 * the rendered HTML is reduced to formatting only: no scripts, styles, forms, embeds or images
 * (an image is a request the author controls, fired whenever someone opens the task).
 */
const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: (
    "p br hr h1 h2 h3 h4 h5 h6 strong b em i del s u mark sub sup small kbd code pre blockquote " +
    "ul ol li table thead tbody tr th td details summary a input"
  ).split(" "),
  allowedAttributes: {
    a: ["href", "title", "rel", "target"],
    ol: ["start"],
    th: ["align"],
    td: ["align"],
    details: ["open"],
    input: ["type", "checked", "disabled"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  exclusiveFilter: (frame) => frame.tag === "input" && frame.attribs.type !== "checkbox",
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
    input: sanitizeHtml.simpleTransform("input", { disabled: "" }),
  },
};

/** Render a brief or note as sanitized Markdown (GFM, plus <details>/<summary> for collapsing). */
export function markdownHtml(text: string): Html {
  const rendered = marked.parse(text) as string;
  return raw(sanitizeHtml(rendered, SANITIZE));
}
