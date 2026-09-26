/**
 * Thin Gemini REST wrapper. The only file that knows which model we use.
 * To switch providers, reimplement geminiJson() with the same signature.
 */

const API = "https://generativelanguage.googleapis.com/v1beta/models";

export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

export async function geminiJson(args: {
  prompt: string;
  file: { mimeType: string; data: Buffer };
  schema: object;
}): Promise<unknown> {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: "POST",
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

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const json: any = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") throw new Error("Gemini returned no content");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }
}
