const https = require("https");

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "pt-BR,pt;q=0.9",
        ...options.headers,
      },
      timeout: 8000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      }

      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function extractCifraClubContent(html) {
  // Extract song title
  const titleMatch = html.match(/<h1[^>]*class="[^"]*t1[^"]*"[^>]*>([^<]+)<\/h1>/i)
    || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Extract artist
  const artistMatch = html.match(/<h2[^>]*class="[^"]*t3[^"]*"[^>]*>([^<]+)<\/h2>/i)
    || html.match(/class="[^"]*artist[^"]*"[^>]*>([^<]+)</i);
  const artist = artistMatch ? artistMatch[1].trim() : "";

  // Extract the chord/tab content — it's inside <pre> tags on Cifra Club
  const preMatches = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/gi);
  if (!preMatches) return null;

  let cifraRaw = preMatches
    .map((block) =>
      block
        .replace(/<[^>]+>/g, "") // strip HTML tags
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
    )
    .join("\n\n");

  if (cifraRaw.length < 50) return null;

  return { title, artist, cifra: cifraRaw.trim() };
}

async function searchCifraClub(query) {
  const encoded = encodeURIComponent(query);

  // Use Cifra Club's autocomplete/suggest API — returns JSON with direct URLs
  const suggestUrl = `https://www.cifraclub.com.br/api/suggest/?q=${encoded}&limit=5`;
  let cifraUrl = null;

  try {
    const suggestRes = await fetchUrl(suggestUrl);
    if (suggestRes.status === 200) {
      const json = JSON.parse(suggestRes.body);
      // Response is array of {url, name, artist, ...}
      const first = Array.isArray(json) ? json[0] : (json.data && json.data[0]);
      if (first && first.url) {
        cifraUrl = first.url.startsWith('http')
          ? first.url
          : `https://www.cifraclub.com.br${first.url}`;
      }
    }
  } catch(e) {
    console.log('Suggest API failed:', e.message);
  }

  // Fallback: scrape search page
  if (!cifraUrl) {
    const searchUrl = `https://www.cifraclub.com.br/search/?q=${encoded}&type=cifra`;
    const searchRes = await fetchUrl(searchUrl);
    if (searchRes.status !== 200) throw new Error("Cifra Club search failed");

    // Try to find URL in JSON-LD structured data first
    const jsonLdMatch = searchRes.body.match(/<script type="application\/ld\+json">[\s\S]*?"url"\s*:\s*"(https:\/\/www\.cifraclub\.com\.br\/[^"]+\/[^"]+\/)"[\s\S]*?<\/script>/i);
    // Then try href patterns
    const hrefMatch =
      searchRes.body.match(/href="(https?:\/\/(?:www\.)?cifraclub\.com\.br\/[a-z0-9\-]+\/[a-z0-9\-]+\/)"/i) ||
      searchRes.body.match(/href="(\/[a-z0-9\-]{3,}\/[a-z0-9\-]{3,}\/)"/i);

    const raw = (jsonLdMatch && jsonLdMatch[1]) || (hrefMatch && hrefMatch[1]);
    if (!raw) return null;
    cifraUrl = raw.startsWith('http') ? raw : `https://www.cifraclub.com.br${raw}`;
  }

  const cifraRes = await fetchUrl(cifraUrl);
  if (cifraRes.status !== 200) return null;

  const content = extractCifraClubContent(cifraRes.body);
  if (!content) return null;

  return { ...content, url: cifraUrl };
}

async function callGroq(prompt) {
  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000,
    temperature: 0.3,
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
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.choices?.[0]?.message?.content || "");
          } catch {
            reject(new Error("Groq parse error"));
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
    return res.status(500).json({ error: "API key não configurada" });
  }

  try {
    // 1. Try scraping Cifra Club first
    let cifraData = null;
    try {
      cifraData = await searchCifraClub(query);
    } catch (e) {
      console.log("Cifra Club scraping failed:", e.message);
    }

    let prompt;

    if (cifraData) {
      // Use scraped data — ask Groq to clean/format it
      prompt = `Você é um assistente de cifras musicais.

Encontrei esta cifra no Cifra Club para "${query}":
Música: ${cifraData.title}
Artista: ${cifraData.artist}
URL: ${cifraData.url}

Conteúdo bruto:
${cifraData.cifra.substring(0, 3000)}

Por favor, formate esta cifra de forma limpa e organizada, mantendo os acordes entre colchetes no formato [Acorde] acima de cada trecho da letra correspondente. Corrija qualquer problema de formatação. Responda APENAS com a cifra formatada, começando com o nome da música e artista.`;
    } else {
      // Fallback: ask Groq from memory
      prompt = `Você é um especialista em cifras de músicas gospel, hinos e louvores brasileiros.

O usuário quer a cifra COMPLETA de: "${query}"

REGRAS OBRIGATÓRIAS:
1. Escreva o nome da música e artista na primeira linha
2. Inclua TODAS as partes: [Intro], [Verso 1], [Pré-Refrão], [Refrão], [Verso 2], [Ponte], [Final] etc
3. Cada acorde deve aparecer entre colchetes: [G] [Em] [C] [D]
4. Coloque os acordes NA LINHA ACIMA da letra correspondente
5. Inclua a letra COMPLETA da música sob os acordes
6. NÃO omita nenhuma parte da música
7. Responda APENAS com a cifra, sem explicações

Exemplo de formato correto:
Música - Artista

[Intro]
[G] [Em] [C] [D]

[Verso 1]
[G]          [Em]
Primeira linha da letra
[C]          [D]
Segunda linha da letra

[Refrão]
[G]    [Em]
Letra do refrão
[C]    [D]
Continua o refrão

Agora forneça a cifra COMPLETA de "${query}":`;
    }

    const result = await callGroq(prompt);

    return res.status(200).json({
      result,
      source: cifraData ? "cifraclub" : "ia",
      url: cifraData?.url || null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
