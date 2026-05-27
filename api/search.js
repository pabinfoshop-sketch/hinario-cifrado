const https = require("https");

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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = "";
  await new Promise(resolve => { req.on("data", c => body += c); req.on("end", resolve); });

  const { query, lyrics, title, artist } = JSON.parse(body || "{}");
  if (!query) return res.status(400).json({ error: "Query obrigatória" });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY não configurada" });

  try {
    let result;

    if (lyrics && lyrics.length > 50) {
      // Client sent real lyrics from Vagalume — just add chords
      result = await callGroq([
        {
          role: "system",
          content: `Você é especialista em cifras de músicas gospel e hinos brasileiros.
Receberá o título, artista e letra de uma música. Adicione os ACORDES CORRETOS E REAIS.

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
[F]    [C]
Linha do refrão

Responda SOMENTE a cifra formatada, sem explicações.`
        },
        {
          role: "user",
          content: `Título: ${title || query}\nArtista: ${artist || ''}\n\nLETRA:\n${lyrics.substring(0, 2500)}\n\nAdicione os acordes reais desta música:`
        }
      ]);
    } else {
      // No lyrics — pure Groq fallback
      result = await callGroq([
        {
          role: "system",
          content: `Você é especialista em cifras de músicas gospel e hinos brasileiros.
Se souber a cifra COMPLETA desta música, forneça com acordes e letra completa.
Se NÃO souber com certeza, responda: MÚSICA NÃO ENCONTRADA
NUNCA invente acordes ou letra.`
        },
        { role: "user", content: `Cifra de: "${query}"` }
      ]);

      if (!result || result.includes("MÚSICA NÃO ENCONTRADA")) {
        result = `"${query}" não foi encontrada.\n\nUse "Digitar Manual" para inserir a cifra manualmente.`;
      }
    }

    return res.status(200).json({ result, source: lyrics ? "vagalume" : "ia" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
