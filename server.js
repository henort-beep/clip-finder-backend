const express = require("express");
const cors = require("cors");
const https = require("https");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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

async function getTranscript(videoId) {
  const tmpDir = "/tmp";
  const outPath = path.join(tmpDir, videoId);

  try {
    // Instala yt-dlp se não existir
    try { execSync("which yt-dlp"); }
    catch { execSync("pip install yt-dlp --break-system-packages 2>/dev/null || pip3 install yt-dlp 2>/dev/null || true"); }

    // Baixa legenda
    execSync(`yt-dlp --write-auto-sub --sub-lang pt,en --skip-download --no-warnings -o "${outPath}" "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`, { timeout: 30000 });

    // Procura o arquivo de legenda
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId) && f.endsWith(".vtt"));
    if (files.length === 0) throw new Error("Legenda não encontrada.");

    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");

    // Limpa o VTT e extrai texto
    const lines = content.split("\n")
      .filter(l => !l.match(/^\d{2}:\d{2}/) && !l.match(/^WEBVTT/) && !l.match(/^NOTE/) && l.trim() !== "")
      .map(l => l.replace(/<[^>]+>/g, "").trim())
      .filter(l => l.length > 0);

    // Remove duplicatas consecutivas
    const unique = lines.filter((l, i) => l !== lines[i - 1]);
    return unique.join(" ");

  } finally {
    // Limpa arquivos temporários
    try { execSync(`rm -f ${outPath}*`); } catch {}
  }
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
