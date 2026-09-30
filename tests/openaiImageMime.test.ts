import { describe, test, expect, vi } from "vitest";

process.env.OPENAI_API_KEY = "test-key";
const { imageMimeType, respondJson, ProviderOutputError } = await import("../src/providers/openai.ts");

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

  test("a per-call model and reasoning override applies to that call only; without it the body is the configured default", async () => {
    const { config } = await import("../src/server/config.ts");
    bodies.length = 0;
    vi.stubGlobal("fetch", stub);
    try {
      await respondJson({ instructions: "I", input: "T", schemaName: "final_film_visual_audit", schema: {}, model: "gpt-6-astra", reasoning: { effort: "high" } });
      await respondJson({ instructions: "I", input: "T", schemaName: "final_film_factual_audit", schema: {}, webSearch: true });
      expect([bodies[0].model, bodies[0].reasoning]).toEqual(["gpt-6-astra", { effort: "high" }]);
      expect(bodies[1].model).toBe(config.openai.model);
      expect("reasoning" in bodies[1]).toBe(false);
      expect(bodies[1].tools).toEqual([{ type: "web_search" }]);
      expect(config.openai.model).not.toBe("gpt-6-astra"); // the global model is never changed
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("respondJson failures", () => {
  const call = () => respondJson({ instructions: "I", input: "T", schemaName: "script", schema: {} });
  const failure = async (reply: () => Promise<unknown>) => {
    vi.stubGlobal("fetch", vi.fn(reply));
    try {
      await call();
    } catch (e) {
      return e as Error;
    } finally {
      vi.unstubAllGlobals();
    }
    throw new Error("expected respondJson to fail");
  };
  const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });

  test("a successful response with non-JSON or missing output is marked as answered; the message every caller sees is unchanged", async () => {
    for (const [body, shown] of [
      [{ output_text: "Sorry, no." }, "OpenAI returned non-JSON output: Sorry, no."],
      [{ output: [] }, "OpenAI returned non-JSON output: "],
    ] as const) {
      const e = await failure(ok(body));
      expect(e).toBeInstanceOf(ProviderOutputError);
      expect(e).toBeInstanceOf(Error); // callers that catch any Error behave exactly as before
      expect((e as InstanceType<typeof ProviderOutputError>).providerResponseReceived).toBe(true);
      expect(e.message).toBe(shown);
    }
  });

  test("a network failure and a non-success status are not marked as answered", async () => {
    const network = await failure(async () => Promise.reject(new TypeError("fetch failed")));
    expect(network).toBeInstanceOf(TypeError);
    expect(network).not.toBeInstanceOf(ProviderOutputError);
    const http = await failure(async () => ({ ok: false, status: 429, text: async () => "rate limited" }));
    expect(http.message).toBe("OpenAI responses 429: rate limited");
    expect(http).not.toBeInstanceOf(ProviderOutputError);
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
