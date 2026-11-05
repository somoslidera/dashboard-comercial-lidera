// TEMPORÁRIO — descobre o id do funil de Gerentes. Remover depois de configurar F_GERENTES no lf-webhook.
// Mostra (1) a lista de funis da API do LeadForge, se ela tiver esse endpoint, e
// (2) os funis desconhecidos que já mandaram webhook (anotados em funis:vistos).
import { autorizado } from './_auth.js';

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  res.setHeader('Cache-Control', 'no-store');

  let vistos = {};
  try {
    const r = await fetch(process.env.KV_REST_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['HGETALL', 'funis:vistos'])
    });
    const h = (await r.json()).result || [];
    for (let i = 0; i < h.length; i += 2) { try { vistos[h[i]] = JSON.parse(h[i + 1]); } catch (e) { vistos[h[i]] = h[i + 1]; } }
  } catch (e) { vistos = { erro: String(e.message || e) }; }

  const api = {};
  const key = process.env.LEADFORGE_API_KEY;
  if (key) {
    for (const p of ['/funnels', '/pipelines', '/crm/funnels']) {
      try {
        const r = await fetch(`https://api.leadforge.com.br/api/v1${p}`, { headers: { 'X-API-Key': key } });
        const txt = await r.text();
        let j = null; try { j = JSON.parse(txt); } catch (e) { /* não é JSON */ }
        const lista = j && (Array.isArray(j) ? j : (j.funnels || j.pipelines || j.data));
        api[p] = { status: r.status, funis: Array.isArray(lista) ? lista.map((f) => ({ id: f.id, nome: f.name || f.title || f.nome })) : null };
      } catch (e) { api[p] = { erro: String(e.message || e) }; }
    }
  }
  return res.status(200).json({ api, vistos });
}
