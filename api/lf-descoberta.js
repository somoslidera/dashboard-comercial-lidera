// Leitor de descoberta v3 — busca deals POR lead e testa paginação de leads.
export default async function handler(req, res) {
  const KEY = process.env.LEADFORGE_API_KEY;
  const TOKEN = process.env.LF_DEBUG_TOKEN;
  if (!KEY) return res.status(500).json({ erro: 'Falta LEADFORGE_API_KEY.' });
  if (!TOKEN || req.query.token !== TOKEN) return res.status(401).json({ erro: 'Passe ?token=SEU_TOKEN.' });

  const BASE = 'https://api.leadforge.com.br/api/v1';
  const H = { 'X-API-Key': KEY, 'Accept': 'application/json' };
  const call = async (path) => {
    try { const r = await fetch(BASE + path, { headers: H }); const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = t.slice(0,300); } return { status: r.status, json: j };
    } catch (e) { return { status: 'erro', json: String(e) }; }
  };

  const out = { base: BASE };

  // paginação de leads
  const l1 = await call('/leads/search?phone=55');
  const l200 = await call('/leads/search?phone=55&limit=200');
  const lp2 = await call('/leads/search?phone=55&page=2');
  out.leads = {
    padrao_total: l1.json && l1.json.total, padrao_n: (l1.json && l1.json.leads || []).length,
    limit200_total: l200.json && l200.json.total, limit200_n: (l200.json && l200.json.leads || []).length,
    page2_total: lp2.json && lp2.json.total, page2_n: (lp2.json && lp2.json.leads || []).length,
    campos: (l1.json && l1.json.leads && l1.json.leads[0]) ? Object.keys(l1.json.leads[0]) : null
  };

  // procura um deal em algum dos leads retornados
  const leadsArr = (l200.json && l200.json.leads) || (l1.json && l1.json.leads) || [];
  const tentativas = [];
  let dealAmostra = null, dealDe = null;
  for (const l of leadsArr.slice(0, 25)) {
    const dr = await call(`/deals/search?lead_id=${l.id}`);
    const arr = (dr.json && dr.json.deals) || [];
    tentativas.push({ lead: l.full_name, status: dr.status, total: dr.json && dr.json.total, n: arr.length });
    if (arr.length && !dealAmostra) { dealAmostra = arr[0]; dealDe = l.full_name; }
  }
  out.deal_tentativas = tentativas;
  out.deal_encontrado_em = dealDe;
  out.deal_campos = dealAmostra ? Object.keys(dealAmostra) : null;
  out.deal_amostra = dealAmostra;

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
