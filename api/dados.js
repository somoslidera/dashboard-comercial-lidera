// Lê os contadores do Redis e entrega no formato que o dashboard usa.
// Cache de ~55s: mesmo com a TV atualizando de minuto em minuto, o Redis é lido ~1x/min.

import { autorizado } from './_auth.js';

const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;
const META_PADRAO = 100000;
// Dados por dia começam a existir a partir daqui (antes disso só temos por mês).
const RASTREIO_DIARIO_INICIO = '2026-07-22';

// Faixas de valor (mesma ordem/códigos do webhook)
const FAIXAS = [
  { nome: 'Até 50k', cod: 'f1' },
  { nome: '50k - 80k', cod: 'f2' },
  { nome: '80k - 100k', cod: 'f3' },
  { nome: '100k - 150k', cod: 'f4' },
  { nome: '150k - 300k', cod: 'f5' },
  { nome: 'Acima 300k', cod: 'f6' }
];

async function pipeline(cmds) {
  const r = await fetch(`${R_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  const j = await r.json();
  return j.map((x) => x.result);
}

// funil segmentado por faixa de valor, de um mês "YYYY-MM"
async function porFaixaDoMes(mes) {
  const cmds = [];
  FAIXAS.forEach((f) => {
    cmds.push(['SCARD', `fx:l:${f.cod}:${mes}`]);
    cmds.push(['SCARD', `fx:d:${f.cod}:${mes}`]);
    cmds.push(['SCARD', `fx:sql:${f.cod}:${mes}`]);
    cmds.push(['SCARD', `fx:r:${f.cod}:${mes}`]);
    cmds.push(['SCARD', `fx:v:${f.cod}:${mes}`]);
    cmds.push(['GET', `fx:vv:${f.cod}:${mes}`]);
  });
  const r = await pipeline(cmds);
  const out = [];
  FAIXAS.forEach((f, i) => {
    const b = i * 6;
    const leads = parseInt(r[b] || 0, 10) || 0;
    const desq = parseInt(r[b + 1] || 0, 10) || 0;
    const sql = parseInt(r[b + 2] || 0, 10) || 0;
    const reunioes = parseInt(r[b + 3] || 0, 10) || 0;
    const vendas = parseInt(r[b + 4] || 0, 10) || 0;
    const faturamento = parseFloat(r[b + 5] || 0) || 0;
    out.push({ cod: f.cod, nome: f.nome, leads, mql: Math.max(0, leads - desq), sql, reunioes, vendas, faturamento });
  });
  return out;
}

// lista os dias "YYYY-MM-DD" de since até until (inclusive), com trava de segurança
function listarDias(since, until) {
  const dias = [];
  let cur = new Date(since + 'T00:00:00Z');
  const fim = new Date(until + 'T00:00:00Z');
  let guarda = 0;
  while (cur <= fim && guarda < 400) { dias.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); guarda++; }
  return dias;
}

// soma os contadores diários de um intervalo e devolve um período agregado
async function periodoPorDia(res, since, until) {
  const dias = listarDias(since, until);
  const cmds = [];
  dias.forEach((d) => {
    cmds.push(['GET', `v:count:${d}`]);
    cmds.push(['GET', `v:valor:${d}`]);
    cmds.push(['GET', `r:${d}`]);
    cmds.push(['GET', `o:${d}`]);
    cmds.push(['GET', `n:${d}`]);
    cmds.push(['GET', `l:${d}`]);
    cmds.push(['GET', `d:${d}`]);
  });
  const r = cmds.length ? await pipeline(cmds) : [];
  let vendas = 0, valor = 0, reunioes = 0, oport = 0, noshow = 0, leads = 0, desq = 0;
  for (let i = 0; i < dias.length; i++) {
    const b = i * 7;
    vendas += parseInt(r[b] || 0, 10) || 0;
    valor += parseFloat(r[b + 1] || 0) || 0;
    reunioes += parseInt(r[b + 2] || 0, 10) || 0;
    oport += parseInt(r[b + 3] || 0, 10) || 0;
    noshow += parseInt(r[b + 4] || 0, 10) || 0;
    leads += parseInt(r[b + 5] || 0, 10) || 0;
    desq += parseInt(r[b + 6] || 0, 10) || 0;
  }
  const periodo = {
    leads, desqualificados: desq, mql: Math.max(0, leads - desq),
    oportunidades: oport, sql: oport, reunioes, noshow,
    noShowPct: (reunioes + noshow) > 0 ? (noshow / (reunioes + noshow)) * 100 : null,
    vendas, valorVendas: valor,
    conversao: reunioes > 0 ? (vendas / reunioes) * 100 : null,
    meta: Math.round((dias.length / 30) * META_PADRAO) || META_PADRAO
  };
  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');
  return res.status(200).json({ periodo, since, until, dias: dias.length });
}

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  if (!R_URL || !R_TOKEN) return res.status(500).json({ erro: 'Redis nao configurado' });

  const q = req.query || {};
  // funil por faixa de um mês específico
  if (q.faixasMes) {
    res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');
    return res.status(200).json({ mes: q.faixasMes, porFaixa: await porFaixaDoMes(q.faixasMes) });
  }

  // período personalizado por DIA (a partir de RASTREIO_DIARIO_INICIO)
  if (q.since && q.until) return periodoPorDia(res, q.since, q.until);

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
        noshow,
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

  const mesAtualStr = `${ano}-${String(agoraBR.getUTCMonth() + 1).padStart(2, '0')}`;
  const porFaixa = await porFaixaDoMes(mesAtualStr).catch(() => []);

  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');
  return res.status(200).json({ porMes, idxAuto, series: { vendas: seriesVendas }, rastreioDiarioInicio: RASTREIO_DIARIO_INICIO, porFaixa });
}
