const https = require("https");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; hinario-cifrado/1.0)",
        "Accept": "application/json",
      },
      timeout: 12000,
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(new Error("JSON parse error: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ─── VAGALUME ─────────────────────────────────────────────────────────────────
// Uses official public API: https://api.vagalume.com.br/docs/search/
async function searchVagalume(query) {
  const encoded = encodeURIComponent(query);

  // Try to find the song by name
  const data = await fetchJson(
    `https://api.vagalume.com.br/search.artmus?q=${encoded}&limit=5`
  );

  const docs = data?.response?.docs;
  if (!docs?.length) return null;

  const doc = docs[0];
  const musId = doc.id;
  const title = doc.title || doc.name || query;
  const artist = doc.band || doc.artist || "";

  // Fetch full lyrics by music ID
  const lyricsData = await fetchJson(
    `https://api.vagalume.com.br/search.php?musid=${musId}`
  );

  const lyrics = lyricsData?.mus?.[0]?.text;
  if (!lyrics) return null;

  return { title, artist, lyrics };
}

// ─── GROQ ─────────────────────────────────────────────────────────────────────
function callGroq(messages) {
  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile",
    messages,
    max_tokens: 3000,
    temperature: 0.1,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 25000,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content || ""); }
        catch { reject(new Error("Groq parse error")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Groq timeout")); });
    req.write(body);
    req.end();
  });
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = "";
  await new Promise(resolve => { req.on("data", c => body += c); req.on("end", resolve); });

  const { query } = JSON.parse(body || "{}");
  if (!query) return res.status(400).json({ error: "Query obrigatória" });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY não configurada" });

  try {
    let source = "ia";
    let result = null;

    // 1. Busca letra no Vagalume (API oficial, não bloqueia)
    let songInfo = null;
    try {
      songInfo = await searchVagalume(query);
      console.log("Vagalume:", songInfo ? `${songInfo.title} - ${songInfo.artist}` : "não encontrado");
    } catch (e) {
      console.log("Vagalume erro:", e.message);
    }

    if (songInfo) {
      // 2. Pede ao Groq para adicionar os acordes REAIS na letra encontrada
      source = "vagalume";
      result = await callGroq([
        {
          role: "system",
          content: `Você é especialista em cifras de músicas gospel e hinos brasileiros.
Receberá o título, artista e letra de uma música. Sua tarefa é adicionar os ACORDES CORRETOS E REAIS.

FORMATO OBRIGATÓRIO:
Título - Artista

[Intro]
[C] [G] [Am] [F]

[Verso 1]
[C]              [G]
Primeira linha da letra
[Am]             [F]
Segunda linha da letra

[Refrão]
[F]         [C]
Linha do refrão
[G]         [C]
Outra linha

Use os acordes REAIS da música. Responda SOMENTE a cifra formatada.`
        },
        {
          role: "user",
          content: `Título: ${songInfo.title}\nArtista: ${songInfo.artist}\n\nLETRA COMPLETA:\n${songInfo.lyrics.substring(0, 2500)}\n\nAdicione os acordes corretos e reais desta música:`
        }
      ]);
    } else {
      // 3. Groq puro — só responde se tiver certeza
      source = "ia";
      const groqResult = await callGroq([
        {
          role: "system",
          content: `Você é especialista em cifras de músicas gospel e hinos brasileiros.
Se souber a cifra COMPLETA E CORRETA da música solicitada, forneça no formato:
Título - Artista

[Seção]
[Acordes acima da letra]
Letra da música

Se NÃO tiver certeza dos acordes ou da letra, responda EXATAMENTE: MÚSICA NÃO ENCONTRADA
NUNCA invente. Só responda se tiver certeza.`
        },
        { role: "user", content: `Cifra completa de: "${query}"` }
      ]);

      if (groqResult.trim().startsWith("MÚSICA NÃO ENCONTRADA") || groqResult.includes("não foi encontrada")) {
        result = `"${query}" não foi encontrada nas nossas fontes.\n\nUse "Digitar Manual" para inserir a cifra manualmente.`;
        source = "ia";
      } else {
        result = groqResult;
      }
    }

    return res.status(200).json({ result, source, url: null });
  } catch (err) {
    console.error("Erro geral:", err);
    return res.status(500).json({ error: err.message });
  }
};
