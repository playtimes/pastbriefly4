import { describe, test, expect } from "vitest";

const { imageMimeType } = await import("../src/providers/openai.ts");

describe("imageMimeType", () => {
  test("maps supported extensions (case-insensitive)", () => {
    expect(imageMimeType("a/b/c.png")).toBe("image/png");
    expect(imageMimeType("hero.PNG")).toBe("image/png");
    expect(imageMimeType("still.jpg")).toBe("image/jpeg");
    expect(imageMimeType("still.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("frame.webp")).toBe("image/webp");
  });

  test("throws on unsupported or missing extension", () => {
    expect(() => imageMimeType("clip.gif")).toThrow(/Unsupported/);
    expect(() => imageMimeType("noext")).toThrow(/Unsupported/);
  });
});
