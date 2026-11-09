import { expect, test } from "vitest";
import { markdownHtml, taskIdCandidates } from "../../src/web/markdown.ts";

const render = (s: string) => String(markdownHtml(s));

test("renders GitHub-flavoured Markdown and keeps single newlines as line breaks", () => {
  const out = render(
    "**Status:** with accountant\nsecond line\n\n- [x] W-2\n- [ ] 1099\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  );

  expect(out).toContain("<strong>Status:</strong> with accountant<br />second line");
  expect(out).toMatch(/<input[^>]*checked[^>]*type="checkbox"/);
  expect(out).toContain("<td>1</td>");
});

test("details and summary collapse a section whose inside is still Markdown", () => {
  const out = render(
    "Short state.\n\n<details>\n<summary>Full dossier</summary>\n\n## Income\n- salary\n\n</details>",
  );

  expect(out).toContain("<details>");
  expect(out).toContain("<summary>Full dossier</summary>");
  expect(out).toContain("<h2>Income</h2>");
  expect(out).toContain("<li>salary</li>");
});

test("strips scripts, handlers, styles, images and unsafe links", () => {
  const out = render(
    '<script>alert(1)</script>\n\n<img src="https://x.test/p.png" onerror="alert(1)">\n\n<p style="color:red" onclick="x()">hi</p>\n\n[bad](javascript:alert(1)) [good](https://example.com)\n\n<iframe src="https://x.test"></iframe><form><input type="text" name="q"></form>',
  );

  expect(out).not.toMatch(
    /<script|<img|<iframe|<form|onerror|onclick|style=|javascript:|type="text"/,
  );
  expect(out).toContain("hi");
  expect(out).toContain(
    '<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">good</a>',
  );
});

test("escapes text that only looks like markup", () => {
  expect(render("1 < 2 & 3 > 2")).toContain("1 &lt; 2 &amp; 3 &gt; 2");
});

test("mentions of visible task ids link to the task; other id-shaped words stay text", () => {
  const refs = new Map([
    ["agntc9s5", { id: "agntc9s5", title: "2022 amended <return>", state: "waiting" }],
  ]);
  const text =
    "Review alongside agntc9s5 and research the rest. `agntc9s5` in code, [see agntc9s5](https://x.test).";

  expect(taskIdCandidates(text, null)).toEqual(["agntc9s5", "research"]);
  const out = String(markdownHtml(text, refs));
  expect(out).toContain(
    'alongside <a href="/tasks/agntc9s5" title="2022 amended &lt;return&gt;">agntc9s5</a> and research',
  );
  expect(out).toContain("<code>agntc9s5</code>");
  expect(out).toMatch(/<a href="https:\/\/x.test"[^>]*>see agntc9s5<\/a>/);
  expect(out.match(/<a /g)).toHaveLength(2);
});

test("ids aren't linked when the reader can't see that task", () => {
  expect(String(markdownHtml("see agntc9s5", new Map()))).toBe("<p>see agntc9s5</p>\n");
});
