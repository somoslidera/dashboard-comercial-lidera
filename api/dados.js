// Lê os contadores do Redis e entrega no formato que o dashboard usa.
// Cache de ~55s: mesmo com a TV atualizando de minuto em minuto, o Redis é lido ~1x/min.

const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;
const META_PADRAO = 100000;

async function pipeline(cmds) {
  const r = await fetch(`${R_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  const j = await r.json();
  return j.map((x) => x.result);
}

export default async function handler(req, res) {
  if (!R_URL || !R_TOKEN) return res.status(500).json({ erro: 'Redis nao configurado' });

  const agoraBR = new Date(Date.now() - 3 * 3600 * 1000); // fuso Brasil
  const ano = agoraBR.getUTCFullYear();

  // pede os 6 contadores dos 12 meses do ano de uma vez só
  const cmds = [];
  for (let m = 1; m <= 12; m++) {
    const mes = `${ano}-${String(m).padStart(2, '0')}`;
    cmds.push(['GET', `v:count:${mes}`]);
    cmds.push(['GET', `v:valor:${mes}`]);
    cmds.push(['GET', `r:${mes}`]);
    cmds.push(['GET', `o:${mes}`]);
    cmds.push(['GET', `n:${mes}`]);
    cmds.push(['GET', `l:${mes}`]);
    cmds.push(['GET', `d:${mes}`]);
  }
  const r = await pipeline(cmds);

  const CAMPOS = 7; // v:count, v:valor, r, o, n, l, d
  const porMes = {};
  const seriesVendas = [];
  for (let m = 0; m < 12; m++) {
    const b = m * CAMPOS;
    const vendas   = parseInt(r[b] || 0, 10) || 0;
    const valor    = parseFloat(r[b + 1] || 0) || 0;
    const reunioes = parseInt(r[b + 2] || 0, 10) || 0;
    const oport    = parseInt(r[b + 3] || 0, 10) || 0;
    const noshow   = parseInt(r[b + 4] || 0, 10) || 0;
    const leads    = parseInt(r[b + 5] || 0, 10) || 0;
    const desq     = parseInt(r[b + 6] || 0, 10) || 0;

    // MQL = todo lead que entrou menos os desqualificados (LEAD DESQUALIFICADO / PERDA SDR)
    const mql = Math.max(0, leads - desq);

    seriesVendas.push(vendas || null);

    if (vendas || valor || reunioes || oport || noshow || leads) {
      porMes[m] = {
        leads,
        desqualificados: desq,
        mql,
        oportunidades: oport,
        sql: oport, // SQL = leads que chegaram no agendamento (N2)
        reunioes,
        noShowPct: (reunioes + noshow) > 0 ? (noshow / (reunioes + noshow)) * 100 : null,
        vendas,
        valorVendas: valor,
        conversao: reunioes > 0 ? (vendas / reunioes) * 100 : null,
        meta: META_PADRAO
      };
    }
  }

  let idxAuto = agoraBR.getUTCMonth();
  while (idxAuto > 0 && !porMes[idxAuto]) idxAuto--;
  if (!porMes[idxAuto]) {
    const chaves = Object.keys(porMes).map(Number);
    idxAuto = chaves.length ? Math.max(...chaves) : agoraBR.getUTCMonth();
  }

  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');
  return res.status(200).json({ porMes, idxAuto, series: { vendas: seriesVendas } });
}
