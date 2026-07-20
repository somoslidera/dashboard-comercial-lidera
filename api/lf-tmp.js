// TEMPORÁRIO: descobre a instância do posto (51 997708817) e ajusta contadores. Remover após usar.
export default async function handler(req, res) {
  const TOKEN = process.env.LF_DEBUG_TOKEN;
  if (!TOKEN || req.query.token !== TOKEN) return res.status(401).json({ erro: 'token' });
  const KEY = process.env.LEADFORGE_API_KEY;
  const R_URL = process.env.KV_REST_API_URL, R_TOKEN = process.env.KV_REST_API_TOKEN;
  const lf = async (p) => { try { const r = await fetch('https://api.leadforge.com.br/api/v1' + p, { headers: { 'X-API-Key': KEY, Accept: 'application/json' } }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); } return { status: r.status, json: j }; } catch (e) { return { status: 'err', json: String(e) }; } };

  // ?set=1&key=&val=  → ajusta um contador
  if (req.query.set) {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['SET', req.query.key, String(req.query.val)]) });
    return res.status(200).json({ set: { key: req.query.key, val: req.query.val }, result: (await r.json()).result });
  }

  // probe: tenta achar a lista de instâncias/conexões (com o número)
  const out = {};
  for (const p of ['/instances', '/connections', '/conexoes', '/whatsapp/instances', '/messaging/instances', '/instance', '/whatsapp/connections']) {
    out[p] = await lf(p);
  }
  // e mostra as instâncias que aparecem nos leads recentes (pra correlacionar)
  const leads = await lf('/leads/search?phone=55');
  out.instancias_nos_leads = [...new Set(((leads.json && leads.json.leads) || []).map(l => l.instance_id))];
  return res.status(200).json(out);
}
