import { describe, test, expect } from "vitest";
import { resolveRoute, activeNav } from "../src/app/route.ts";

describe("dashboard navigation", () => {
  test("the three permanent menu destinations resolve", () => {
    expect(resolveRoute("/")).toEqual({ name: "create" });
    expect(resolveRoute("/videos")).toEqual({ name: "videos" });
    expect(resolveRoute("/settings")).toEqual({ name: "settings" });
  });

  test("story detail and creating remain drill-downs, not menu screens", () => {
    expect(resolveRoute("/story/pig-war")).toEqual({ name: "story", slug: "pig-war" });
    expect(resolveRoute("/story/pig-war/creating")).toEqual({ name: "creating", slug: "pig-war" });
    expect(resolveRoute("/story/pig-war/watch")).toEqual({ name: "watch", slug: "pig-war" });
  });

  test("sidebar highlight follows the flow a route belongs to", () => {
    expect(activeNav("/")).toBe("create");
    expect(activeNav("/story/pig-war")).toBe("create"); // drilling in from Create
    expect(activeNav("/story/pig-war/creating")).toBe("create");
    expect(activeNav("/videos")).toBe("videos");
    expect(activeNav("/story/pig-war/watch")).toBe("videos"); // watching belongs to Videos
    expect(activeNav("/settings")).toBe("config");
  });
});
