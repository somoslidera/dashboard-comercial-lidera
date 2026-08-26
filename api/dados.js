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

// busca ao vivo a faixa atual de um lead na API do LeadForge (timing-proof)
async function faixaViaAPI(leadId) {
  const key = process.env.LEADFORGE_API_KEY;
  if (!leadId || !key) return null;
  try {
    const r = await fetch(`https://api.leadforge.com.br/api/v1/deals/search?lead_id=${leadId}`, { headers: { 'X-API-Key': key } });
    const j = await r.json();
    for (const d of (j && j.deals) || []) for (const t of (d.tags || [])) { const f = FAIXAS.find((x) => x.nome === (t.name || '').trim()); if (f) return f.cod; }
  } catch (e) { /* ignora */ }
  return null;
}

// funil por faixa de um mês "YYYY-MM".
// Guardamos só QUEM passou em cada etapa; a FAIXA é resolvida agora (leitura),
// olhando a tag ATUAL de cada lead (`banda:{lead_id}`) — então reflete sempre a tag de hoje.
async function porFaixaDoMes(mes) {
  const base = await pipeline([
    ['SMEMBERS', `fxs:l:${mes}`],
    ['SMEMBERS', `fxs:sql:${mes}`],
    ['SMEMBERS', `fxs:r:${mes}`],
    ['SMEMBERS', `fxs:d:${mes}`],
    ['HGETALL', `fxs:v:${mes}`]
  ]);
  const setL = base[0] || [], setSql = base[1] || [], setR = base[2] || [], setD = base[3] || [];
  const vRaw = base[4] || [];
  const vendaMap = {};
  if (Array.isArray(vRaw)) { for (let i = 0; i < vRaw.length; i += 2) vendaMap[vRaw[i]] = parseFloat(vRaw[i + 1]) || 0; }
  else Object.keys(vRaw).forEach((k) => { vendaMap[k] = parseFloat(vRaw[k]) || 0; });
  const setV = Object.keys(vendaMap);

  const ids = [...new Set([].concat(setL, setSql, setR, setD, setV))];
  const bandas = ids.length ? ((await pipeline([['MGET', ...ids.map((id) => `banda:${id}`)]]))[0] || []) : [];
  const faixaDe = {};
  ids.forEach((id, i) => { faixaDe[id] = bandas[i]; });

  // negociações ainda SEM faixa → resolve ao vivo (a tag pode ter entrado após a captura) e cacheia
  const semFaixa = ids.filter((id) => !faixaDe[id]).slice(0, 40);
  if (semFaixa.length) {
    const leads = (await pipeline([['MGET', ...semFaixa.map((id) => `dl:${id}`)]]))[0] || [];
    const resolvidos = await Promise.all(semFaixa.map(async (did, i) => {
      const lid = leads[i]; if (!lid) return null;
      const cod = await faixaViaAPI(lid); return cod ? { did, cod } : null;
    }));
    const sets = [];
    resolvidos.forEach((r) => { if (r) { faixaDe[r.did] = r.cod; sets.push(['SET', `banda:${r.did}`, r.cod]); } });
    if (sets.length) await pipeline(sets);
  }

  const acc = {};
  FAIXAS.forEach((f) => { acc[f.cod] = { cod: f.cod, nome: f.nome, leads: 0, desq: 0, sql: 0, reunioes: 0, vendas: 0, faturamento: 0 }; });
  const contar = (set, campo) => set.forEach((id) => { const c = faixaDe[id]; if (acc[c]) acc[c][campo]++; });
  contar(setL, 'leads'); contar(setSql, 'sql'); contar(setR, 'reunioes'); contar(setD, 'desq');
  setV.forEach((id) => { const c = faixaDe[id]; if (acc[c]) { acc[c].vendas++; acc[c].faturamento += vendaMap[id]; } });

  return FAIXAS.map((f) => { const a = acc[f.cod]; return { cod: a.cod, nome: a.nome, leads: a.leads, mql: Math.max(0, a.leads - a.desq), sql: a.sql, reunioes: a.reunioes, vendas: a.vendas, faturamento: a.faturamento }; });
}

// resolve o ads_id de um lead SEM depender do webhook (timing-proof):
// lead_id → negociações (o título tem o nome) → busca o lead por nome → custom_fields.ads_id.
async function adsIdViaLead(leadId) {
  const key = process.env.LEADFORGE_API_KEY;
  if (!leadId || !key) return null;
  const base = 'https://api.leadforge.com.br/api/v1';
  const H = { headers: { 'X-API-Key': key } };
  try {
    const rd = await fetch(`${base}/deals/search?lead_id=${leadId}`, H);
    const jd = await rd.json();
    let nome = '';
    for (const d of (jd && jd.deals) || []) {
      const t = (d.title || '').trim();
      if (t) { nome = t.includes(' - ') ? t.split(' - ').slice(1).join(' - ').trim() : t; break; }
    }
    if (!nome) return null;
    const rl = await fetch(`${base}/leads/search?name=${encodeURIComponent(nome)}`, H);
    const jl = await rl.json();
    const lead = ((jl && jl.leads) || []).find((l) => l.id === leadId);
    const v = lead && lead.custom_fields && lead.custom_fields.ads_id;
    return v ? String(v) : null;
  } catch (e) { return null; }
}

