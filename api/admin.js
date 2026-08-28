// Endpoint TEMPORÁRIO p/ corrigir contadores no Redis (Upstash REST). REMOVER após uso.
// Guardado por LF_WEBHOOK_SECRET. Uso: /api/admin?token=SEGREDO&cmd=SET&key=CHAVE&val=VALOR
const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const r = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  return j.result;
}

export default async function handler(req, res) {
  const q = req.query || {};
  if (!process.env.LF_WEBHOOK_SECRET || q.token !== process.env.LF_WEBHOOK_SECRET) return res.status(401).json({ erro: 'token invalido' });
  const cmd = (q.cmd || 'GET').toUpperCase();
  const OK = ['GET', 'SET', 'INCRBY', 'INCRBYFLOAT', 'DEL'];
  if (!OK.includes(cmd) || !q.key) return res.status(400).json({ erro: 'uso: ?token=&cmd=GET|SET|INCRBY|INCRBYFLOAT|DEL&key=&val=' });
  const args = [cmd, q.key];
  if (['SET', 'INCRBY', 'INCRBYFLOAT'].includes(cmd)) args.push(q.val);
  const result = await redis(args);
  const atual = await redis(['GET', q.key]);
  return res.status(200).json({ ok: true, cmd, key: q.key, result, valor_atual: atual });
}
