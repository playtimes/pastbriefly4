import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../server/config.ts";

// Live OpenAI client (fetch-based). Endpoints per developers.openai.com:
//   text : POST /v1/responses   { model, input, instructions?, tools, text.format }
//   image: POST /v1/images/generations | /v1/images/edits (gpt-image-1)
// Read text output from response.output_text (or the output[].content[] fallback).
// PENDING LIVE VERIFICATION of exact behaviour before any paid run.

const API = "https://api.openai.com/v1";

function authHeaders(): Record<string, string> {
  if (!config.openai.apiKey) throw new Error("OPENAI_API_KEY not set. Add it to .env to run live.");
  return { Authorization: `Bearer ${config.openai.apiKey}` };
}

function readOutputText(resp: any): string {
  if (typeof resp.output_text === "string" && resp.output_text) return resp.output_text;
  const parts: string[] = [];
  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

// OpenAI answered successfully, but its output text was missing or not JSON:
// the model response exists (and is billed), yet nothing usable came back.
// Callers that account per answered call can tell it apart from a failed
// request; to everyone else it is an ordinary Error with the same message.
export class ProviderOutputError extends Error {
  readonly providerResponseReceived = true;
}

// One labelled image for a vision call: the saved file's bytes, read by the caller.
export interface InputImage {
  label: string;
  data: Buffer;
  mimeType: string;
}

// One structured-JSON Responses call, optionally with web search. With `images`,
// the input becomes one user message: the text, then each image preceded by its
// own label, sent inline at high detail (the pixels are what is reviewed).
// `model` and `reasoning` override the configured text model for this one call
// only; without them the request is exactly the configured default.
export async function respondJson<T>(opts: {
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  webSearch?: boolean;
  images?: InputImage[];
  model?: string;
  reasoning?: { effort: "low" | "medium" | "high" };
}): Promise<T> {
  const input = opts.images?.length
    ? [
        {
          role: "user",
          content: [
            { type: "input_text", text: opts.input },
            ...opts.images.flatMap((i) => [
              { type: "input_text", text: i.label },
              { type: "input_image", image_url: `data:${i.mimeType};base64,${i.data.toString("base64")}`, detail: "high" },
            ]),
          ],
        },
      ]
    : opts.input;
  const body: Record<string, unknown> = {
    model: opts.model ?? config.openai.model,
    instructions: opts.instructions,
    input,
    text: { format: { type: "json_schema", name: opts.schemaName, strict: true, schema: opts.schema } },
  };
  if (opts.webSearch) body.tools = [{ type: "web_search" }];
  if (opts.reasoning) body.reasoning = opts.reasoning;

  const res = await fetch(`${API}/responses`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI responses ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const text = readOutputText(await res.json());
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderOutputError(`OpenAI returned non-JSON output: ${text.slice(0, 200)}`);
  }
}

// Map a reference image's extension to a MIME type the OpenAI edits endpoint
// accepts. Blobs without a type are sent as application/octet-stream and rejected.
export function imageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  throw new Error(`Unsupported reference image type '${ext || filePath}'. Use .png, .jpg, .jpeg, or .webp.`);
}

// Generate one still. With reference images, use edits for visual continuity.
export async function generateImageFile(opts: {
  prompt: string;
  size: string;
  outPath: string;
  referencePaths?: string[];
}): Promise<void> {
  let data: string | undefined;
  if (opts.referencePaths && opts.referencePaths.length) {
    const form = new FormData();
    form.set("model", config.openai.imageModel);
    form.set("prompt", opts.prompt);
    form.set("size", opts.size);
    for (const p of opts.referencePaths) {
      const buf = await readFile(p);
      form.append("image[]", new Blob([buf], { type: imageMimeType(p) }), path.basename(p));
    }
    const res = await fetch(`${API}/images/edits`, { method: "POST", headers: authHeaders(), body: form });
    if (!res.ok) throw new Error(`OpenAI image edit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    data = (await res.json()).data?.[0]?.b64_json;
  } else {
    const res = await fetch(`${API}/images/generations`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.openai.imageModel, prompt: opts.prompt, size: opts.size, n: 1 }),
    });
    if (!res.ok) throw new Error(`OpenAI image ${res.status}: ${(await res.text()).slice(0, 300)}`);
    data = (await res.json()).data?.[0]?.b64_json;
  }
  if (!data) throw new Error("OpenAI image response had no image data.");
  await writeFile(opts.outPath, Buffer.from(data, "base64"));
}
