import { describe, test, expect, vi } from "vitest";

process.env.OPENAI_API_KEY = "test-key";
const { imageMimeType, respondJson } = await import("../src/providers/openai.ts");

// The request body only: fetch is a stub, nothing reaches the network.
describe("respondJson with image inputs", () => {
  const bodies: any[] = [];
  const stub = vi.fn(async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ output_text: '{"ok":true}' }) } as any;
  });

  test("labelled stills go inline at high detail after the text, in order", async () => {
    vi.stubGlobal("fetch", stub);
    try {
      const images = [
        { label: "IMAGE for asset L00:", data: Buffer.from("png bytes"), mimeType: "image/png" },
        { label: "IMAGE for asset L01:", data: Buffer.from("jpg bytes"), mimeType: "image/jpeg" },
      ];
      expect(await respondJson({ instructions: "I", input: "T", schemaName: "asset_qa", schema: {}, images })).toEqual({ ok: true });
      expect(bodies[0].input).toEqual([
        {
          role: "user",
          content: [
            { type: "input_text", text: "T" },
            { type: "input_text", text: "IMAGE for asset L00:" },
            { type: "input_image", image_url: `data:image/png;base64,${Buffer.from("png bytes").toString("base64")}`, detail: "high" },
            { type: "input_text", text: "IMAGE for asset L01:" },
            { type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from("jpg bytes").toString("base64")}`, detail: "high" },
          ],
        },
      ]);
      // Without images the call is exactly as before: a plain string input.
      await respondJson({ instructions: "I", input: "T", schemaName: "script", schema: {} });
      expect(bodies[1].input).toBe("T");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

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
