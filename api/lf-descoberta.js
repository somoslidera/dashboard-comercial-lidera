// Utilitário de administração (temporário): lista funis do LeadForge e reseta os contadores.
export default async function handler(req, res) {
  const TOKEN = process.env.LF_DEBUG_TOKEN;
  if (!TOKEN || req.query.token !== TOKEN) return res.status(401).json({ erro: 'Passe ?token=SEU_TOKEN' });

  // ?reset=1  → apaga os contadores do ano (limpeza dos testes)
  if (req.query.reset === '1') {
    const R_URL = process.env.KV_REST_API_URL, R_TOKEN = process.env.KV_REST_API_TOKEN;
    const ano = new Date().getFullYear();
    const dels = [];
    for (let m = 1; m <= 12; m++) {
      const mes = `${ano}-${String(m).padStart(2, '0')}`;
      dels.push(`v:count:${mes}`, `v:valor:${mes}`, `r:${mes}`, `o:${mes}`, `n:${mes}`, `l:${mes}`, `proc:${mes}`);
    }
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['DEL', ...dels]) });
    const j = await r.json();
    return res.status(200).json({ reset: true, chaves_apagadas: j.result });
  }

  // padrão → lista os funis (id + nome) pra eu confirmar o mapeamento
  const KEY = process.env.LEADFORGE_API_KEY;
  const r = await fetch('https://api.leadforge.com.br/api/v1/funnels', { headers: { 'X-API-Key': KEY, Accept: 'application/json' } });
  const j = await r.json();
  const funis = (j.funnels || []).map(f => ({ id: f.id, name: f.name }));
  return res.status(200).json({ funis });
}
