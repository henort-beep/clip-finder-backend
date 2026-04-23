const express = require("express");
const cors = require("cors");
const { YoutubeTranscript } = require("youtube-transcript");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Clip Finder Backend rodando!" });
});

app.get("/api/transcript", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Parâmetro 'url' é obrigatório." });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "URL do YouTube inválida." });

  try {
    const transcriptArr = await YoutubeTranscript.fetchTranscript(videoId, { lang: "pt" })
      .catch(() => YoutubeTranscript.fetchTranscript(videoId));

    const transcript = transcriptArr.map((t) => t.text).join(" ");
    return res.json({ videoId, transcript });
  } catch (err) {
    return res.status(500).json({ error: "Transcrição não encontrada.", details: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Rodando na porta ${PORT}`));
