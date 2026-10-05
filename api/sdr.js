// Guia SDR: controle semanal (domingo a sábado) + plano do mês derivado da meta de faturamento.
// Endpoint isolado: não mexe no /api/dados (Comercial/Marketing).
// Lê tudo num ÚNICO MGET (dias das últimas N semanas + meses de base) p/ poupar o Redis.
import { autorizado } from './_auth.js';

const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;
const META_FATURAMENTO = 100000;          // mesma meta mensal do painel Comercial
const RASTREIO_DIARIO_INICIO = '2026-07-22';
const CAMPOS = ['l', 'd', 'o', 'n', 'r', 'v:count', 'v:valor'];   // leads, desq, agend, no-show, reuniões, vendas, R$

async function mget(keys) {
  const r = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['MGET', ...keys])
  });
  const j = await r.json();
  if (!Array.isArray(j.result)) throw new Error(j.error || 'redis sem resultado');
  return j.result;
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDias = (d, n) => new Date(d.getTime() + n * 86400000);
const num = (v) => parseFloat(v || 0) || 0;

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  if (!R_URL || !R_TOKEN) return res.status(500).json({ erro: 'Redis nao configurado' });

  const semanas = Math.min(16, Math.max(1, parseInt((req.query || {}).semanas, 10) || 8));

  // "hoje" no fuso do Brasil, como data pura (00:00 UTC do dia BR)
  const agora = new Date(Date.now() - 3 * 3600 * 1000);
  const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
  const inicioSemana = addDias(hoje, -hoje.getUTCDay());                 // domingo desta semana
  const inicio = addDias(inicioSemana, -7 * (semanas - 1));
  const dias = [];
  for (let i = 0; i < semanas * 7; i++) dias.push(addDias(inicio, i));

  // meses: 3 meses fechados (base das taxas) + o mês atual
  const mesStr = (k) => iso(new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - k, 1))).slice(0, 7);
  const mesesBase = [3, 2, 1].map(mesStr);
  const mesAtual = mesStr(0);

  const keys = [];
  dias.forEach((d) => CAMPOS.forEach((c) => keys.push(`${c}:${iso(d)}`)));
  [...mesesBase, mesAtual].forEach((m) => CAMPOS.forEach((c) => keys.push(`${c}:${m}`)));

  let r;
  try { r = await mget(keys); } catch (e) { return res.status(200).json({ erro: 'redis', detalhe: String(e) }); }

  const ler = (off) => ({
    leads: num(r[off]), desq: num(r[off + 1]), agend: num(r[off + 2]), noshow: num(r[off + 3]),
    reunioes: num(r[off + 4]), vendas: num(r[off + 5]), valor: num(r[off + 6])
  });

  const hojeStr = iso(hoje);
  const listaDias = dias.map((d, i) => {
    const data = iso(d);
    return { data, dow: d.getUTCDay(), futuro: data > hojeStr, semDado: data < RASTREIO_DIARIO_INICIO, ...ler(i * CAMPOS.length) };
  });

  const offMes = dias.length * CAMPOS.length;
  const base = mesesBase.map((m, i) => ({ mes: m, ...ler(offMes + i * CAMPOS.length) }));
  const atual = { mes: mesAtual, ...ler(offMes + mesesBase.length * CAMPOS.length) };

  // plano reverso: meta R$ → vendas → reuniões → agendamentos → leads, c/ as taxas reais dos 3 meses
  const s = base.reduce((a, m) => { Object.keys(a).forEach((k) => { a[k] += m[k]; }); return a; },
    { leads: 0, desq: 0, agend: 0, noshow: 0, reunioes: 0, vendas: 0, valor: 0 });
  const div = (a, b) => (b > 0 ? a / b : null);
  const taxas = {
    ticket: div(s.valor, s.vendas),               // R$ por venda
    fechamento: div(s.vendas, s.reunioes),        // reunião realizada → venda
    comparecimento: div(s.reunioes, s.agend),     // agendada → realizada
    agendamento: div(s.agend, s.leads)            // lead → agendamento
  };
  const sobe = (a, t) => (t ? Math.ceil(a / t) : null);
  const vendas = sobe(META_FATURAMENTO, taxas.ticket);
  const reunioes = vendas != null ? sobe(vendas, taxas.fechamento) : null;
  const agend = reunioes != null ? sobe(reunioes, taxas.comparecimento) : null;
  const leads = agend != null ? sobe(agend, taxas.agendamento) : null;

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
  return res.status(200).json({
    hoje: hojeStr,
    rastreioDiarioInicio: RASTREIO_DIARIO_INICIO,
    dias: listaDias,
    mesAtual: atual,
    plano: { metaFaturamento: META_FATURAMENTO, base: mesesBase, taxas, mensal: { vendas, reunioes, agend, leads } }
  });
}
