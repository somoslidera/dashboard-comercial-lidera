// Leitor de descoberta — mostra o FORMATO real dos dados do LeadForge,
// para montarmos a automação certa. Temporário (depois vira /api/dados).
// Segurança: a chave fica em variável de ambiente (cofre do Vercel), nunca no código.
export default async function handler(req, res) {
  const KEY = process.env.LEADFORGE_API_KEY;
  const TOKEN = process.env.LF_DEBUG_TOKEN;

  if (!KEY) return res.status(500).json({ erro: 'Falta a variável LEADFORGE_API_KEY no Vercel (Settings → Environment Variables).' });
  if (!TOKEN || req.query.token !== TOKEN) return res.status(401).json({ erro: 'Passe ?token=SEU_TOKEN (variável LF_DEBUG_TOKEN).' });

  const BASE = 'https://api.leadforge.com.br/api/v1';
  const H = { 'X-API-Key': KEY, 'Accept': 'application/json' };
  const call = async (path) => {
    try {
      const r = await fetch(BASE + path, { headers: H });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 400); }
      return { status: r.status, json: j };
    } catch (e) { return { status: 'erro', json: String(e) }; }
  };

  const out = { base: BASE };

  // 1) Lista de funis (id + nome) — pra achar "Pré Vendas" e "Vendas"
  const funnels = await call('/funnels');
  out.funnels = funnels;

  // 2) Por funil: tenta etapas + amostra de deals (won e open) para ver os CAMPOS reais
  out.porFunil = [];
  const lista = (funnels.json && funnels.json.funnels) || [];
  for (const f of lista) {
    // tenta descobrir o caminho das etapas (pode variar)
    let etapas = await call(`/funnels/${f.id}/stages`);
    if (etapas.status === 404) etapas = await call(`/funnels/${f.id}/etapas`);

    const won = await call(`/deals/search?funnel_id=${f.id}&status=won`);
    const open = await call(`/deals/search?funnel_id=${f.id}&status=open`);
    const amostra =
      (won.json && won.json.deals && won.json.deals[0]) ||
      (open.json && open.json.deals && open.json.deals[0]) || null;

    out.porFunil.push({
      funil: { id: f.id, name: f.name },
      etapas_status: etapas.status,
      etapas: etapas.json,
      won_total: won.json && won.json.total,
      won_retornados: won.json && won.json.deals && won.json.deals.length,
      open_total: open.json && open.json.total,
      campos_do_deal: amostra ? Object.keys(amostra) : null, // <-- aqui vejo se tem DATA e TAGS
      amostra_deal: amostra
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
