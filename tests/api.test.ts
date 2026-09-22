import { describe, test, expect, vi, afterEach } from "vitest";
import { api } from "../src/app/api.ts";

// Capture the RequestInit each api call passes to fetch, and control the reply.
function stubFetch(reply: { ok?: boolean; status?: number; body?: unknown }): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  global.fetch = vi.fn(async (_url: any, init?: RequestInit) => {
    calls.push(init ?? {});
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      json: async () => reply.body ?? {},
    } as Response;
  }) as any;
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api post()", () => {
  test("a body-less POST sends no Content-Type and no body", async () => {
    const { calls } = stubFetch({ body: { job: {} } });
    await api.retry("job-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers).toBeUndefined();
  });

  test("a POST with a body sends JSON and the Content-Type header", async () => {
    const { calls } = stubFetch({ body: { job: {}, duplicate: false } });
    await api.generate("story-1", 5);

    expect(calls[0].headers).toEqual({ "Content-Type": "application/json" });
    expect(calls[0].body).toBe(JSON.stringify({ approvedMax: 5 }));
  });

  test("prefers Fastify's `message` over `error` on failure", async () => {
    stubFetch({ ok: false, status: 400, body: { error: "Bad Request", message: "more useful detail" } });
    await expect(api.retry("job-1")).rejects.toThrow("more useful detail");
  });
});