// funil por ANÚNCIO (ads_id) de um mês "YYYY-MM": mesmas etapas, agrupadas por ad:{deal.id}.
// O ads_id é o id do anúncio no Facebook (custom_fields.ads_id do lead, capturado no webhook).
// Devolve { [adsId]: { leads, mql, sql, reunioes, vendas, faturamento } }. Forward-only.
async function porAnuncioDoMes(mes) {
  const base = await pipeline([
    ['SMEMBERS', `fxs:l:${mes}`],
    ['SMEMBERS', `fxs:sql:${mes}`],
    ['SMEMBERS', `fxs:r:${mes}`],
    ['SMEMBERS', `fxs:d:${mes}`],
    ['HGETALL', `fxs:v:${mes}`]
  ]);
  const setL = base[0] || [], setSql = base[1] || [], setR = base[2] || [], setD = base[3] || [];
  const vRaw = base[4] || [];
  const vendaMap = {};
  if (Array.isArray(vRaw)) { for (let i = 0; i < vRaw.length; i += 2) vendaMap[vRaw[i]] = parseFloat(vRaw[i + 1]) || 0; }
  else Object.keys(vRaw).forEach((k) => { vendaMap[k] = parseFloat(vRaw[k]) || 0; });
  const setV = Object.keys(vendaMap);

  const ids = [...new Set([].concat(setL, setSql, setR, setD, setV))];
  if (!ids.length) return {};
  const ads = (await pipeline([['MGET', ...ids.map((id) => `ad:${id}`)]]))[0] || [];
  const adDe = {};
  ids.forEach((id, i) => { adDe[id] = ads[i]; });

  // negociações ainda SEM anúncio → resolve ao vivo via lead_id (dl) e cacheia.
  // '_' = tombstone (lead sem ads_id) com TTL 1h: não reconsulta a cada leitura, mas recupera ads_id tardio.
  // PRIORIDADE: agendamentos/reuniões/vendas/desq primeiro (são poucos e importantes), leads por último.
  const ordemResolver = [...new Set([].concat(setSql, setR, setV, setD, setL))];
  const semAd = ordemResolver.filter((id) => !adDe[id]).slice(0, 20);
  if (semAd.length) {
    const dls = (await pipeline([['MGET', ...semAd.map((id) => `dl:${id}`)]]))[0] || [];
    const sets = [];
    await Promise.all(semAd.map(async (id, i) => {
      const lid = dls[i]; if (!lid) return;
      const adsId = await adsIdViaLead(lid);
      adDe[id] = adsId || '_';
      sets.push(adsId ? ['SET', `ad:${id}`, adsId] : ['SET', `ad:${id}`, '_', 'EX', 3600]);
    }));
    if (sets.length) await pipeline(sets);
  }

  const real = (a) => a && a !== '_';
  const acc = {};
  const bucket = (a) => (acc[a] || (acc[a] = { leads: 0, desq: 0, sql: 0, reunioes: 0, vendas: 0, faturamento: 0 }));
  const contar = (set, campo) => set.forEach((id) => { const a = adDe[id]; if (real(a)) bucket(a)[campo]++; });
  contar(setL, 'leads'); contar(setSql, 'sql'); contar(setR, 'reunioes'); contar(setD, 'desq');
  setV.forEach((id) => { const a = adDe[id]; if (real(a)) { const b = bucket(a); b.vendas++; b.faturamento += vendaMap[id]; } });

  const out = {};
  Object.keys(acc).forEach((a) => { const x = acc[a]; out[a] = { leads: x.leads, mql: Math.max(0, x.leads - x.desq), sql: x.sql, reunioes: x.reunioes, vendas: x.vendas, faturamento: x.faturamento }; });
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
  const keys = [];
  dias.forEach((d) => {
    keys.push(`v:count:${d}`, `v:valor:${d}`, `r:${d}`, `o:${d}`, `n:${d}`, `l:${d}`, `d:${d}`);
  });
  const r = keys.length ? ((await pipeline([['MGET', ...keys]]))[0] || []) : [];
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

  // funil por anúncio (ads_id) de um mês específico
  if (q.anunciosMes) {
    res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');
    return res.status(200).json({ mes: q.anunciosMes, porAnuncio: await porAnuncioDoMes(q.anunciosMes) });
  }

  // período personalizado por DIA (a partir de RASTREIO_DIARIO_INICIO)
  if (q.since && q.until) return periodoPorDia(res, q.since, q.until);

  const agoraBR = new Date(Date.now() - 3 * 3600 * 1000); // fuso Brasil
  const ano = agoraBR.getUTCFullYear();

  // pede os 7 contadores dos 12 meses num ÚNICO comando (MGET = 1 requisição, não 84)
  const keys = [];
  for (let m = 1; m <= 12; m++) {
    const mes = `${ano}-${String(m).padStart(2, '0')}`;
    keys.push(`v:count:${mes}`, `v:valor:${mes}`, `r:${mes}`, `o:${mes}`, `n:${mes}`, `l:${mes}`, `d:${mes}`);
  }
  const r = (await pipeline([['MGET', ...keys]]))[0] || [];

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

  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');
  return res.status(200).json({ porMes, idxAuto, series: { vendas: seriesVendas }, rastreioDiarioInicio: RASTREIO_DIARIO_INICIO });
}
