import { expect, test } from "vitest";
import { parseMoment } from "../../src/domain/time.ts";

// Rough date input is parsed in one place and shared by the web UI, CLI and MCP, and the
// weekday/DST edge cases are easy to get subtly wrong, so they're pinned here directly.

const saturdayMorning = new Date("2026-10-10T09:00:00+11:00");
const thursdayNight = new Date("2026-10-08T23:30:00+11:00");

test.each([
  ["sat", saturdayMorning, { date: "2026-10-10" }],
  ["next sat", saturdayMorning, { date: "2026-10-17" }],
  ["friday", saturdayMorning, { date: "2026-10-16" }],
  ["last thu", saturdayMorning, { date: "2026-10-08" }],
  ["yesterday", saturdayMorning, { date: "2026-10-09" }],
  ["+3d", saturdayMorning, { date: "2026-10-13" }],
  ["in 2 weeks", saturdayMorning, { date: "2026-10-24" }],
  ["2 days ago", saturdayMorning, { date: "2026-10-08" }],
  ["2026-12-25", saturdayMorning, { date: "2026-12-25" }],
  // Late in the local evening the UTC date is already tomorrow; "tomorrow" is still Friday.
  ["tomorrow", thursdayNight, { date: "2026-10-09" }],
])("%s is a calendar date", (input, now, expected) => {
  expect(parseMoment(input, now)).toEqual(expected);
});

test.each([
  ["sat 9am", saturdayMorning, "2026-10-09T22:00:00.000Z"],
  ["tomorrow at 17:30", saturdayMorning, "2026-10-11T06:30:00.000Z"],
  ["2026-10-03 07:15", saturdayMorning, "2026-10-02T21:15:00.000Z"],
  ["2026-10-03T07:15:00+10:00", saturdayMorning, "2026-10-02T21:15:00.000Z"],
  // Sydney daylight saving starts 4 Oct 2026: 9am on either side is a different UTC offset.
  ["2026-10-03 09:00", saturdayMorning, "2026-10-02T23:00:00.000Z"],
  ["2026-10-05 09:00", saturdayMorning, "2026-10-04T22:00:00.000Z"],
])("%s is an exact instant", (input, now, expected) => {
  expect(parseMoment(input, now)).toEqual({ at: expected });
});

test.each(["someday", "13pm", "sat 25:00", ""])("%j is rejected rather than guessed", (input) => {
  expect(() => parseMoment(input, saturdayMorning)).toThrow(/Can't understand/);
});
