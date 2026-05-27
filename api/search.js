/**
 * /api/search.js — Hinário Cifrado
 *
 * Estratégias em cascata:
 *   1. Scraping direto do Cifra Club   → acordes reais, 100% gratuito
 *   2. Groq compound-beta (web search) → IA com busca real na web
 *   3. Groq llama-3.3-70b-versatile    → fallback sem web search
 */

const https = require("https");
const http  = require("http");

// ─────────────────────────────────────────────────────────────
// Utilitário HTTP — GET com redirect, timeout e User-Agent
// ─────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 12000, depth = 0) {
  if (depth > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
          "Accept-Encoding": "identity", // evita gzip — mais simples de processar
          "Cache-Control": "no-cache",
          Connection: "close",
        },
        timeout: timeoutMs,
      },
      (res) => {
        // Segue redirects
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          res.resume(); // descarta o body
          return httpGet(next, timeoutMs, depth + 1).then(resolve).catch(reject);
        }
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, body, finalUrl: url }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Estratégia 1 — Scraping do Cifra Club
// ─────────────────────────────────────────────────────────────
async function scrapeCifraClub(query) {
  // 1a. Busca no Cifra Club
  const searchUrl =
    "https://www.cifraclub.com.br/busca/?q=" +
    encodeURIComponent(query) +
    "&tipo=musica";

  const sr = await httpGet(searchUrl, 10000);
  if (sr.status !== 200) throw new Error(`Busca status ${sr.status}`);

  // 1b. Extrai o primeiro link de música (formato /artista/musica/)
  //     Os links de música têm exatamente 2 segmentos de path, sem subpáginas.
  const linkPattern = /href="(\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/)"/gi;
  let songPath = null;

  // Filtra apenas links dentro da área de resultados
  // (evita links de nav que também têm 2 segmentos)
  const resultsBlock =
    sr.body.match(/class="[^"]*list-musics[^"]*"[\s\S]*?<\/ul>/i)?.[0] ||
    sr.body.match(/class="[^"]*gs-result[^"]*"[\s\S]*?<\/div>/i)?.[0] ||
    sr.body; // fallback: tenta o body todo

  let m;
  while ((m = linkPattern.exec(resultsBlock)) !== null) {
    const path = m[1];
    // Exclui paths comuns de navegação
    if (
      !path.startsWith("/busca/") &&
      !path.startsWith("/cifra-de-") &&
      !path.includes("login") &&
      !path.includes("cadastro") &&
      !path.includes("ranking")
    ) {
      songPath = path;
      break;
    }
  }

  if (!songPath) throw new Error("Nenhum resultado no Cifra Club");

  // 1c. Busca a página da música
  const songUrl = "https://www.cifraclub.com.br" + songPath;
  const pr = await httpGet(songUrl, 12000);
  if (pr.status !== 200) throw new Error(`Página da música status ${pr.status}`);

  // 1d. Extrai título e artista
  const titleMatch =
    pr.body.match(/<h1[^>]*?class="[^"]*?t1[^"]*?"[^>]*?>([^<]+)<\/h1>/i) ||
    pr.body.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const artistMatch =
    pr.body.match(/<h2[^>]*?class="[^"]*?t2[^"]*?"[^>]*?>\s*<a[^>]*>([^<]+)<\/a>/i) ||
    pr.body.match(/<h2[^>]*>([^<]+)<\/h2>/i);

  const title  = titleMatch  ? titleMatch[1].trim()  : query;
  const artist = artistMatch ? artistMatch[1].trim()  : "";

  // 1e. Extrai o bloco de cifra  <pre class="cifra_cnt">…</pre>
  const preMatch = pr.body.match(
    /<pre[^>]*?class="[^"]*?cifra_cnt[^"]*?"[^>]*?>([\s\S]*?)<\/pre>/i
  );
  if (!preMatch) throw new Error("Bloco de cifra não encontrado");

  // 1f. Converte HTML do Cifra Club → formato [Acorde]
  const cifra = preMatch[1]
    .replace(/<b>([^<]+)<\/b>/g, "[$1]")   // <b>C</b>  →  [C]
    .replace(/<[^>]+>/g, "")               // remove demais tags HTML
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\r\n/g, "\n")
    .trim();

  if (cifra.length < 60) throw new Error("Cifra extraída muito curta");

  const header = artist ? `${title} - ${artist}` : title;
  return { text: `${header}\n\n${cifra}`, source: "cifraclub", url: songUrl };
}

