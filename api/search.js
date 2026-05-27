/**
 * /api/search.js — Hinário Cifrado
 *
 * Estratégias em cascata (todas gratuitas):
 *   1. Cifras.com.br  — scraping com headers de browser
 *   2. CifraClub      — scraping com Referer do Google
 *   3. Groq compound-beta-mini — IA com busca web (free tier)
 *   4. Groq llama-3.3-70b     — fallback IA sem web
 */

const https = require("https");
const http  = require("http");

// ─── HTTP GET com redirect e headers de browser real ─────────
function httpGet(url, extraHeaders = {}, timeoutMs = 12000, depth = 0) {
  if (depth > 6) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        ...extraHeaders,
      },
      timeout: timeoutMs,
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return httpGet(next, extraHeaders, timeoutMs, depth + 1).then(resolve).catch(reject);
      }
      res.setEncoding("utf8");
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body, url }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ─── Extrai cifra de HTML (converte <b>C</b> → [C]) ──────────
function extractCifraFromHtml(html, query) {
  const preMatch = html.match(/<pre[^>]*?class="[^"]*?cifra[^"]*?"[^>]*?>([\s\S]*?)<\/pre>/i)
    || html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!preMatch) return null;

  const cifra = preMatch[1]
    .replace(/<b>([^<]+)<\/b>/g, "[$1]")
    .replace(/<[^>]+>/g, "")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\r\n/g, "\n").trim();

  return cifra.length >= 60 ? cifra : null;
}

// ─── Estratégia 1: Cifras.com.br ─────────────────────────────
async function scrapeCifrasDotComBr(query) {
  const searchUrl = "https://www.cifras.com.br/busca.php?search=" + encodeURIComponent(query);
  const sr = await httpGet(searchUrl, { "Referer": "https://www.google.com.br/" }, 10000);
  if (sr.status !== 200) throw new Error("cifras.com.br busca status " + sr.status);

  // Extrai link da primeira música (formato /cifra/artista/musica.html)
  const linkMatch = sr.body.match(/href="(\/cifra\/[^"]+\.html)"/i);
  if (!linkMatch) throw new Error("Sem resultados no cifras.com.br");

  const songUrl = "https://www.cifras.com.br" + linkMatch[1];
  const pr = await httpGet(songUrl, { "Referer": "https://www.cifras.com.br/" }, 12000);
  if (pr.status !== 200) throw new Error("cifras.com.br música status " + pr.status);

  const titleMatch = pr.body.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : query;

  const cifra = extractCifraFromHtml(pr.body, query);
  if (!cifra) throw new Error("Bloco de cifra não encontrado");

  return { text: title + "\n\n" + cifra, source: "cifraclub", url: songUrl };
}

// ─── Estratégia 2: CifraClub (com Referer do Google) ─────────
async function scrapeCifraClub(query) {
  const searchUrl = "https://www.cifraclub.com.br/busca/?q=" + encodeURIComponent(query) + "&tipo=musica";
  const sr = await httpGet(searchUrl, {
    "Referer": "https://www.google.com.br/search?q=" + encodeURIComponent(query + " cifra"),
    "Cookie": "",
  }, 10000);
  if (sr.status !== 200) throw new Error("CifraClub busca status " + sr.status);

  const linkPattern = /href="(\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/)"/gi;
  const skipList = ["/busca/","/ranking","/login","/cadastro","/top-cifras","/gospel","/sertanejo","/rock","/pop"];
  let songPath = null, m;
  while ((m = linkPattern.exec(sr.body)) !== null) {
    const p = m[1];
    if (!skipList.some(s => p.startsWith(s))) { songPath = p; break; }
  }
  if (!songPath) throw new Error("Nenhum resultado no CifraClub");

  const songUrl = "https://www.cifraclub.com.br" + songPath;
  const pr = await httpGet(songUrl, {
    "Referer": "https://www.cifraclub.com.br/busca/?q=" + encodeURIComponent(query),
  }, 12000);
  if (pr.status !== 200) throw new Error("CifraClub página status " + pr.status);

  const titleMatch = pr.body.match(/<h1[^>]*?class="[^"]*?t1[^"]*?"[^>]*?>([^<]+)<\/h1>/i)
    || pr.body.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const artistMatch = pr.body.match(/<h2[^>]*?class="[^"]*?t2[^"]*?"[^>]*?>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
  const title  = titleMatch  ? titleMatch[1].trim()  : query;
  const artist = artistMatch ? " - " + artistMatch[1].trim() : "";

  const cifra = extractCifraFromHtml(pr.body, query);
  if (!cifra) throw new Error("Bloco de cifra não encontrado no CifraClub");

  return { text: title + artist + "\n\n" + cifra, source: "cifraclub", url: songUrl };
}

// ─── Groq helper ──────────────────────────────────────────────
function callGroq(payload, timeoutMs = 25000) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.GROQ_API_KEY,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch { reject(new Error("JSON parse error")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Groq timeout")); });
    req.write(body); req.end();
  });
}

