const https = require("https");

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9",
        "Accept-Encoding": "identity",
        ...options.headers,
      },
      timeout: 12000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(loc, options).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function toSlug(text) {
  return text.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s\-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// ─── CIFRAS.COM.BR ────────────────────────────────────────────────────────────
async function searchCifras(query) {
  const encoded = encodeURIComponent(query);
  const searchUrl = `https://www.cifras.com.br/busca/?q=${encoded}`;
  const searchRes = await fetchUrl(searchUrl);
  if (searchRes.status !== 200) throw new Error("Cifras search failed: " + searchRes.status);

  const html = searchRes.body;

  // Extract first cifra result link like /cifra/artista/musica
  const linkMatch = html.match(/href="(\/cifra\/[a-z0-9\-]+\/[a-z0-9\-]+)"/i);
  if (!linkMatch) return null;

  const songUrl = `https://www.cifras.com.br${linkMatch[1]}`;
  const songRes = await fetchUrl(songUrl);
  if (songRes.status !== 200) throw new Error("Cifras song failed: " + songRes.status);

  const songHtml = songRes.body;

  // Extract title
  const titleMatch = songHtml.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : query;

  // Extract artist
  const artistMatch = songHtml.match(/<h2[^>]*>([^<]+)<\/h2>/i);
  const artist = artistMatch ? artistMatch[1].trim() : "";

  // Extract cifra content — cifras.com.br uses a div with id="cifra_cnt" or class cifra
  let cifraRaw = "";

  // Method 1: cifra_cnt div
  const cntMatch = songHtml.match(/id="cifra_cnt"[^>]*>([\s\S]*?)<\/div>/i)
    || songHtml.match(/class="[^"]*cifra[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (cntMatch) {
    cifraRaw = cntMatch[1]
      .replace(/<b>([^<]+)<\/b>/g, "[$1]")
      .replace(/<span[^>]*chord[^>]*>([^<]+)<\/span>/gi, "[$1]")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<p[^>]*>/gi, "\n").replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\n{3,}/g, "\n\n").trim();
  }

  // Method 2: pre tags
  if (!cifraRaw || cifraRaw.length < 50) {
    const preMatches = songHtml.match(/<pre[^>]*>([\s\S]*?)<\/pre>/gi) || [];
    if (preMatches.length) {
      cifraRaw = preMatches.map(block =>
        block
          .replace(/<b>([^<]+)<\/b>/g, "[$1]")
          .replace(/<span[^>]*>([^<]+)<\/span>/gi, "$1")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      ).join("\n\n").trim();
    }
  }

  if (!cifraRaw || cifraRaw.length < 50) return null;
  return { title, artist, cifra: cifraRaw, source: "cifras", url: songUrl };
}

// ─── VAGALUME ─────────────────────────────────────────────────────────────────
async function searchVagalume(query) {
  // Use the search API
  const encoded = encodeURIComponent(query);
  const apiKey = "timeoutLyrics";  // public key
  const searchUrl = `https://api.vagalume.com.br/search.php?q=${encoded}&limit=3`;

  const searchRes = await fetchUrl(searchUrl, { headers: { Accept: "application/json" } });
  if (searchRes.status !== 200) throw new Error("Vagalume search failed");

  let searchData;
  try { searchData = JSON.parse(searchRes.body); } catch { throw new Error("Vagalume parse error"); }

  const docs = searchData.response?.docs;
  if (!docs?.length) return null;

  const doc = docs[0];
  const songId = doc.id;
  const songName = doc.name;
  const artistName = doc.art?.name || "";
  const songUrl = doc.url || `https://www.vagalume.com.br/${toSlug(artistName)}/${toSlug(songName)}.html`;

  // Get full lyrics
  const lyricsUrl = `https://api.vagalume.com.br/search.php?musid=${songId}`;
  const lyricsRes = await fetchUrl(lyricsUrl, { headers: { Accept: "application/json" } });
  if (lyricsRes.status !== 200) throw new Error("Vagalume lyrics failed");

  const lyricsData = JSON.parse(lyricsRes.body);
  const lyrics = lyricsData.mus?.[0]?.text;
  if (!lyrics) return null;

  return { title: songName, artist: artistName, lyrics, source: "vagalume", url: songUrl };
}

// ─── GROQ — add chords to real lyrics ────────────────────────────────────────
async function addChordsWithGroq(songInfo) {
  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `Você é especialista em cifras de músicas gospel brasileiras.
Dado o título, artista e letra, adicione os ACORDES CORRETOS e REAIS da música.
FORMATO OBRIGATÓRIO:
- Primeira linha: "Título - Artista"
- Seções entre colchetes: [Intro], [Verso 1], [Refrão], [Ponte] etc
- Acordes ACIMA da letra correspondente, entre colchetes: [G] [Em] [C] [D]
- Inclua a letra COMPLETA
- Responda SOMENTE a cifra, sem explicações`
      },
      {
        role: "user",
        content: `Adicione os acordes corretos desta música:\n\nTítulo: ${songInfo.title}\nArtista: ${songInfo.artist}\n\nLETRA:\n${songInfo.lyrics.substring(0, 2500)}`
      }
    ],
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
      timeout: 20000,
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

// ─── GROQ — pure fallback ─────────────────────────────────────────────────────
async function groqFallback(query) {
  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `Você é especialista em cifras de músicas gospel e hinos brasileiros.
Se souber a cifra completa da música, forneça com letra e acordes.
Se NÃO souber com certeza, responda apenas: MÚSICA NÃO ENCONTRADA
NUNCA invente acordes ou letra.`
      },
      { role: "user", content: `Cifra completa de: "${query}"` }
    ],
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
      timeout: 20000,
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
    let result = null;
    let source = "ia";
    let url = null;

    // 1. Try cifras.com.br (has actual chords)
    try {
      const cifrasData = await searchCifras(query);
      if (cifrasData) {
        result = `${cifrasData.title} - ${cifrasData.artist}\n\n${cifrasData.cifra}`;
        source = "cifras";
        url = cifrasData.url;
        console.log("Found on cifras.com.br:", cifrasData.title);
      }
    } catch (e) { console.log("Cifras error:", e.message); }

    // 2. Try Vagalume (has lyrics) + Groq (adds chords)
    if (!result) {
      try {
        const vagalumeData = await searchVagalume(query);
        if (vagalumeData) {
          console.log("Found on Vagalume:", vagalumeData.title);
          const withChords = await addChordsWithGroq(vagalumeData);
          if (withChords && withChords.length > 50) {
            result = withChords;
            source = "vagalume";
            url = vagalumeData.url;
          }
        }
      } catch (e) { console.log("Vagalume error:", e.message); }
    }

    // 3. Pure Groq fallback
    if (!result) {
      const groqResult = await groqFallback(query);
      if (groqResult.includes("MÚSICA NÃO ENCONTRADA")) {
        result = `"${query}" não foi encontrada.\n\nUse "Digitar Manual" para inserir a cifra manualmente.`;
      } else {
        result = groqResult;
      }
      source = "ia";
    }

    return res.status(200).json({ result, source, url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
