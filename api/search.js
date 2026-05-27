const https = require("https");

function callGroq(payload) {
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
      timeout: 30000,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Groq parse error: " + data.slice(0,200))); }
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

  const { query } = JSON.parse(body || "{}");
  if (!query) return res.status(400).json({ error: "Query obrigatória" });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY não configurada" });

  try {
    // Use compound-beta model which supports web search tool
    const response = await callGroq({
      model: "compound-beta",
      messages: [
        {
          role: "system",
          content: `Você é especialista em cifras de músicas gospel e hinos brasileiros.
Use a ferramenta de busca para encontrar a cifra REAL e COMPLETA da música solicitada no Cifra Club, Cifras.com.br ou outro site de cifras brasileiro.

FORMATO DE RESPOSTA OBRIGATÓRIO:
Título - Artista

[Intro]
[C] [G] [Am] [F]

[Verso 1]
[C]           [G]
Primeira linha da letra
[Am]          [F]
Segunda linha da letra

[Refrão]
[F]    [C]
Linha do refrão

Responda SOMENTE com a cifra completa formatada. Sem explicações ou comentários.`
        },
        {
          role: "user",
          content: `Busque e forneça a cifra completa de: "${query}"`
        }
      ],
      max_tokens: 3000,
      temperature: 0.1,
    });

    // compound-beta may return tool_use blocks + text
    const content = response.choices?.[0]?.message?.content;
    let result = "";

    if (typeof content === "string") {
      result = content;
    } else if (Array.isArray(content)) {
      result = content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
    }

    if (!result || result.length < 30) {
      // fallback to llama without web search
      const fallback = await callGroq({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `Você é especialista em cifras de músicas gospel brasileiras.
Se souber a cifra completa, forneça. Se não tiver certeza, responda: MÚSICA NÃO ENCONTRADA`
          },
          { role: "user", content: `Cifra de: "${query}"` }
        ],
        max_tokens: 3000,
        temperature: 0.1,
      });
      result = fallback.choices?.[0]?.message?.content || "";
    }

    if (!result || result.includes("MÚSICA NÃO ENCONTRADA")) {
      result = `"${query}" não foi encontrada.\n\nUse "Digitar Manual" para inserir a cifra manualmente.`;
    }

    return res.status(200).json({ result, source: "ia", url: null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
