// Proxy server — companion app talks to this, this talks to Gemini.
// Deploy on Render (same as before). Set GEMINI_API_KEY as an environment
// variable in Render's dashboard — do not hardcode it here.

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-flash-latest";

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}

app.post("/chat", async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;

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
          generationConfig: { maxOutputTokens: max_tokens || 4000 },
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
    if (data.error) return res.status(500).json({ error: data.error.message || "Gemini API error" });

    const cand = data.candidates && data.candidates[0];
    if (!cand) return res.json({ reply: "" });
    if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") {
      return res.status(500).json({ error: "Gemini blocked that reply (safety filter)." });
    }
    const parts = cand.content && cand.content.parts ? cand.content.parts : [];
    const reply = parts.map((p) => p.text || "").join("").trim();
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message || "Proxy error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
