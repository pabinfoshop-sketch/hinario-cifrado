const https = require("https");

function callGroq(payload, timeoutMs = 25000) {
  const body = JSON.stringify(payload);
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
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch { reject(new Error("Parse error")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(body);
    req.end();
  });
}

function extractText(json) {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  }
  return "";
}

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

  const systemPrompt = `Você é especialista em cifras de músicas gospel e hinos brasileiros.
Use a busca na web para encontrar a cifra REAL da música no Cifra Club ou Cifras.com.br.

FORMATO OBRIGATÓRIO:
Título - Artista

[Intro]
[C] [G] [Am] [F]

[Verso 1]
[C]           [G]
Linha da letra aqui
[Am]          [F]
Outra linha aqui

[Refrão]
[F]    [C]
Linha do refrão

Responda SOMENTE a cifra completa com todos acordes e letra.`;

  try {
    let result = "";

    // 1. compound-beta-mini — faster (single tool call), 25s timeout
    try {
      const r = await callGroq({
        model: "compound-beta-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Cifra completa de: "${query}"` }
        ],
        max_tokens: 3000,
        temperature: 0.1,
      }, 25000);

      if (r.status === 200) {
        result = extractText(r.json);
        console.log("compound-beta-mini ok, length:", result.length);
      } else {
        console.log("compound-beta-mini error:", r.status, JSON.stringify(r.json).slice(0,200));
      }
    } catch(e) {
      console.log("compound-beta-mini failed:", e.message);
    }

    // 2. Fallback: llama sem web search
    if (!result || result.length < 50) {
      const r2 = await callGroq({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `Especialista em cifras gospel brasileiras.
Se souber a cifra REAL e COMPLETA desta música, forneça com letra e acordes.
Se não tiver certeza, responda: MÚSICA NÃO ENCONTRADA`
          },
          { role: "user", content: `Cifra de: "${query}"` }
        ],
        max_tokens: 3000,
        temperature: 0.1,
      }, 20000);
      result = extractText(r2.json);
      console.log("llama fallback length:", result.length);
    }

    if (!result || result.includes("MÚSICA NÃO ENCONTRADA") || result.length < 30) {
      result = `"${query}" não foi encontrada.\n\nUse "Digitar Manual" para inserir a cifra manualmente.`;
    }

    return res.status(200).json({ result, source: "ia", url: null });
  } catch (err) {
    console.error("Erro geral:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
