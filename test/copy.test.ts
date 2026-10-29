import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyText } from "../web/src/lib/copy";

let origDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  origDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
});

afterEach(() => {
  if (origDescriptor) {
    Object.defineProperty(globalThis, "navigator", origDescriptor);
  }
});

test("copyText writes via navigator.clipboard and resolves true", async () => {
  let written = "";
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: async (text: string) => {
          written = text;
        },
      },
    },
    configurable: true,
    writable: true,
  });

  const res = await copyText("hello world /path/to/plan.md");
  expect(res).toBe(true);
  expect(written).toBe("hello world /path/to/plan.md");
});

test("copyText resolves false on clipboard failure or absence", async () => {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: async () => {
          throw new Error("clipboard denied");
        },
      },
    },
    configurable: true,
    writable: true,
  });
  expect(await copyText("some text")).toBe(false);

  Object.defineProperty(globalThis, "navigator", {
    value: {},
    configurable: true,
    writable: true,
  });
  expect(await copyText("some text")).toBe(false);
});

test("copyText resolves false when navigator itself is undefined", async () => {
  Object.defineProperty(globalThis, "navigator", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  expect(await copyText("some text")).toBe(false);
});
