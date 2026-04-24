const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/live\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : require("http");
    const req = mod.request(url, { headers: { "User-Agent": "Mozilla/5.0", ...options.headers }, method: options.method || "GET" }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getTranscript(videoId) {
  const { body: pageHtml } = await fetchUrl(`https://www.youtube.com/watch?v=${videoId}`);
  const captionsMatch = pageHtml.match(/"captions":(.+?),"videoDetails"/s);
  if (!captionsMatch) throw new Error("Legendas não encontradas.");
  const captions = JSON.parse(captionsMatch[1]);
  const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) throw new Error("Nenhuma legenda disponível.");
  const track = tracks.find(t => t.languageCode === "pt") || tracks[0];
  const { body: xmlData } = await fetchUrl(track.baseUrl);
  return [...xmlData.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
    .map(m => m[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#39;/g,"'").replace(/&quot;/g,'"'))
    .join(" ");
}

async function analyzeWithClaude(transcript) {
  const truncated = transcript.slice(0, 12000);
  const payload = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: `Você é um especialista em criação de conteúdo para YouTube, focado em cortes de podcast que viralizam. Analise transcrições e identifique os 5 melhores momentos para fazer cortes curtos. Responda APENAS em JSON válido, sem markdown. Formato: {"clips":[{"titulo":"Título chamativo (max 60 chars)","tipo":"polêmico|história|informação|humor|conselho","trecho":"Trecho da transcrição","motivo":"Por que vai performar bem (1 frase)","gancho":"Sugestão de frase para thumbnail"}]}`,
    messages: [{ role: "user", content: `Analise e encontre os 5 melhores momentos:\n\n${truncated}` }]
  });

  const { body } = await fetchUrl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: payload
  });

  const data = JSON.parse(body);
  const text = data.content.map(i => i.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

app.get("/", (req, res) => res.json({ status: "ok" }));

app.get("/api/transcript", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Parâmetro 'url' é obrigatório." });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "URL do YouTube inválida." });
  try {
    const transcript = await getTranscript(videoId);
    return res.json({ videoId, transcript });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: "Transcrição não fornecida." });
  try {
    const result = await analyzeWithClaude(transcript);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Rodando na porta ${PORT}`));
