export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.GROQ_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API key não configurada.' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query obrigatória.' });

  const prompt = `Você é um especialista em hinos e louvores gospel brasileiros, especialmente do repertório tradicional de igrejas evangélicas e pentecostais (hinários como Cantor Cristão, louvores como Alma Cansada, Trem das Doze, Vai Orando, Deus está Aqui, etc).

Retorne APENAS um JSON válido, sem texto antes ou depois, sem markdown, sem blocos de código. Formato exato:
{
  "found": true,
  "title": "Nome Completo do Louvor",
  "key": "G",
  "rhythm": "Valsa",
  "meta": "Hinário Cantor Cristão",
  "cifra": "texto da cifra com acordes em colchetes"
}

Na cifra: use [Acorde] antes da sílaba correspondente. Marque seções: "— Refrão —" ou "— Verso 1 —" em linhas próprias. Inclua letra completa.
Se não conhecer: {"found": false, "message": "Não encontrei este louvor"}
Ritmo deve ser um de: Valsa, Marcha, Hino 4/4, Baião, Bolero, Outro

Me dê a cifra completa do louvor: "${query}"`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Erro na API Groq' });
    }

    const raw = data.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); }
        catch (e2) { return res.status(500).json({ error: 'Formato de resposta inválido.' }); }
      } else {
        return res.status(500).json({ error: 'Não foi possível processar a resposta.' });
      }
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
