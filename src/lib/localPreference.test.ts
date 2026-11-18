import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prefersLocalLedger, rememberLocalLedger } from "./localPreference";

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the existing account entry by default and remembers an explicit local choice only", () => {
  expect(prefersLocalLedger()).toBe(false);
  rememberLocalLedger(true);
  expect(prefersLocalLedger()).toBe(true);
  expect([...values.values()]).toEqual(["local"]);
  rememberLocalLedger(false);
  expect(prefersLocalLedger()).toBe(false);
  expect(values.size).toBe(0);
});

it("does not block a current choice when browser preference storage is unavailable", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); }, removeItem: () => { throw Error("blocked"); } });
  expect(prefersLocalLedger()).toBe(false);
  expect(() => rememberLocalLedger(true)).not.toThrow();
  expect(() => rememberLocalLedger(false)).not.toThrow();
});
