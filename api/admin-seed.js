// TEMPORÁRIO — ajuste manual de contadores no Redis. Protegido pelo segredo do webhook.
// Uso: /api/admin-seed?token=SEGREDO&chave=d:2026-07&valor=19  → faz SET chave=valor
// REMOVER depois de usar.
const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const r = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await r.json()).result;
}

export default async function handler(req, res) {
  const q = req.query || {};
  if (!process.env.LF_WEBHOOK_SECRET || q.token !== process.env.LF_WEBHOOK_SECRET) {
    return res.status(401).json({ erro: 'token invalido' });
  }
  if (!q.chave || q.valor === undefined) {
    return res.status(400).json({ erro: 'use ?token=...&chave=d:2026-07&valor=19' });
  }
  await redis(['SET', q.chave, String(q.valor)]);
  const novo = await redis(['GET', q.chave]);
  return res.status(200).json({ ok: true, chave: q.chave, valor: novo });
}
