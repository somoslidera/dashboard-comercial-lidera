// Admin temporário: lista funis, reseta e "semeia" o histórico da planilha no Redis.
export default async function handler(req, res) {
  const TOKEN = process.env.LF_DEBUG_TOKEN;
  if (!TOKEN || req.query.token !== TOKEN) return res.status(401).json({ erro: 'Passe ?token=SEU_TOKEN' });
  const R_URL = process.env.KV_REST_API_URL, R_TOKEN = process.env.KV_REST_API_TOKEN;
  const redis = async (cmd) => (await (await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) })).json()).result;
  const pipe = async (cmds) => await (await fetch(`${R_URL}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) })).json();

  // ?reset=1 → apaga contadores do ano
  if (req.query.reset === '1') {
    const ano = new Date().getFullYear(), dels = [];
    for (let m = 1; m <= 12; m++) { const mes = `${ano}-${String(m).padStart(2, '0')}`; dels.push(`v:count:${mes}`, `v:valor:${mes}`, `r:${mes}`, `o:${mes}`, `n:${mes}`, `l:${mes}`, `proc:${mes}`); }
    return res.status(200).json({ reset: true, apagadas: await redis(['DEL', ...dels]) });
  }

  // ?seed=1 → planta o histórico da planilha (vendas, valor, reuniões, oportunidades, no-show). Leads NÃO é semeado.
  if (req.query.seed === '1') {
    const HIST = {
      '2026-05': { v: 3, valor: 47680, r: 14, o: 17, n: 3 },
      '2026-06': { v: 6, valor: 95680, r: 13, o: 23, n: 10 },
      '2026-07': { v: 4, valor: 83508, r: 10, o: 16, n: 6 }
    };
    const cmds = [];
    for (const [mes, x] of Object.entries(HIST)) {
      cmds.push(['SET', `v:count:${mes}`, String(x.v)]);
      cmds.push(['SET', `v:valor:${mes}`, String(x.valor)]);
      cmds.push(['SET', `r:${mes}`, String(x.r)]);
      cmds.push(['SET', `o:${mes}`, String(x.o)]);
      cmds.push(['SET', `n:${mes}`, String(x.n)]);
    }
    const r = await pipe(cmds);
    return res.status(200).json({ seed: true, meses: Object.keys(HIST), comandos: cmds.length, ok: Array.isArray(r) });
  }

  // padrão → lista funis
  const r = await fetch('https://api.leadforge.com.br/api/v1/funnels', { headers: { 'X-API-Key': process.env.LEADFORGE_API_KEY, Accept: 'application/json' } });
  const j = await r.json();
  return res.status(200).json({ funis: (j.funnels || []).map(f => ({ id: f.id, name: f.name })) });
}
