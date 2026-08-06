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
if (!GROQ_API_KEY) console.warn("Missing GROQ_API_KEY — that fallback step will be skipped.");
if (!OPENROUTER_API_KEY) console.warn("Missing OPENROUTER_API_KEY — that fallback step will be skipped.");
if (!MISTRAL_API_KEY) console.warn("Missing MISTRAL_API_KEY — that fallback step will be skipped.");
if (!CRICKET_API_KEY) console.warn("Missing CRICKET_API_KEY — cricket data injection will be skipped.");

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
  con
