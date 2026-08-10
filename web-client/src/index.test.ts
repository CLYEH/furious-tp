import { describe, expect, it } from "vitest";

import { greet } from "./index.js";

describe("scaffold", () => {
  it("runs a spec against the source tree", () => {
    expect(greet("world")).toBe("hello, world");
  });
});
