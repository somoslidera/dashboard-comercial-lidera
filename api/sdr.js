// Guia SDR: controle semanal (domingo a sábado) + plano do mês derivado da meta de faturamento.
// Endpoint isolado: não mexe no /api/dados (Comercial/Marketing).
// Lê tudo num ÚNICO MGET (dias da tabela + semana atual + meses) p/ poupar o Redis.
//   /api/sdr            → últimas 8 semanas
//   /api/sdr?mes=AAAA-MM → semanas (dom–sáb) que encostam no mês; dias fora do mês vêm com noMes=false
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
const domingo = (d) => addDias(d, -d.getUTCDay());
const intervalo = (ini, fim) => { const out = []; for (let d = ini; d <= fim; d = addDias(d, 1)) out.push(d); return out; };

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  if (!R_URL || !R_TOKEN) return res.status(500).json({ erro: 'Redis nao configurado' });

  const q = req.query || {};
  const mesFiltro = /^\d{4}-\d{2}$/.test(q.mes || '') ? q.mes : null;

  // "hoje" no fuso do Brasil, como data pura (00:00 UTC do dia BR)
  const agora = new Date(Date.now() - 3 * 3600 * 1000);
  const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
  const inicioSemana = domingo(hoje);
  const semanaAtual = intervalo(inicioSemana, addDias(inicioSemana, 6));

  // dias da tabela
  let diasTabela;
  if (mesFiltro) {
    const [y, m] = mesFiltro.split('-').map(Number);
    const primeiro = new Date(Date.UTC(y, m - 1, 1)), ultimo = new Date(Date.UTC(y, m, 0));
    diasTabela = intervalo(domingo(primeiro), addDias(domingo(ultimo), 6));
  } else {
    diasTabela = intervalo(addDias(inicioSemana, -7 * 7), addDias(inicioSemana, 6));   // 8 semanas
  }

  // meses: 3 meses fechados (base das taxas), o mês de referência (filtrado ou atual)
  const mesStr = (k) => iso(new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - k, 1))).slice(0, 7);
  const mesesBase = [3, 2, 1].map(mesStr);
  const mesRef = mesFiltro || mesStr(0);

  // um único MGET com tudo (dias sem repetir)
  const diasUnicos = [...new Set([...diasTabela, ...semanaAtual].map(iso))];
  const keys = [];
  diasUnicos.forEach((d) => CAMPOS.forEach((c) => keys.push(`${c}:${d}`)));
  [...mesesBase, mesRef].forEach((m) => CAMPOS.forEach((c) => keys.push(`${c}:${m}`)));

  let r;
  try { r = await mget(keys); } catch (e) { return res.status(200).json({ erro: 'redis', detalhe: String(e) }); }

  const ler = (off) => ({
    leads: num(r[off]), desq: num(r[off + 1]), agend: num(r[off + 2]), noshow: num(r[off + 3]),
    reunioes: num(r[off + 4]), vendas: num(r[off + 5]), valor: num(r[off + 6])
  });
  const porDia = {};
  diasUnicos.forEach((d, i) => { porDia[d] = ler(i * CAMPOS.length); });

  const hojeStr = iso(hoje);
  const dia = (d) => {
    const data = iso(d);
    return {
      data, dow: d.getUTCDay(), futuro: data > hojeStr, semDado: data < RASTREIO_DIARIO_INICIO,
      noMes: !mesFiltro || data.slice(0, 7) === mesFiltro, ...porDia[data]
    };
  };

  const offMes = diasUnicos.length * CAMPOS.length;
  const base = mesesBase.map((m, i) => ({ mes: m, ...ler(offMes + i * CAMPOS.length) }));
  const ref = { mes: mesRef, ...ler(offMes + mesesBase.length * CAMPOS.length) };

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
    filtroMes: mesFiltro,
    dias: diasTabela.map(dia),
    semanaAtual: semanaAtual.map(dia),
    mesRef: ref,
    plano: { metaFaturamento: META_FATURAMENTO, base: mesesBase, taxas, mensal: { vendas, reunioes, agend, leads } }
  });
}
