import { describe, expect, test } from "vitest";
import type { FeedEvent } from "../../src/domain/feed.ts";
import type { Task } from "../../src/domain/types.ts";
import { withoutTrailingWrite } from "../../src/notify/notifier.ts";
import { type Change, inQuietHours, match, RuleInput, withIds } from "../../src/notify/rules.ts";

const rules = (...r: unknown[]) => withIds(r.map((x) => RuleInput.parse(x)));

function change(types: string[], over: Partial<Task> = {}, actor = { user: "sam", agent: null }) {
  return {
    seq: 1,
    at: "2026-10-05T03:00:00.000Z",
    types: types.map((type) => ({
      type,
      data: type === "handed_off" ? { to: over.next_actor } : {},
    })),
    actor,
    task: {
      id: "t1",
      title: "x",
      owner: "sam",
      area: null,
      state: "open",
      next_actor: { kind: "user", user: "sam" },
      ...over,
    } as Task,
  } as Change;
}

describe("quiet hours", () => {
  // 2026-10-05 is AEDT (UTC+11).
  const at = (local: string) => new Date(`2026-10-05T${local}:00+11:00`);
  test("span midnight", () => {
    const q = { from: "22:00", to: "07:00" };
    expect(inQuietHours(q, at("21:59"))).toBe(false);
    expect(inQuietHours(q, at("22:00"))).toBe(true);
    expect(inQuietHours(q, at("03:00"))).toBe(true);
    expect(inQuietHours(q, at("07:00"))).toBe(false);
  });
  test("within a day", () => {
    const q = { from: "13:00", to: "14:30" };
    expect(inQuietHours(q, at("12:59"))).toBe(false);
    expect(inQuietHours(q, at("14:00"))).toBe(true);
    expect(inQuietHours(q, at("14:30"))).toBe(false);
    expect(inQuietHours(null, at("14:00"))).toBe(false);
  });
});

describe("matching", () => {
  const toAlex = { kind: "user", user: "alex" } as const;

  test("a handoff to me is reported as a handoff even if the rule also wants progress", () => {
    const m = match(
      change(["checkpoint", "handed_off"], { next_actor: toAlex }),
      "alex",
      rules({ when: ["progress", "handoff"], whose: "mine" }),
    );
    expect(m?.category).toBe("handoff");
  });

  test("a handoff to someone else isn't mine", () => {
    const c = change(["handed_off"], { next_actor: { kind: "user", user: "sam" } });
    expect(match(c, "alex", rules({ when: ["handoff"], whose: "mine" }))).toBeNull();
    expect(match(c, "alex", rules({ when: ["handoff"], whose: "any" }))?.category).toBe("handoff");
  });

  test("of two matching rules, the one allowed through quiet hours wins", () => {
    const m = match(
      change(["deadline_approaching"], { next_actor: toAlex }, {
        user: null,
        agent: null,
      } as never),
      "alex",
      rules(
        { when: ["deadline"], whose: "mine" },
        { when: ["deadline"], whose: "any", quiet_ok: true },
      ),
    );
    expect(m?.rule.quiet_ok).toBe(true);
  });

  test("time-driven changes pass a 'changed by' filter; disabled rules never match", () => {
    const c = change(["became_available"], { next_actor: toAlex }, {
      user: null,
      agent: null,
    } as never);
    expect(match(c, "alex", rules({ when: ["ready"], from: "people" }))?.category).toBe("ready");
    expect(match(c, "alex", rules({ when: ["ready"], enabled: false }))).toBeNull();
  });

  test("my own changes are never reported, but my agent's are", () => {
    const r = rules({ when: ["progress"], whose: "any" });
    expect(
      match(change(["checkpoint"], {}, { user: "alex", agent: null } as never), "alex", r),
    ).toBeNull();
    expect(
      match(change(["checkpoint"], {}, { user: "alex", agent: "claude" } as never), "alex", r),
    ).not.toBeNull();
  });

  test("a capture is judged by whose hands it went into, even if it has moved on since", () => {
    const c = change(["created"], { next_actor: { kind: "user", user: "sam" } } as never);
    c.types[0] = { type: "created", data: { next_actor: { kind: "user", user: "alex" } } };
    const r = rules({ when: ["handoff"], whose: "any" });
    expect(match(c, "alex", r)?.category).toBe("handoff");
    expect(match(c, "teija", r)).toBeNull();
  });

  test("my agent capturing a task into my hands is a handoff", () => {
    const c = change(
      ["created"],
      { next_actor: { kind: "user", user: "alex" } } as never,
      {
        user: "alex",
        agent: "claude",
      } as never,
    );
    expect(match(c, "alex", rules({ when: ["handoff"], whose: "mine" }))?.category).toBe("handoff");
  });
});

describe("feed pages", () => {
  const ev = (seq: number, task: string, at: string): FeedEvent => ({
    seq,
    type: "checkpoint",
    at,
    task: { id: task, title: "", state: "open", visibility: "household" },
    queue: null,
    actor: { user: "sam", agent: null },
    data: {},
  });
  test("a full page leaves its last write's events for the next page", () => {
    const page = [ev(1, "a", "t1"), ev(2, "b", "t2"), ev(3, "b", "t2")];
    expect(withoutTrailingWrite(page).map((e) => e.seq)).toEqual([1]);
  });
  test("a page that is one write is kept whole", () => {
    const page = [ev(1, "b", "t2"), ev(2, "b", "t2")];
    expect(withoutTrailingWrite(page)).toHaveLength(2);
  });
});
