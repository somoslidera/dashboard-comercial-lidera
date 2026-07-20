// TEMPORÁRIO: descobre a instância do posto (via etapa LEADS POSTO DE SAÚDE) e ajusta contadores.
export default async function handler(req, res) {
  const TOKEN = process.env.LF_DEBUG_TOKEN;
  if (!TOKEN || req.query.token !== TOKEN) return res.status(401).json({ erro: 'token' });
  const KEY = process.env.LEADFORGE_API_KEY;
  const R_URL = process.env.KV_REST_API_URL, R_TOKEN = process.env.KV_REST_API_TOKEN;
  const lf = async (p) => { try { const r = await fetch('https://api.leadforge.com.br/api/v1' + p, { headers: { 'X-API-Key': KEY, Accept: 'application/json' } }); return await r.json(); } catch (e) { return { erro: String(e) }; } };

  if (req.query.set) {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['SET', req.query.key, String(req.query.val)]) });
    return res.status(200).json({ set: { key: req.query.key, val: req.query.val }, result: (await r.json()).result });
  }

  const POSTO_STAGE = 'a970d601-4faa-41ed-9099-5f20a792d3eb'; // etapa "LEADS POSTO DE SAÚDE"
  // junta vários leads (a busca é limitada a 20 por termo)
  const vistos = {};
  for (const q of ['phone=55', 'name=a', 'name=e', 'name=o', 'name=i', 'name=s', 'name=r', 'name=m', 'name=n', 'name=l']) {
    const r = await lf('/leads/search?' + q);
    ((r && r.leads) || []).forEach(l => { vistos[l.id] = l; });
  }
  const leadsArr = Object.values(vistos);
  const postoLeads = [];
  for (const l of leadsArr.slice(0, 70)) {
    const dr = await lf(`/deals/search?lead_id=${l.id}`);
    const deals = (dr && dr.deals) || [];
    if (deals.some(dd => dd.funnel_stage_id === POSTO_STAGE)) {
      postoLeads.push({ nome: l.full_name, phone: l.phone, instance_id: l.instance_id, source: l.source });
    }
  }
  return res.status(200).json({
    total_leads_analisados: leadsArr.length,
    leads_no_posto: postoLeads,
    instancia_do_posto: [...new Set(postoLeads.map(p => p.instance_id))]
  });
}
