const https = require("https");

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        Referer: "https://www.cifraclub.com.br/",
        ...options.headers,
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function extractCifraClubContent(html, url) {
  // Extract song title
  const titleMatch = html.match(/<h1[^>]*class="[^"]*t1[^"]*"[^>]*>([^<]+)<\/h1>/i)
    || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Extract artist
  const artistMatch = html.match(/<h2[^>]*class="[^"]*t3[^"]*"[^>]*>([^<]+)<\/h2>/i)
    || html.match(/class="[^"]*artist[^"]*"[^>]*>([^<]+)</i);
  const artist = artistMatch ? artistMatch[1].trim() : "";

  // Try to extract chords from the cifra content div
  // Cifra Club uses a specific div structure with data attributes or class "cifra_cnt"
  let cifraRaw = "";

  // Method 1: look for cifra_cnt or similar container
  const cifraContainerMatch = html.match(/class="[^"]*cifra_cnt[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/id="[^"]*cifra[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (cifraContainerMatch) {
    cifraRaw = cifraContainerMatch[1]
      .replace(/<b>([^<]+)<\/b>/g, "[$1]") // <b>G</b> -> [G] (Cifra Club format)
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  }

  // Method 2: extract from <pre> tags
  if (!cifraRaw || cifraRaw.length < 50) {
    const preMatches = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/gi);
    if (preMatches) {
      cifraRaw = preMatches
        .map((block) =>
          block
            .replace(/<b>([^<]+)<\/b>/g, "[$1]") // convert bold chords to [Chord]
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        )
        .join("\n\n");
    }
  }

  // Method 3: look for JSON-LD with cifra data
  if (!cifraRaw || cifraRaw.length < 50) {
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const script of scriptMatches) {
      if (script.includes('"cifra"') || script.includes('"tab"')) {
        const jsonMatch = script.match(/\{[\s\S]+\}/);
        if (jsonMatch) {
          try {
            const data = JSON.parse(jsonMatch[0]);
            if (data.cifra) { cifraRaw = data.cifra; break; }
          } catch(e) {}
        }
      }
    }
  }

  if (!cifraRaw || cifraRaw.length < 50) return null;

  return { title, artist, cifra: cifraRaw.trim(), url };
}

async function searchCifraClub(query) {
  const encoded = encodeURIComponent(query);

  // Step 1: Use Cifra Club's suggest/autocomplete API
  let cifraUrl = null;

  // Try the suggest endpoint
  const suggestUrls = [
    `https://www.cifraclub.com.br/api/suggest/?q=${encoded}&limit=5`,
    `https://www.cifraclub.com.br/busca/?q=${encoded}`,
  ];

  for (const suggestUrl of suggestUrls) {
    try {
      const suggestRes = await fetchUrl(suggestUrl, {
        headers: { Accept: "application/json, text/html" }
      });
      if (suggestRes.status === 200) {
        // Try JSON first
        try {
          const json = JSON.parse(suggestRes.body);
          const items = Array.isArray(json) ? json : (json.data || json.results || []);
          const first = items[0];
          if (first) {
            const url = first.url || first.link || first.href;
            if (url) {
              cifraUrl = url.startsWith("http") ? url : `https://www.cifraclub.com.br${url}`;
              break;
            }
          }
        } catch(e) {
          // It's HTML — parse search results page
          const body = suggestRes.body;
          // Look for result links in typical patterns
          const patterns = [
            /href="(https?:\/\/(?:www\.)?cifraclub\.com\.br\/[a-z0-9\-]+\/[a-z0-9\-]+\/)"/gi,
            /href="(\/[a-z0-9\-]{2,}\/[a-z0-9\-]{2,}\/)"/gi,
          ];
          for (const pattern of patterns) {
            const match = pattern.exec(body);
            if (match) {
              cifraUrl = match[1].startsWith("http")
                ? match[1]
                : `https://www.cifraclub.com.br${match[1]}`;
              break;
            }
          }
          if (cifraUrl) break;
        }
      }
    } catch(e) {
      console.log(`Suggest URL failed (${suggestUrl}):`, e.message);
    }
  }

  // Step 2: If no URL yet, try direct URL construction (works for known hinos)
  if (!cifraUrl) {
    // Build slug from query: "Alma Cansada" -> "alma-cansada"
    const slug = query.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
      .replace(/[^a-z0-9\s\-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim();
    // Try without artist first (Cifra Club sometimes has hinos without artist)
    cifraUrl = `https://www.cifraclub.com.br/${slug}/`;
    console.log("Trying direct URL:", cifraUrl);
  }

  // Step 3: Fetch the cifra page
  try {
    const cifraRes = await fetchUrl(cifraUrl);
    if (cifraRes.status === 200) {
      const content = extractCifraClubContent(cifraRes.body, cifraUrl);
      if (content && content.cifra.length > 50) return content;
    }
    console.log("Cifra page status:", cifraRes.status, "for URL:", cifraUrl);
  } catch(e) {
    console.log("Cifra page fetch failed:", e.message);
  }

  return null;
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

  const { query, source } = JSON.parse(body || "{}");
  if (!query) return res.status(400).json({ error: "Query obrigatória" });

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "API key não configurada" });
  }

  try {
    // 1. Try scraping Cifra Club (unless user forced IA-only)
    let cifraData = null;
    if (source !== "ia-only") {
      try {
        cifraData = await searchCifraClub(query);
      } catch (e) {
        console.log("Cifra Club scraping failed:", e.message);
      }
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
