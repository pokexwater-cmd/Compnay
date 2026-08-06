// Proxy server — companion app talks to this, this talks to Gemini (primary)
// with automatic fallback chain: Gemini -> Groq -> OpenRouter -> Mistral.
// Plus live cricket data (CricketData.org) and general web search (Tavily)
// injected into context for relevant questions.
// Deploy on Render. Set these env vars in Render's dashboard:
// GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, MISTRAL_API_KEY,
// CRICKET_API_KEY, TAVILY_API_KEY

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
const OPENROUTER_MODEL = "openrouter/free";

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = "mistral-small-latest";

const CRICKET_API_KEY = process.env.CRICKET_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}
if (!GROQ_API_KEY) console.warn("Missing GROQ_API_KEY — that fallback step will be skipped.");
if (!OPENROUTER_API_KEY) console.warn("Missing OPENROUTER_API_KEY — that fallback step will be skipped.");
if (!MISTRAL_API_KEY) console.warn("Missing MISTRAL_API_KEY — that fallback step will be skipped.");
if (!CRICKET_API_KEY) console.warn("Missing CRICKET_API_KEY — cricket match data will be skipped.");
if (!TAVILY_API_KEY) console.warn("Missing TAVILY_API_KEY — web search context will be skipped.");

function isCricketQuery(text) {
  if (!text) return false;
  const keywords = ["cricket", "ipl", "odi", "t20", "test match", "wicket", "over", "run rate",
    "world cup", "bcci", "icc", "batting", "bowling", "innings", "stump", "boundary"];
  const lower = text.toLowerCase();
  return keywords.some(function (k) { return lower.indexOf(k) !== -1; });
}

async function fetchCricketContext() {
  if (!CRICKET_API_KEY) return null;
  try {
    const response = await fetch(
      "https://api.cricapi.com/v1/currentMatches?apikey=" + CRICKET_API_KEY + "&offset=0"
    );
    const data = await response.json();
    if (!data.data || data.data.length === 0) return null;

    const summary = data.data.slice(0, 5).map(function (m) {
      const teams = (m.teams || []).join(" vs ");
      const score = (m.score || [])
        .map(function (s) {
          return s.inning + ": " + s.r + "/" + s.w + " (" + s.o + " ov)";
        })
        .join(", ");
      return (m.name || teams) + " — Status: " + m.status + (score ? " — " + score : "");
    }).join("\n");

    return summary;
  } catch (e) {
    console.error("Cricket API fetch failed:", e.message);
    return null;
  }
}

async function fetchWebContext(query) {
  if (!TAVILY_API_KEY) return null;
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + TAVILY_API_KEY,
      },
      body: JSON.stringify({
        query: query,
        search_depth: "basic",
        max_results: 3,
      }),
    });

    const data = await response.json();
    if (!data.results || data.results.length === 0) return null;

    const summary = data.results.map(function (r) {
      return r.title + ": " + r.content;
    }).join("\n\n");

    return summary;
  } catch (e) {
    console.error("Tavily fetch failed:", e.message);
    return null;
  }
}

async function callGemini(system, messages, max_tokens) {
  const contents = (messages || []).map(function (m) {
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    };
  });

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: contents,
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
    const isRateLimit = code === 429 || msg.indexOf("quota") !== -1 || msg.indexOf("rate limit") !== -1;
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
  return parts.map(function (p) { return p.text || ""; }).join("").trim();
}

