// Leitor de descoberta v2 — sonda várias formas de LISTAR deals e ver os campos (data/tags).
export default async function handler(req, res) {
  const KEY = process.env.LEADFORGE_API_KEY;
  const TOKEN = process.env.LF_DEBUG_TOKEN;
  if (!KEY) return res.status(500).json({ erro: 'Falta LEADFORGE_API_KEY no Vercel.' });
  if (!TOKEN || req.query.token !== TOKEN) return res.status(401).json({ erro: 'Passe ?token=SEU_TOKEN.' });

  const BASE = 'https://api.leadforge.com.br/api/v1';
  const H = { 'X-API-Key': KEY, 'Accept': 'application/json' };
  const call = async (path) => {
    try {
      const r = await fetch(BASE + path, { headers: H });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { status: r.status, json: j };
    } catch (e) { return { status: 'erro', json: String(e) }; }
  };
  const resumir = (r) => {
    const j = r.json || {};
    const arr = j.deals || j.leads || j.data || j.items || null;
    const first = Array.isArray(arr) && arr[0] ? arr[0] : null;
    return {
      status: r.status,
      total: j.total,
      retornados: Array.isArray(arr) ? arr.length : null,
      campos: first ? Object.keys(first) : null,
      amostra: first,
      corpo: (!arr && r.status !== 200) ? j : undefined
    };
  };

  const PRE = 'e72026a9-756b-4db0-ad9f-2aacc2a5a113'; // Pré Vendas
  const VEN = 'b765f6c0-49da-4ad1-9c78-447606006901'; // Vendas
  const GANHO = '8cb7b698-c8a2-4320-b638-d02e0779767e'; // etapa GANHO (Vendas)

  const sondas = {
    'deals_sem_nada':                 '/deals/search',
    'deals_funnel_vendas':            `/deals/search?funnel_id=${VEN}`,
    'deals_funnel_vendas_won':        `/deals/search?funnel_id=${VEN}&status=won`,
    'deals_status_won_sozinho':       '/deals/search?status=won',
    'deals_funnel_vendas_limit':      `/deals/search?funnel_id=${VEN}&limit=5`,
    'deals_funnel_vendas_page':       `/deals/search?funnel_id=${VEN}&page=1&per_page=5`,
    'deals_por_etapa_ganho':          `/deals/search?funnel_stage_id=${GANHO}`,
    'deals_stage_ganho2':             `/deals/search?stage_id=${GANHO}`,
    'deals_sem_search':               '/deals',
    'deals_funnel_pre':               `/deals/search?funnel_id=${PRE}`,
    'leads_por_telefone_parcial':     '/leads/search?phone=55',
    'leads_por_nome_parcial':         '/leads/search?name=a'
  };

  const out = { base: BASE, sondas: {} };
  for (const [nome, path] of Object.entries(sondas)) {
    out.sondas[nome] = { path, ...resumir(await call(path)) };
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
