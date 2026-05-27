const https = require("https");

function callGroq(messages, model = "llama-3.3-70b-versatile") {
  const body = JSON.stringify({
    model,
    messages,
    max_tokens: 3000,
    temperature: 0.1,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.groq.com",
        path: "/openai/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 20000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.choices?.[0]?.message?.content || "");
          } catch {
            reject(new Error("Groq parse error: " + data.slice(0, 200)));
          }
        });
      }
    );
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
  await new Promise((resolve) => {
    req.on("data", (chunk) => (body += chunk));
    req.on("end", resolve);
  });

  const { query } = JSON.parse(body || "{}");
  if (!query) return res.status(400).json({ error: "Query obrigatória" });

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "GROQ_API_KEY não configurada" });
  }

  try {
    const systemPrompt = `Você é um especialista em cifras de músicas gospel, hinos e louvores brasileiros com conhecimento profundo do repertório evangélico brasileiro.

REGRAS DE FORMATAÇÃO — siga EXATAMENTE:
1. Primeira linha: "Nome da Música - Artista/Ministério"
2. Deixe uma linha em branco
3. Use seções entre colchetes: [Intro], [Verso 1], [Verso 2], [Pré-Refrão], [Refrão], [Ponte], [Final]
4. Acordes ficam NA LINHA ACIMA da letra, alinhados com a sílaba correspondente
5. Acordes entre colchetes: [G] [Em] [C] [D] [Am] [F] etc
6. Inclua a cifra COMPLETA com toda a letra
7. Responda SOMENTE com a cifra, sem explicações, sem comentários

EXEMPLO DE FORMATO:
Exemplo - Artista

[Intro]
[G]  [Em]  [C]  [D]

[Verso 1]
[G]              [Em]
Primeira linha da letra aqui
[C]              [D]
Segunda linha da letra aqui

[Refrão]
[G]        [Em]
Refrão primeira linha
[C]    [D]      [G]
Refrão segunda linha`;

    const userPrompt = `Cifra completa de: "${query}"

Se não souber a cifra exata desta música, diga apenas: MÚSICA NÃO ENCONTRADA
Caso contrário, forneça a cifra completa com toda a letra.`;

    const result = await callGroq([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]);

    // If model doesn't know the song
    if (result.includes("MÚSICA NÃO ENCONTRADA")) {
      return res.status(200).json({
        result: `Música não encontrada: "${query}"\n\nTente buscar com o nome exato ou use "Digitar Manual" para inserir a cifra manualmente.`,
        source: "ia",
        not_found: true,
      });
    }

    return res.status(200).json({
      result,
      source: "ia",
      url: null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