async function callOpenAiCompatible(url, apiKey, model, system, messages, max_tokens) {
  const chatMessages = [
    { role: "system", content: system || "" },
  ].concat(
    (messages || []).map(function (m) {
      return {
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      };
    })
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({ model: model, messages: chatMessages, max_tokens: max_tokens || 1200 }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || data.error || "API error");

  const choice = data.choices && data.choices[0];
  return choice && choice.message ? (choice.message.content || "").trim() : "";
}

function callGroq(system, messages, max_tokens) {
  return callOpenAiCompatible("https://api.groq.com/openai/v1/chat/completions", GROQ_API_KEY, GROQ_MODEL, system, messages, max_tokens);
}

function callOpenRouter(system, messages, max_tokens) {
  return callOpenAiCompatible("https://openrouter.ai/api/v1/chat/completions", OPENROUTER_API_KEY, OPENROUTER_MODEL, system, messages, max_tokens);
}

function callMistral(system, messages, max_tokens) {
  return callOpenAiCompatible("https://api.mistral.ai/v1/chat/completions", MISTRAL_API_KEY, MISTRAL_MODEL, system, messages, max_tokens);
}

app.post("/chat", async function (req, res) {
  let system = req.body.system;
  const messages = req.body.messages;
  const max_tokens = req.body.max_tokens;

  const reversed = (messages || []).slice().reverse();
  let lastUserMsg = null;
  for (let i = 0; i < reversed.length; i++) {
    if (reversed[i].role === "user") {
      lastUserMsg = reversed[i];
      break;
    }
  }

  if (lastUserMsg && isCricketQuery(lastUserMsg.content)) {
    const cricketInfo = await fetchCricketContext();
    if (cricketInfo) {
      system = (system || "") + "\n\nLive cricket match data (use this if relevant, current as of now):\n" + cricketInfo;
    }

    const webInfo = await fetchWebContext(lastUserMsg.content);
    if (webInfo) {
      system = (system || "") + "\n\nWeb search results (use this if it answers the question more precisely):\n" + webInfo;
    }
  }

  const errors = [];

  try {
    const reply = await callGemini(system, messages, max_tokens);
    return res.json({ reply: reply, provider: "gemini" });
  } catch (e) {
    errors.push("Gemini: " + e.message);
    if (e.isSafetyBlock) return res.status(500).json({ error: e.message });
  }

  if (GROQ_API_KEY) {
    try {
      const reply = await callGroq(system, messages, max_tokens);
      return res.json({ reply: reply, provider: "groq" });
    } catch (e) {
      errors.push("Groq: " + e.message);
    }
  }

  if (OPENROUTER_API_KEY) {
    try {
      const reply = await callOpenRouter(system, messages, max_tokens);
      return res.json({ reply: reply, provider: "openrouter" });
    } catch (e) {
      errors.push("OpenRouter: " + e.message);
    }
  }

  if (MISTRAL_API_KEY) {
    try {
      const reply = await callMistral(system, messages, max_tokens);
      return res.json({ reply: reply, provider: "mistral" });
    } catch (e) {
      errors.push("Mistral: " + e.message);
    }
  }

  return res.status(500).json({ error: "All providers failed. " + errors.join(" | ") });
});

// Visit /health in your browser to test all providers at once
app.get("/health", async function (req, res) {
  const results = {};
  const testMsg = [{ role: "user", content: "Say OK" }];

  try {
    await callGemini("Reply with just OK.", testMsg, 10);
    results.gemini = "working";
  } catch (e) {
    results.gemini = "failed: " + e.message;
  }

  if (GROQ_API_KEY) {
    try {
      await callGroq("Reply with just OK.", testMsg, 10);
      results.groq = "working";
    } catch (e) {
      results.groq = "failed: " + e.message;
    }
  } else {
    results.groq = "no key set";
  }

  if (OPENROUTER_API_KEY) {
    try {
      await callOpenRouter("Reply with just OK.", testMsg, 10);
      results.openrouter = "working";
    } catch (e) {
      results.openrouter = "failed: " + e.message;
    }
  } else {
    results.openrouter = "no key set";
  }

  if (MISTRAL_API_KEY) {
    try {
      await callMistral("Reply with just OK.", testMsg, 10);
      results.mistral = "working";
    } catch (e) {
      results.mistral = "failed: " + e.message;
    }
  } else {
    results.mistral = "no key set";
  }

  if (CRICKET_API_KEY) {
    const c = await fetchCricketContext();
    results.cricket = c ? "working" : "failed or no live matches";
  } else {
    results.cricket = "no key set";
  }

  if (TAVILY_API_KEY) {
    const w = await fetchWebContext("test search");
    results.tavily = w ? "working" : "failed or no results";
  } else {
    results.tavily = "no key set";
  }

  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("Proxy listening on port " + PORT);
});
