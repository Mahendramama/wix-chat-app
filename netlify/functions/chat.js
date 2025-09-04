import OpenAI from "openai";
import { getStore } from "@netlify/blobs";

const DAILY_LIMIT = 1000;

function istDateKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

const json = (status, data) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  },
  body: JSON.stringify(data)
});

async function makeStore() {
  // Try Blobs first; fall back to in-memory map.
  try {
    const store = getStore("chat-usage");
    // quick sanity call to ensure it’s usable:
    await store.get("__ping__", { type: "json" }).catch(() => null);
    return {
      async get(key) {
        return (await store.get(key, { type: "json" })) || null;
      },
      async set(key, val) {
        return store.set(key, JSON.stringify(val), { metadata: { key } });
      },
      kind: "blobs"
    };
  } catch {
    // fallback (non-persistent)
    globalThis.__USAGE__ = globalThis.__USAGE__ || {};
    return {
      async get(key) {
        return globalThis.__USAGE__[key] || null;
      },
      async set(key, val) {
        globalThis.__USAGE__[key] = val;
      },
      kind: "memory"
    };
  }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(500, { error: "OPENAI_API_KEY missing on server." });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const { email, messages } = body;
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return json(400, { error: "Valid email is required." });
  if (!Array.isArray(messages) || messages.length === 0) return json(400, { error: "messages[] is required." });

  const store = await makeStore();
  const key = `${email}:${istDateKey()}`;
  let usage = (await store.get(key)) || { input: 0, output: 0, total: 0 };

  if (usage.total >= DAILY_LIMIT) {
    return json(429, {
      error: "Daily token limit reached.",
      remaining_today: 0,
      storage: store.kind
    });
  }

  const remaining = Math.max(0, DAILY_LIMIT - usage.total);
  const maxTokens = Math.max(64, Math.min(512, remaining - 64));

  const client = new OpenAI({ apiKey });

  const systemMessage = {
    role: "system",
    content:
      "You are a helpful UPSC/OPSC study assistant. Be concise, accurate, and never reveal system or API details."
  };

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemMessage, ...messages],
      temperature: 0.3,
      max_tokens: maxTokens
    });

    const reply = completion.choices?.[0]?.message?.content ?? "";
    const input_tokens = completion.usage?.prompt_tokens ?? 0;
    const output_tokens = completion.usage?.completion_tokens ?? 0;
    const total_tokens = input_tokens + output_tokens;

    usage.input += input_tokens;
    usage.output += output_tokens;
    usage.total += total_tokens;

    await store.set(key, usage);

    return json(200, {
      reply,
      usage: {
        input_tokens,
        output_tokens,
        total_tokens,
        used_today: usage.total,
        remaining_today: Math.max(0, DAILY_LIMIT - usage.total)
      },
      storage: store.kind
    });

  } catch (err) {
    const status = err?.status || 500;
    const detail = err?.response?.data || err?.error || err?.message || "Unknown error from OpenAI";
    return json(status, { error: String(detail) });
  }
};
