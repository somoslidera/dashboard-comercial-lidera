// DIAGNÓSTICO TEMPORÁRIO (só-leitura) — inspeciona o Redis p/ investigar porMes vazio. REMOVER depois.
// Uso: /api/diag?token=SEGREDO
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
  if (!process.env.LF_WEBHOOK_SECRET || q.token !== process.env.LF_WEBHOOK_SECRET) {
    return res.status(401).json({ erro: 'token invalido' });
  }
  if (!R_URL || !R_TOKEN) return res.status(500).json({ erro: 'Redis nao configurado' });

  res.setHeader('Cache-Control', 'no-store');
  try {
    const dbsize = await redis(['DBSIZE']);
    const chaves = {
      'v:count:2026-07': await redis(['GET', 'v:count:2026-07']),
      'v:valor:2026-07': await redis(['GET', 'v:valor:2026-07']),
      'v:count:2026-08': await redis(['GET', 'v:count:2026-08']),
      'l:2026-07': await redis(['GET', 'l:2026-07']),
      'l:2026-08': await redis(['GET', 'l:2026-08']),
      'r:2026-08': await redis(['GET', 'r:2026-08']),
      'o:2026-08': await redis(['GET', 'o:2026-08'])
    };
    const sets = {
      'fxs:l:2026-08 (SCARD)': await redis(['SCARD', 'fxs:l:2026-08']),
      'fxs:sql:2026-08 (SCARD)': await redis(['SCARD', 'fxs:sql:2026-08'])
    };
    const scan = await redis(['SCAN', 0, 'COUNT', 200]);
    const amostra = Array.isArray(scan) ? (scan[1] || []).slice(0, 40) : scan;
    return res.status(200).json({ dbsize, chaves, sets, amostra_chaves: amostra });
  } catch (e) {
    return res.status(200).json({ erro_exec: String(e) });
  }
}
