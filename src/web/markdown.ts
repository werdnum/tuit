import { raw } from "hono/html";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import sanitizeHtml from "sanitize-html";
import type { TaskRef } from "../domain/tasks.ts";
import type { Html } from "./layout.ts";

// Single newlines stay line breaks, as they were when briefs and notes rendered as plain text.
const OPTIONS = { gfm: true, breaks: true, async: false } as const;
const marked = new Marked(OPTIONS);

/** Task ids are eight characters from newId's alphabet. */
const TASK_ID = /(?<![A-Za-z0-9])[a-hj-km-np-z2-9]{8}(?![A-Za-z0-9])/g;

/** Words in this text shaped like task ids, to look up before rendering it. */
export function taskIdCandidates(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const text of texts) for (const m of text?.matchAll(TASK_ID) ?? []) out.add(m[0]);
  return [...out];
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Links a mention of a task's id to that task. Only ids in `refs` (tasks the reader may see) are
 * linked, so an ordinary eight-letter word never is, and the link's title is the task's.
 */
function taskLinks(refs: Map<string, TaskRef>): TokenizerAndRendererExtension {
  return {
    name: "taskRef",
    level: "inline",
    start(src) {
      TASK_ID.lastIndex = 0;
      for (const m of src.matchAll(TASK_ID)) if (refs.has(m[0])) return m.index;
      return undefined;
    },
    tokenizer(src) {
      if (this.lexer.state.inLink) return undefined;
      const m = /^[a-hj-km-np-z2-9]{8}(?![A-Za-z0-9])/.exec(src);
      if (!m || !refs.has(m[0])) return undefined;
      return { type: "taskRef", raw: m[0], id: m[0] };
    },
    renderer(token) {
      const ref = refs.get(token.id as string) as TaskRef;
      return `<a href="/tasks/${ref.id}" title="${escapeAttr(ref.title)}">${ref.id}</a>`;
    },
  };
}

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
    a: (tagName, attribs) =>
      attribs.href?.startsWith("/tasks/")
        ? { tagName, attribs }
        : {
            tagName,
            attribs: { ...attribs, rel: "noopener noreferrer nofollow", target: "_blank" },
          },
    input: sanitizeHtml.simpleTransform("input", { disabled: "" }),
  },
};

/**
 * Render a brief or note as sanitized Markdown (GFM, plus <details>/<summary> for collapsing).
 * Mentions of the tasks in `refs` become links to them.
 */
export function markdownHtml(text: string, refs?: Map<string, TaskRef>): Html {
  const parser = refs?.size ? new Marked(OPTIONS, { extensions: [taskLinks(refs)] }) : marked;
  const rendered = parser.parse(text) as string;
  return raw(sanitizeHtml(rendered, SANITIZE));
}
