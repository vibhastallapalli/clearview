/**
 * Thin Gemini REST wrapper. The only file that knows which model we use.
 * To switch providers, reimplement geminiJson() with the same signature.
 */

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 30_000;
// Waits before each retry. Free-tier keys hit 429/503 often; two short retries ride out most spikes.
const RETRY_DELAYS_MS = [2_000, 5_000];

export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);
export const geminiModel = () => process.env.GEMINI_MODEL || "gemini-3.8-flash";

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export async function geminiJson(args: {
  prompt: string;
  file: { mimeType: string; data: Buffer };
  schema: object;
}): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce(args);
    } catch (err) {
      // Retry rate limits, server errors and timeouts. Never bad requests or bad output.
      if (!(err instanceof GeminiError) || !err.retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function callOnce(args: {
  prompt: string;
  file: { mimeType: string; data: Buffer };
  schema: object;
}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API}/${geminiModel()}:generateContent`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY!,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: args.prompt },
              { inline_data: { mime_type: args.file.mimeType, data: args.file.data.toString("base64") } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: args.schema,
        },
      }),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError")
      throw new GeminiError(`Gemini timed out after ${TIMEOUT_MS / 1000} s`, true);
    throw new GeminiError(`Gemini unreachable: ${(err as Error).message}`, true);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 429) throw new GeminiError("Gemini rate limit or quota reached (429). Wait a minute and retry.", true);
    if (res.status === 401 || res.status === 403) throw new GeminiError(`Gemini rejected the API key (${res.status}). Check GEMINI_API_KEY.`);
    if (res.status >= 500) throw new GeminiError(`Gemini server error ${res.status}: ${body}`, true);
    throw new GeminiError(`Gemini ${res.status}: ${body}`);
  }

  const json: any = await res.json().catch(() => null);
  const blocked = json?.promptFeedback?.blockReason;
  if (blocked) throw new GeminiError(`Gemini blocked the request (${blocked})`);
  const candidate = json?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p: any) => p?.text ?? "").join("");
  if (!text) throw new GeminiError(`Gemini returned no content (finishReason ${candidate?.finishReason ?? "unknown"})`);
  if (candidate?.finishReason === "MAX_TOKENS") throw new GeminiError("Gemini output was cut off (MAX_TOKENS)");
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError("Gemini returned invalid JSON");
  }
}
