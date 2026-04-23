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
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function getTranscript(videoId) {
  const pageHtml = await fetchUrl(`https://www.youtube.com/watch?v=${videoId}`);
  const captionsMatch = pageHtml.match(/"captions":(.+?),"videoDetails"/s);
  if (!captionsMatch) throw new Error("Legendas não encontradas.");
  const captions = JSON.parse(captionsMatch[1]);
  const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) throw new Error("Nenhuma legenda disponível.");
  const track = tracks.find(t => t.languageCode === "pt") || tracks[0];
  const xmlData = await fetchUrl(track.baseUrl);
  const texts = [...xmlData.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
    .map(m => m[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#39;/g,"'").replace(/&quot;/g,'"'))
    .join(" ");
  return texts;
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Clip Finder Backend rodando!" });
});

app.get("/api/transcript", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Parâmetro 'url' é obrigatório." });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "URL do YouTube inválida." });
  try {
    const transcript = await getTranscript(videoId);
    return res.json({ videoId, transcript });
  } catch (err) {
    return res.status(500).json({ error: "Transcrição não encontrada.", details: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Rodando na porta ${PORT}`));
