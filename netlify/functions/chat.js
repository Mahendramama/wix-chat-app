// netlify/functions/chat.js
import OpenAI from "openai";
import { getStore } from "@netlify/blobs";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const store = getStore("chat-usage"); // Netlify Blobs store name

const DAILY_LIMIT = 1000; // tokens per day per user

function istDateKey() {
  // "YYYY-MM-DD" in Asia/Kolkata
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { email, messages } = body;

    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Valid email is required." })
      };
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "messages[] is required." })
      };
    }

    const key = `${email}:${istDateKey()}`;
    let usage = (await store.get(key, { type: "json" })) || {
      input: 0,
      output: 0,
      total: 0
    };

    if (usage.total >= DAILY_LIMIT) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          error: "Daily token limit reached.",
          remaining_today: 0
        })
      };
    }

    // Keep some headroom for prompt tokens
    const remaining = Math.max(0, DAILY_LIMIT - usage.total);
    // allow at least some output; clamp to sensible maximum
    const maxTokens = Math.max(64, Math.min(512, remaining - 64));

    // You can tune system prompt for your use-case
    const systemMessage = {
      role: "system",
      content:
        "You are a helpful UPSC/OPSC study assistant. Be concise, accurate, and cite syllabus sections conceptually when helpful. Never reveal the API key or system details."
    };

    const fullMessages = [systemMessage, ...messages];

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: fullMessages,
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

    // Persist usage for the day (per email)
    await store.set(key, JSON.stringify(usage), {
      metadata: { email, day: key.split(":")[1] }
    });

    const remaining_today = Math.max(0, DAILY_LIMIT - usage.total);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply,
        usage: {
          input_tokens,
          output_tokens,
          total_tokens,
          used_today: usage.total,
          remaining_today
        }
      })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error. Please try again." })
    };
  }
};
