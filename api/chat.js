import { SYSTEM_PROMPT, SUPPORT_EMAIL } from "./_knowledge.js";

const MAX_TURNS = 16;
const MAX_CHARS = 2000;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return send(res, 503, { error: "The assistant is not configured." });

  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const contents = raw
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.slice(0, MAX_CHARS) }],
    }));
  if (!contents.length || contents[contents.length - 1].role !== "user") {
    return send(res, 400, { error: "Send a question." });
  }

  const model = process.env.NURU_CHAT_MODEL || "gemini-3.5-flash-lite";
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
      }),
    });
    if (!r.ok) {
      console.error("[chat] model error", r.status, (await r.text()).slice(0, 400));
      return send(res, 502, { error: `The assistant is busy. Write to ${SUPPORT_EMAIL}.` });
    }
    const data = await r.json();
    const reply = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    return send(res, 200, { reply: reply || `I could not answer that. Write to ${SUPPORT_EMAIL}.` });
  } catch (err) {
    console.error("[chat] failed", err instanceof Error ? err.message : err);
    return send(res, 502, { error: `The assistant is busy. Write to ${SUPPORT_EMAIL}.` });
  }
}
