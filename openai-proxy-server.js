// Proxy server — companion app talks to this, this talks to Gemini (primary)
// with automatic fallback chain: Gemini -> Groq -> OpenRouter -> Mistral.
// Plus live cricket data injection via CricketData.org.
// Deploy on Render. Set these env vars in Render's dashboard:
// GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, MISTRAL_API_KEY, CRICKET_API_KEY

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-flash-latest";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = "mistral-small-latest";

const CRICKET_API_KEY = process.env.CRICKET_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}

function isCricketQuery(text) {
  if (!text) return false;
  const keywords = ["cricket", "ipl", "odi", "t20", "test match", "wicket", "over", "run rate",
    "world cup", "bcci", "icc", "batting", "bowling", "innings", "stump", "boundary"];
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

async function fetchCricketContext() {
  if (!CRICKET_API_KEY) return null;
  try {
    const response = await fetch(
      `https://api.cricapi.com/v1/currentMatches?apikey=${CRICKET_API_KEY}&offset=0`
    );
    const data = await response.json();
    if (!data.data || data.data.length === 0) return null;

    const summary = data.data.slice(0, 5).map((m) => {
      const teams = (m.teams || []).join(" vs ");
      const score = (m.score || [])
        .map((s) => `${s.inning}: ${s.r}/${s.w} (${s.o} ov)`)
        .join(", ");
      return `${m.name || teams} — Status: ${m.status}${score ? " — " + score : ""}`;
    }).join("\n");

    return summary;
  } catch (e) {
    console.error("Cricket API fetch failed:", e.message);
    return null;
  }
}

async function callGemini(system, messages, max_tokens) {
  const contents = (messages || []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: max_tokens || 1200 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
        ],
      }),
    }
  );

  const data = await response.json();
  if (data.error) {
    const code = data.error.code;
    const msg = (data.error.message || "").toLowerCase();
    const isRateLimit = code === 429 || msg.includes("quota") || msg.includes("rate limit");
    const err = new Error(data.error.message || "Gemini API error");
    err.isRateLimit = isRateLimit;
    throw err;
  }

  const cand = data.candidates && data.candidates[0];
  if (!cand) return "";
  if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") {
    const err = new Error("Gemini blocked that reply (safety filter).");
    err.isSafetyBlock = true;
    throw err;
  }
  const parts = cand.content && cand.content.parts ? cand.content.parts : [];
  return parts.map((p) => p.text || "").join("").trim();
}

// Generic helper for OpenAI-compatible chat APIs (Groq, OpenRouter, Mistral)
async function callOpenAiCompatible(url, apiKey, model, system, messages, max_tokens, extraHeaders) {
  const chatMessages = [
    { role: "system", content: system || "" },
    ...(messages || []).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(extraHeaders || {}),
    },
    body: JSON.stringify({ model, messages: chatMessages, max_tokens: max_tokens || 1200 }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || data.error || "API error");

  const choice = data.choices && data.choices[0];
  return choice && choice.message ? (choice.message.content || "").trim() : "";
}

const callGroq = (system, messages, max_tokens) =>
  callOpenAiCompatible("https://api.groq.com/openai/v1/chat/completions", GROQ_API_KEY, GROQ_MODEL, system, messages, max_tokens);

const callOpenRouter = (system, messages, max_tokens) =>
  callOpenAiCompatible("https://openrouter.ai/api/v1/chat/completions", OPENROUTER_API_KEY, OPENROUTER_MODEL, system, messages, max_tokens);

const callMistral = (system, messages, max_tokens) =>
  callOpenAiCompatible("https://api.mistral.ai/v1/chat/completions", MISTRAL_API_KEY, MISTRAL_MODEL, system, messages, max_tokens);

app.post("/chat", async (req, res) => {
  let { system, messages, max_tokens } = req.body;

  const lastUserMsg = [...(messages || [])].reverse().find((m) => m.role === "user");
  if (lastUserMsg && isCricketQuery(lastUserMsg.content)) {
    const cricketInfo = await fetchCricketContext();
    if (cricketInfo) {
      system = `${system || ""}\n\nLive cricket data (use this if relevant to the user's question, current as of now):\n${cricketInfo}`;
    }
  }

  const errors = [];

  try {
    const reply = await callGemini(system, messages, max_tokens);
    return res.json({ reply, provider: "gemini" });
  } catch (e) {
    errors.push(`Gemini: ${e.message}`);
    if (e.isSafetyBlock) return res.status(500).json({ error: e.message });
  }

  if (GROQ_API_KEY) {
    try {
      const reply = await callGroq(system, messages, max_tokens);
      return res.json({ reply, provider: "groq" });
    } catch (e) {
      errors.push(`Groq: ${e.message}`);
    }
  }

  if (OPENROUTER_API_KEY) {
    try {
      const reply = await callOpenRouter(system, messages, max_tokens);
      return res.json({ reply, provider: "openrouter" });
    } catch (e) {
      errors.push(`OpenRouter: ${e.message}`);
    }
  }

  if (MISTRAL_API_KEY) {
    try {
      const reply = await callMistral(system, messages, max_tokens);
      return res.json({ reply, provider: "mistral" });
    } catch (e) {
      errors.push(`Mistral: ${e.message}`);
    }
  }

  return res.status(500).json({ error: `All providers failed. ${errors.join(" | ")}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