function groqText(json) {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content))
    return msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return "";
}

const SYS = `Especialista em cifras de músicas gospel e hinos brasileiros.
Busque na web a cifra REAL desta música no CifraClub ou Cifras.com.br.
Formato obrigatório — acordes sobre a letra:

Título - Artista

[Intro] [C] [G] [Am] [F]

[Verso 1]
[C]        [G]
Linha da letra
[Am]       [F]
Outra linha

Responda SOMENTE a cifra. Sem explicações.`;

// ─── Estratégia 3: Ultimate Guitar ───────────────────────────
async function scrapeUltimateGuitar(query) {
  const searchUrl = "https://www.ultimate-guitar.com/search.php?search_type=title&value=" + encodeURIComponent(query);
  const sr = await httpGet(searchUrl, {
    "Referer": "https://www.google.com/search?q=" + encodeURIComponent(query + " ultimate guitar chords"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  }, 12000);
  if (sr.status !== 200) throw new Error("UG busca status " + sr.status);

  // UG embeds data as JSON in a <div class="js-store" data-content="...">
  const storeMatch = sr.body.match(/class="js-store"[^>]*data-content="([^"]+)"/);
  if (!storeMatch) throw new Error("UG: js-store não encontrado");

  const json = JSON.parse(storeMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  const results = json?.store?.page?.data?.results;
  if (!results || !results.length) throw new Error("UG: sem resultados");

  // Find first chords tab (type=Chords preferred, fallback to any)
  const tab = results.find(r => r.type === "Chords") || results.find(r => r.tab_url) || results[0];
  if (!tab?.tab_url) throw new Error("UG: nenhuma aba encontrada");

  const pr = await httpGet(tab.tab_url, {
    "Referer": "https://www.ultimate-guitar.com/",
  }, 14000);
  if (pr.status !== 200) throw new Error("UG tab status " + pr.status);

  // Extract tab content from js-store on the tab page
  const tabStoreMatch = pr.body.match(/class="js-store"[^>]*data-content="([^"]+)"/);
  if (!tabStoreMatch) throw new Error("UG: js-store da aba não encontrado");

  const tabJson = JSON.parse(tabStoreMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  const tabContent = tabJson?.store?.page?.data?.tab_view?.wiki_tab?.content;
  if (!tabContent || tabContent.length < 60) throw new Error("UG: conteúdo vazio");

  // Convert UG format: [ch]C[/ch] → [C], [tab]...[/tab] → plain text
  const cifra = tabContent
    .replace(/\[ch\]([^\[]+)\[\/ch\]/g, "[$1]")
    .replace(/\[tab\]([\s\S]*?)\[\/tab\]/g, "$1")
    .replace(/\[verse[^\]]*\]/gi, "\n[Verso]\n")
    .replace(/\[chorus[^\]]*\]/gi, "\n[Refrão]\n")
    .replace(/\[bridge[^\]]*\]/gi, "\n[Ponte]\n")
    .replace(/\[intro[^\]]*\]/gi, "\n[Intro]\n")
    .replace(/\[[^\]]+\]/g, m => /^\[(C|D|E|F|G|A|B)[^\]]*\]$/.test(m) ? m : m)
    .replace(/\r\n/g, "\n").trim();

  const title = (tab.song_name || query) + (tab.artist_name ? " - " + tab.artist_name : "");
  return { text: title + "\n\n" + cifra, source: "ultimate-guitar", url: tab.tab_url };
}

