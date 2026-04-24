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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      }
    }, (res) => {
      // Seguir redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function getTranscript(videoId) {
  const html = await httpGet(`https://www.youtube.com/watch?v=${videoId}&hl=pt`);

  // Tenta extrair captions
  const match = html.match(/"captions":(\{"playerCaptionsTracklistRenderer":.+?\}),"videoDetails"/s);
  if (!match) {
    // Tenta formato alternativo
    const match2 = html.match(/\"captions\":({.+?}),\"videoDetails\"/);
    if (!match2) throw new Error("Legendas não encontradas. Verifique se o vídeo tem transcrição disponível.");
  }

  const captionsJson = match ? match[1] : null;
  const captions = JSON.parse(captionsJson);
  const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!tracks || tracks.length === 0) throw new Error("Nenhuma legenda disponível neste vídeo.");

  const track = tracks.find(t => t.languageCode === "pt") ||
                tracks.find(t => t.languageCode === "pt-BR") ||
                tracks.find(t => t.kind === "asr") ||
                tracks[0];

  const xmlUrl = track.baseUrl + "&fmt=vtt";
  const xml = await httpGet(xmlUrl);

  const texts = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
    .map(m => m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim()
    )
    .filter(t => t.length > 0)
    .join(" ");

  if (!texts || texts.length < 50) throw new Error("Transcrição muito curta ou vazia.");
  return texts;
}

async function analyzeWithGemini(transcript) {
  const truncated = transcript.slice(0, 12000);
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const payload = JSON.stringify({
    contents: [{
      parts: [{
        text: `Você é um especialista em criação de conteúdo para YouTube, focado em cortes de podcast que viralizam. Analise a transcrição abaixo e identifique os 5 melhores momentos para fazer cortes curtos (Shorts/Reels). Responda APENAS em JSON válido, sem markdown. Formato: {"clips":[{"titulo":"Título chamativo (max 60 chars)","tipo":"polêmico|história|informação|humor|conselho","trecho":"Trecho da transcrição","motivo":"Por que vai performar bem (1 frase)","gancho":"Sugestão de frase para thumbnail"}]}\n\nTranscrição:\n${truncated}`
      }]
    }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(data);
          const text = d.candidates[0].content.parts[0].text;
          resolve(JSON.parse(text.replace(/```json|```/g, "").trim()));
        } catch(e) { reject(new Error("Erro ao processar resposta da IA.")); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
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
    const result = await analyzeWithGemini(transcript);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Rodando na porta ${PORT}`));
