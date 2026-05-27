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

// ─── VAGALUME ────────────────────────────────────────────────────────────────
// Vagalume has a free API for lyrics search
async function searchVagalume(query) {
  const encoded = encodeURIComponent(query);

  // Step 1: search for the song
  const searchUrl = `https://api.vagalume.com.br/search.php?q=${encoded}&limit=1`;
  const searchRes = await fetchUrl(searchUrl, { headers: { Accept: "application/json" } });
  if (searchRes.status !== 200) throw new Error("Vagalume search failed: " + searchRes.status);

  const searchData = JSON.parse(searchRes.body);
  if (!searchData.response?.docs?.length) return null;

  const doc = searchData.response.docs[0];
  const songId = doc.id;
  const songName = doc.name;
  const artistName = doc.art?.name || "";

  // Step 2: get full lyrics
  const lyricsUrl = `https://api.vagalume.com.br/search.php?musid=${songId}&extra=rel`;
  const lyricsRes = await fetchUrl(lyricsUrl, { headers: { Accept: "application/json" } });
  if (lyricsRes.status !== 200) throw new Error("Vagalume lyrics failed");

  const lyricsData = JSON.parse(lyricsRes.body);
  const lyrics = lyricsData.mus?.[0]?.text;
  if (!lyrics) return null;

  return { title: songName, artist: artistName, lyrics, source: "vagalume" };
}

// ─── LETRAS.MUS.BR ───────────────────────────────────────────────────────────
async function searchLetras(query) {
  const encoded = encodeURIComponent(query);
  const searchUrl = `https://letras.mus.br/pesquisar/?q=${encoded}`;
  const searchRes = await fetchUrl(searchUrl);
  if (searchRes.status !== 200) throw new Error("Letras search failed: " + searchRes.status);

  // Extract first result link
  const html = searchRes.body;
  const linkMatch = html.match(/href="(\/[a-z0-9\-]+\/[a-z0-9\-]+\/)"/i);
  if (!linkMatch) return null;

  const songUrl = `https://letras.mus.br${linkMatch[1]}`;
  const songRes = await fetchUrl(songUrl);
  if (songRes.status !== 200) throw new Error("Letras song page failed");

  const songHtml = songRes.body;

  // Extract title
  const titleMatch = songHtml.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : query;

  // Extract artist
  const artistMatch = songHtml.match(/<h2[^>]*>([^<]+)<\/h2>/i);
  const artist = artistMatch ? artistMatch[1].trim() : "";

  // Extract lyrics from cnt-letra div
  const lyricsMatch = songHtml.match(/class="cnt-letra[^"]*"[^>]*>([\s\S]*?)<\/article>/i)
    || songHtml.match(/id="letra-cnt"[^>]*>([\s\S]*?)<\/div>/i);

  if (!lyricsMatch) return null;

  const lyrics = lyricsMatch[1]
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (lyrics.length < 50) return null;
  return { title, artist, lyrics, source: "letras", url: songUrl };
}

// ─── GROQ — generate chords for known lyrics ─────────────────────────────────
async function generateChordsWithGroq(songInfo) {
  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `Você é um especialista em cifras de músicas gospel e louvores brasileiros.
Dado o título, artista e letra de uma música, adicione os acordes corretos.
REGRAS:
- Acordes entre colchetes: [G] [Em] [C] [D] [Am] [F] [Bb] etc
- Acordes ficam NA LINHA ACIMA da sílaba correspondente da letra
- Identifique e rotule as seções: [Intro], [Verso 1], [Refrão], [Ponte] etc
- Use os acordes REAIS da música, não invente
- Responda SOMENTE com a cifra formatada, sem explicações`
      },
      {
        role: "user",
        content: `Adicione os acordes corretos nesta música:

Título: ${songInfo.title}
Artista: ${songInfo.artist}

LETRA:
${songInfo.lyrics.substring(0, 2500)}`
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
        try {
          const json = JSON.parse(data);
          resolve(json.choices?.[0]?.message?.content || "");
        } catch { reject(new Error("Groq parse error")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Groq timeout")); });
    req.write(body);
    req.end();
  });
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
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
    let songInfo = null;
    let sourceLabel = "ia";

    // 1. Try Vagalume first
    try {
      songInfo = await searchVagalume(query);
      if (songInfo) sourceLabel = "vagalume";
      console.log("Vagalume result:", songInfo ? songInfo.title : "null");
    } catch (e) {
      console.log("Vagalume error:", e.message);
    }

    // 2. Fallback to Letras.mus.br
    if (!songInfo) {
      try {
        songInfo = await searchLetras(query);
        if (songInfo) sourceLabel = "letras";
        console.log("Letras result:", songInfo ? songInfo.title : "null");
      } catch (e) {
        console.log("Letras error:", e.message);
      }
    }

    let result;

    if (songInfo) {
      // Found real lyrics — ask Groq to add chords
      result = await generateChordsWithGroq(songInfo);
      if (!result || result.length < 50) {
        // Groq failed to add chords — return lyrics only with placeholder chords
        result = `${songInfo.title} - ${songInfo.artist}\n\n[Acordes não disponíveis — letra encontrada em ${sourceLabel}]\n\n${songInfo.lyrics}`;
      }
    } else {
      // No lyrics found anywhere — pure IA fallback
      sourceLabel = "ia";
      const groqBody = JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `Você é um especialista em cifras de músicas gospel e louvores brasileiros. 
Se souber a cifra da música pedida, forneça completa com letra e acordes formatados.
Se NÃO souber com certeza, responda exatamente: MÚSICA NÃO ENCONTRADA
NUNCA invente acordes ou letra de músicas que não conhece.`
          },
          { role: "user", content: `Cifra completa de: "${query}"` }
        ],
        max_tokens: 3000,
        temperature: 0.1,
      });

      const fallbackResult = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "api.groq.com",
          path: "/openai/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Length": Buffer.byteLength(groqBody),
          },
          timeout: 20000,
        }, (r) => {
          let d = "";
          r.on("data", c => d += c);
          r.on("end", () => {
            try { resolve(JSON.parse(d).choices?.[0]?.message?.content || ""); }
            catch { reject(new Error("parse error")); }
          });
        });
        req2.on("error", reject);
        req2.on("timeout", () => { req2.destroy(); reject(new Error("timeout")); });
        req2.write(groqBody);
        req2.end();
      });

      if (fallbackResult.includes("MÚSICA NÃO ENCONTRADA")) {
        result = `"${query}" não foi encontrada.\n\nUse "Digitar Manual" para inserir a cifra manualmente.`;
      } else {
        result = fallbackResult;
      }
    }

    return res.status(200).json({ result, source: sourceLabel, url: songInfo?.url || null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