// ─────────────────────────────────────────────────────────────
// Groq — chamada genérica
// ─────────────────────────────────────────────────────────────
function callGroq(payload, timeoutMs = 28000) {
  const body = JSON.stringify(payload);
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
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
          catch { reject(new Error("JSON parse error")); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Groq timeout")); });
    req.write(body);
    req.end();
  });
}

function groqText(json) {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content))
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return "";
}

// ─────────────────────────────────────────────────────────────
// Estratégias 2 e 3 — Groq
// ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é especialista em cifras de músicas gospel e hinos brasileiros.
Use a busca na web para encontrar a cifra REAL da música no Cifra Club ou Cifras.com.br.

FORMATO OBRIGATÓRIO (nunca omita acordes):
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

Responda SOMENTE a cifra completa com todos os acordes e a letra. Sem explicações.`;

async function groqWithWebSearch(query, lyrics, title, artist) {
  let userMsg;
  if (lyrics && lyrics.length > 50) {
    userMsg =
      `Música: "${title || query}"${artist ? ` — ${artist}` : ""}\n\n` +
      `A letra já foi encontrada:\n${lyrics.substring(0, 2000)}\n\n` +
      `Agora busque os ACORDES REAIS desta música no Cifra Club e monte a cifra completa.`;
  } else {
    userMsg = `Cifra completa de: "${query}"`;
  }

  const r = await callGroq({
    model: "compound-beta",        // versão completa — mais capaz que mini
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userMsg },
    ],
    max_tokens: 3000,
    temperature: 0.1,
  }, 28000);

  if (r.status !== 200) throw new Error(`Groq status ${r.status}`);
  const text = groqText(r.json);
  if (!text || text.length < 80) throw new Error("Resposta muito curta");
  return { text, source: "groq-web" };
}

async function groqLlamaFallback(query) {
  const r = await callGroq({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content:
          "Especialista em cifras gospel brasileiras. " +
          "Se souber a cifra REAL e COMPLETA, forneça com letra e acordes [Acorde]. " +
          "Caso contrário, responda apenas: MÚSICA NÃO ENCONTRADA",
      },
      { role: "user", content: `Cifra de: "${query}"` },
    ],
    max_tokens: 3000,
    temperature: 0.1,
  }, 20000);

  const text = groqText(r.json);
  if (!text || text.includes("MÚSICA NÃO ENCONTRADA") || text.length < 50)
    throw new Error("Não encontrado pelo llama");
  return { text, source: "groq-llama" };
}

// ─────────────────────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  let rawBody = "";
  await new Promise((r) => { req.on("data", (c) => { rawBody += c; }); req.on("end", r); });

  const { query, lyrics, title, artist } = JSON.parse(rawBody || "{}");
  if (!query) return res.status(400).json({ error: "Query obrigatória" });

  const errors = [];

  // ── 1. Cifra Club (scraping direto) ──────────────────────
  try {
    const result = await scrapeCifraClub(query);
    console.log(`[cifraclub] ok — ${result.text.length} chars — ${result.url}`);
    return res.status(200).json(result);
  } catch (e) {
    console.warn("[cifraclub] falhou:", e.message);
    errors.push("cifraclub: " + e.message);
  }

  // A partir daqui precisamos da chave Groq
  if (!process.env.GROQ_API_KEY) {
    return res.status(200).json({
      text: `"${query}" não encontrada (Cifra Club falhou e GROQ_API_KEY não configurada).`,
      source: "not_found",
    });
  }

  // ── 2. Groq compound-beta com busca web ──────────────────
  try {
    const result = await groqWithWebSearch(query, lyrics, title, artist);
    console.log(`[groq-web] ok — ${result.text.length} chars`);
    return res.status(200).json(result);
  } catch (e) {
    console.warn("[groq-web] falhou:", e.message);
    errors.push("groq-web: " + e.message);
  }

  // ── 3. Groq llama fallback ───────────────────────────────
  try {
    const result = await groqLlamaFallback(query);
    console.log(`[groq-llama] ok — ${result.text.length} chars`);
    return res.status(200).json(result);
  } catch (e) {
    console.warn("[groq-llama] falhou:", e.message);
    errors.push("groq-llama: " + e.message);
  }

  // ── Tudo falhou ──────────────────────────────────────────
  return res.status(200).json({
    text:
      `"${query}" não foi encontrada.\n\n` +
      `Use "Digitar Manual" para inserir a cifra manualmente.\n` +
      `(Erros internos: ${errors.join(" | ")})`,
    source: "not_found",
  });
};
