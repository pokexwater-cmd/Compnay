// Proxy server — companion app talks to this, this talks to Gemini (primary)
// with automatic fallback to Groq, plus live cricket data injection via CricketData.org.
// Deploy on Render. Set GEMINI_API_KEY, GROQ_API_KEY, CRICKET_API_KEY as
// environment variables in Render's dashboard — do not hardcode them here.

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

const CRICKET_API_KEY = process.env.CRICKET_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}
if (!GROQ_API_KEY) {
  console.warn("Missing GROQ_API_KEY — fallback will be unavailable if Gemini is rate-limited.");
}
if (!CRICKET_API_KEY) {
  console.warn("Missing CRICKET_API_KEY — cricket data injection will be skipped.");
}

// Simple keyword check — catches most cricket questions without wasting API calls
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

    // Keep it compact — just the essentials for a handful of live/recent matches
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
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: max_tokens || 2000 },
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

async function callGroq(system, messages, max_tokens) {
  const groqMessages = [
    { role: "system", content: system || "" },
    ...(messages || []).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: groqMessages,
      max_tokens: max_tokens || 2000,
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || "Groq API error");

  const choice = data.choices && data.choices[0];
  return choice && choice.message ? (choice.message.content || "").trim() : "";
}

app.post("/chat", async (req, res) => {
  let { system, messages, max_tokens } = req.body;

  // If the latest user message looks cricket-related, pull in live data
  const lastUserMsg = [...(messages || [])].reverse().find((m) => m.role === "user");
  if (lastUserMsg && isCricketQuery(lastUserMsg.content)) {
    const cricketInfo = await fetchCricketContext();
    if (cricketInfo) {
      system = `${system || ""}\n\nLive cricket data (use this if relevant to the user's question, current as of now):\n${cricketInfo}`;
    }
  }

  try {
    const reply = await callGemini(system, messages, max_tokens);
    return res.json({ reply, provider: "gemini" });
  } catch (e) {
    if (e.isSafetyBlock) {
      return res.status(500).json({ error: e.message });
    }
    if (e.isRateLimit && GROQ_API_KEY) {
      console.warn("Gemini rate-limited, falling back to Groq...");
      try {
        const reply = await callGroq(system, messages, max_tokens);
        return res.json({ reply, provider: "groq" });
      } catch (groqErr) {
        return res.status(500).json({ error: `Both providers failed. Gemini: ${e.message} | Groq: ${groqErr.message}` });
      }
    }
    return res.status(500).json({ error: e.message || "Proxy error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
