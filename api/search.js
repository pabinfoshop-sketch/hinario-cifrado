/**
 * /api/search.js — Hinário Cifrado
 *
 * Estratégia única: Ultimate Guitar API JSON (sem scraping, sem IA)
 */

const https = require("https");

function httpsGet(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "UGT_ANDROID/4.10.11 (unknown Android SDK built for x86)",
        "X-UG-CLIENT-ID": "51515b27-c759-43cc-a36c-87c13b92e8ed",
        "Accept": "application/json",
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      // seguir redirect
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpsGet(res.headers.location, headers, timeoutMs).then(resolve).catch(reject);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ─── Ultimate Guitar: busca + extração de tab ─────────────────
async function searchUG(query) {
  // 1. Busca
  const searchUrl = "https://api.tabs.ultimate-guitar.com/api/v1/tab/search?q="
    + encodeURIComponent(query)
    + "&type%5B%5D=Chords&official=0&page=1&limit=10";

  const sr = await httpsGet(searchUrl, {}, 14000);
  if (sr.status !== 200) throw new Error("UG search status " + sr.status);

  let searchJson;
  try { searchJson = JSON.parse(sr.body); }
  catch { throw new Error("UG search: JSON inválido"); }

  const results = searchJson?.data?.tabs;
  if (!results || results.length === 0) throw new Error("UG: nenhum resultado para \"" + query + "\"");

  // Preferir "Chords", depois qualquer tipo
  const tab = results.find(t => t.type === "Chords") || results[0];
  if (!tab?.id) throw new Error("UG: tab sem ID");

  // 2. Busca conteúdo da tab
  const tabUrl = "https://api.tabs.ultimate-guitar.com/api/v1/tab/view?tab_id=" + tab.id;
  const pr = await httpsGet(tabUrl, {}, 15000);
  if (pr.status !== 200) throw new Error("UG tab view status " + pr.status);

  let tabJson;
  try { tabJson = JSON.parse(pr.body); }
  catch { throw new Error("UG tab: JSON inválido"); }

  const content = tabJson?.data?.tab_view?.wiki_tab?.content
    || tabJson?.data?.tab?.content;

  if (!content || content.length < 60) throw new Error("UG: conteúdo da tab vazio");

  // 3. Converte formato UG → cifra legível
  const cifra = content
    .replace(/\[ch\]([^\[]+)\[\/ch\]/g, "[$1]")          // [ch]C[/ch] → [C]
    .replace(/\[tab\]([\s\S]*?)\[\/tab\]/g, "$1")          // remove tags [tab]
    .replace(/\[Intro[^\]]*\]/gi, "\n[Intro]\n")
    .replace(/\[Verse[^\]]*\]/gi, "\n[Verso]\n")
    .replace(/\[Chorus[^\]]*\]/gi, "\n[Refrão]\n")
    .replace(/\[Bridge[^\]]*\]/gi, "\n[Ponte]\n")
    .replace(/\[Pre[^\]]*\]/gi, "\n[Pré-Refrão]\n")
    .replace(/\[Outro[^\]]*\]/gi, "\n[Final]\n")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const title = [tab.song_name, tab.artist_name].filter(Boolean).join(" - ");
  const url = tab.tab_url || ("https://www.ultimate-guitar.com/tab/" + tab.id);

  return { text: title + "\n\n" + cifra, source: "ultimate-guitar", url };
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

  let query;
  try { query = JSON.parse(raw || "{}").query; }
  catch { return res.status(400).json({ error: "JSON inválido" }); }

  if (!query) return res.status(400).json({ error: "Query obrigatória" });

  try {
    const result = await searchUG(query);
    console.log("[ultimate-guitar] ok:", query);
    return res.status(200).json(result);
  } catch (e) {
    console.warn("[ultimate-guitar] erro:", e.message);
    return res.status(200).json({
      text: `"${query}" não foi encontrada no Ultimate Guitar.\n\n(${e.message})\n\nUse "Digitar Manual" para inserir a cifra.`,
      source: "not_found",
    });
  }
};
