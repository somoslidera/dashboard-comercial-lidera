// Admin TEMPORÁRIO: define/ajusta um contador do Redis. Remover após usar.
export default async function handler(req, res) {
  const TOKEN = process.env.LF_DEBUG_TOKEN;
  if (!TOKEN || req.query.token !== TOKEN) return res.status(401).json({ erro: 'token' });
  const { key, val } = req.query;
  if (!key || val === undefined) return res.status(400).json({ erro: 'use ?key=&val=' });
  const R_URL = process.env.KV_REST_API_URL, R_TOKEN = process.env.KV_REST_API_TOKEN;
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['SET', key, String(val)]) });
  return res.status(200).json({ set: { key, val }, result: (await r.json()).result });
}
