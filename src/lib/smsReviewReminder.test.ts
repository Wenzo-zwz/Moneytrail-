import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dismissSmsReview, isSmsReviewDue, readSmsReviewState, recordSmsReviewOpened } from "./smsReviewReminder";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 17, 12);
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("does not invent a review history for an account which has never opened SMS", () => {
  expect(readSmsReviewState("project:alice")).toBeNull();
  expect(isSmsReviewDue(null, NOW)).toBe(false);
});

it("reminds after seven days from an observed visit, without claiming it was reconciled", () => {
  recordSmsReviewOpened("project:alice");
  const state = readSmsReviewState("project:alice");
  expect(isSmsReviewDue(state, NOW + WEEK - 1)).toBe(false);
  expect(isSmsReviewDue(state, NOW + WEEK)).toBe(true);
  expect(isSmsReviewDue(state, NOW - WEEK)).toBe(false);
});

it("keeps accounts and projects separate", () => {
  recordSmsReviewOpened("project:alice");
  expect(readSmsReviewState("project:bob")).toBeNull();
  expect(readSmsReviewState("other-project:alice")).toBeNull();
});

it("snoozes for seven days and restarts after the next explicit visit", () => {
  recordSmsReviewOpened("project:alice");
  vi.mocked(Date.now).mockReturnValue(NOW + WEEK);
  dismissSmsReview("project:alice");
  expect(isSmsReviewDue(readSmsReviewState("project:alice"), NOW + WEEK * 2 - 1)).toBe(false);
  expect(isSmsReviewDue(readSmsReviewState("project:alice"), NOW + WEEK * 2)).toBe(true);
  recordSmsReviewOpened("project:alice");
  expect(readSmsReviewState("project:alice")).toEqual({ openedAt: NOW + WEEK });
});

it("ignores malformed or unavailable reminder storage without blocking the app", () => {
  for (const value of ["broken", "null", "{}", '{"openedAt":"yesterday"}', '{"openedAt":-1}', '{"openedAt":1,"dismissedAt":"later"}']) {
    values.set("moneytrail:sms-review:v1:project:alice", value);
    expect(readSmsReviewState("project:alice")).toBeNull();
  }
  vi.stubGlobal("localStorage", { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); } });
  expect(() => recordSmsReviewOpened("project:alice")).not.toThrow();
  expect(() => dismissSmsReview("project:alice")).not.toThrow();
});