// ─── Estratégia 4: Groq compound-beta-mini (free tier OK) ────
async function groqCompound(query, lyrics, title, artist) {
  let userMsg = lyrics && lyrics.length > 50
    ? `Música: "${title || query}"${artist ? " — " + artist : ""}\nLetra:\n${lyrics.slice(0,1800)}\n\nBusque os acordes REAIS e monte a cifra completa.`
    : `Cifra de: "${query}"`;

  const r = await callGroq({
    model: "compound-beta-mini",
    messages: [{ role: "system", content: SYS }, { role: "user", content: userMsg }],
    max_tokens: 2000,
    temperature: 0.1,
  }, 25000);

  if (r.status !== 200) throw new Error("Groq compound status " + r.status + ": " + JSON.stringify(r.json));
  const text = groqText(r.json);
  if (!text || text.length < 80) throw new Error("Resposta muito curta");
  return { text, source: "groq-web" };
}

// ─── Estratégia 5: Groq llama fallback ───────────────────────
async function groqLlama(query, lyrics, title, artist) {
  let userMsg = lyrics && lyrics.length > 50
    ? `Música: "${title || query}"${artist ? " — " + artist : ""}\nLetra já conhecida:\n${lyrics.slice(0,1500)}\n\nCrie a cifra completa com acordes gospel típicos no formato [Acorde] sobre a letra.`
    : `Cifra de: "${query}"`;

  const r = await callGroq({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: "Especialista em cifras gospel brasileiras. Responda SOMENTE a cifra com acordes [Acorde] e letra. Se não souber, responda: DESCONHECIDA" },
      { role: "user", content: userMsg },
    ],
    max_tokens: 2000,
    temperature: 0.15,
  }, 20000);

  const text = groqText(r.json);
  if (!text || text.includes("DESCONHECIDA") || text.length < 50) throw new Error("Não encontrado pelo llama");
  return { text, source: "groq-llama" };
}

// ─── Handler principal ────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let raw = "";
  await new Promise(r => { req.on("data", c => { raw += c; }); req.on("end", r); });
  const { query, lyrics, title, artist } = JSON.parse(raw || "{}");
  if (!query) return res.status(400).json({ error: "Query obrigatória" });

  const errors = [];

  // 1. Cifras.com.br
  try {
    const result = await scrapeCifrasDotComBr(query);
    console.log("[cifras.com.br] ok");
    return res.status(200).json(result);
  } catch(e) { console.warn("[cifras.com.br]", e.message); errors.push("cifras.com.br: " + e.message); }

  // 2. CifraClub
  try {
    const result = await scrapeCifraClub(query);
    console.log("[cifraclub] ok");
    return res.status(200).json(result);
  } catch(e) { console.warn("[cifraclub]", e.message); errors.push("cifraclub: " + e.message); }

  // 3. Ultimate Guitar
  try {
    const result = await scrapeUltimateGuitar(query);
    console.log("[ultimate-guitar] ok");
    return res.status(200).json(result);
  } catch(e) { console.warn("[ultimate-guitar]", e.message); errors.push("ultimate-guitar: " + e.message); }

  if (!process.env.GROQ_API_KEY) {
    return res.status(200).json({ text: `"${query}" não encontrada. GROQ_API_KEY ausente.`, source: "not_found" });
  }

  // 4. Groq compound-beta-mini
  try {
    const result = await groqCompound(query, lyrics, title, artist);
    console.log("[groq-compound] ok");
    return res.status(200).json(result);
  } catch(e) { console.warn("[groq-compound]", e.message); errors.push("compound: " + e.message); }

  // 5. Groq llama
  try {
    const result = await groqLlama(query, lyrics, title, artist);
    console.log("[groq-llama] ok");
    return res.status(200).json(result);
  } catch(e) { console.warn("[groq-llama]", e.message); errors.push("llama: " + e.message); }

  return res.status(200).json({
    text: `"${query}" não foi encontrada.\n\nUse "Digitar Manual" para inserir a cifra.\n(Erros: ${errors.join(" | ")})`,
    source: "not_found",
  });
};
