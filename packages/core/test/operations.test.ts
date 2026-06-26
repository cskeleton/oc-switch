import { expect, test } from "bun:test";
import {
  addCustomProvider,
  disableProvider,
  removeProvider,
  restoreDisabledProvider,
  setPrimaryModel
} from "../src/operations";

test("operations compatibility exports model operations", () => {
  expect(typeof setPrimaryModel).toBe("function");
});

test("operations compatibility exports provider operations", () => {
  expect(typeof removeProvider).toBe("function");
  expect(typeof addCustomProvider).toBe("function");
});

test("operations compatibility exports provider lifecycle operations", () => {
  expect(typeof disableProvider).toBe("function");
  expect(typeof restoreDisabledProvider).toBe("function");
});
