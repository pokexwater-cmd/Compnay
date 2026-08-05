// A tiny proxy server that sits between your companion artifact and OpenAI.
// Deploy this somewhere (Render, Railway, Fly.io, a VPS, etc.) — it can't run
// inside the Claude artifact itself, since artifacts can't host servers.
//
// SETUP:
//   1. npm init -y
//   2. npm install express cors node-fetch@2
//   3. Set OPENAI_API_KEY as an environment variable on your host
//      (never hardcode it here — that defeats the point of a proxy)
//   4. Deploy. You'll get a URL like https://your-app.onrender.com
//   5. In companion.jsx, point fetch() at:
//        https://your-app.onrender.com/chat
//      instead of https://api.openai.com/v1/chat/completions directly,
//      and remove the OPENAI_API_KEY constant from the artifact entirely —
//      it's no longer needed client-side.

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors()); // allows the artifact (running in the browser) to call this server
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
  process.exit(1);
}

app.post("/chat", async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        max_tokens: max_tokens || 4000,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const reply = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message || "Proxy error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
