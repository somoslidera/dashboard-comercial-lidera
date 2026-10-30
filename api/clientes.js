// Carteira de clientes × metas de faturamento do Flow (flow.somoslidera.com.br).
// Lê o banco do Flow (Supabase/Postgres) com um usuário SOMENTE LEITURA — env FLOW_DATABASE_URL.
// Mesma conta do Dashboard do Flow:
//   faturamento = soma dos lançamentos de RECEITA do mês (categorias[grupo].tipo === 'receita')
//   metas       = fin.metasFat[ano].meses['AAAA-MM'] = { minimo, realista, desafiador }
//   dias úteis  = fin.diasTrabalho (0=dom … 6=sáb; padrão seg–sáb)
//   projeção    = faturamento ÷ dias de funcionamento decorridos × dias de funcionamento do mês
// Diferença deliberada: os "dias decorridos" contam até o ÚLTIMO lançamento de receita (não até hoje),
// p/ que lançamento atrasado não derrube a projeção e jogue o cliente em "crítico" sem motivo.
//   /api/clientes            → mês atual
//   /api/clientes?mes=AAAA-MM → outro mês (mês fechado: projeção = faturado)
import pg from 'pg';
import { autorizado } from './_auth.js';

const DIAS_PADRAO = [1, 2, 3, 4, 5, 6];

// nomes e ordem das faixas (troque aqui p/ renomear na tela inteira)
export const FAIXAS = {
  critico: { nome: 'Crítico', ordem: 0 },
  atencao: { nome: 'Atenção', ordem: 1 },
  estrela: { nome: 'Estrela', ordem: 2 },
  supernova: { nome: 'Supernova', ordem: 3 }
};

const isoDia = (d) => d.toISOString().slice(0, 10);
function diasTrabEntre(de, ate, ds) {
  if (!de || !ate || ate < de) return 0;
  let n = 0;
  for (let d = new Date(de + 'T12:00:00Z'); isoDia(d) <= ate; d = new Date(d.getTime() + 86400000)) if (ds.includes(d.getUTCDay())) n++;
  return n;
}
const num = (v) => { const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : +v; return isFinite(n) ? n : 0; };

// RESULTADO do mês = mesma conta do Dashboard do Flow (dashCentros):
//   receitas − despesas lançadas − contas a pagar em aberto que vencem no mês − taxas de recebimento.
// Período = o mês inteiro, como o Flow (inclui conta que ainda vai vencer no mês).
export function resultadoDoMes(org, ini, fim) {
  const tipos = org.catTipos || {};
  const ehReceita = (g) => tipos[g] === 'receita';                 // categoria desconhecida = despesa (como o Flow)
  const ls = (org.lanc || []).filter((l) => l.data >= ini && l.data <= fim);
  const rec = ls.filter((l) => ehReceita(l.grupo)).reduce((s, l) => s + num(l.valor), 0);
  const despLanc = ls.filter((l) => !ehReceita(l.grupo)).reduce((s, l) => s + num(l.valor), 0);
  const contas = (org.contasAbertas || []).filter((c) => !ehReceita(c.grupo)).reduce((s, c) => s + num(c.valor), 0);
  let taxas = 0;
  if (org.receitaBruta !== false) {                                // padrão do Flow: receita lançada é bruta
    const meios = (org.meios || []).filter((m) => m && m.id);
    const nm = (x) => String(x || '').trim().toLowerCase();
    ls.filter((l) => ehReceita(l.grupo)).forEach((l) => {
      const m = (l.meioId && meios.find((x) => x.id === l.meioId)) || meios.find((x) => [nm(l.sub), nm(l.forma)].filter(Boolean).includes(nm(x.nome)));
      const pct = Math.max(0, num(m && m.taxa));
      if (pct > 0) taxas += num(l.valor) * pct / 100;
    });
  }
  const despesas = despLanc + contas + taxas;
  const valor = rec - despesas;
  return { receitas: rec, despesas, valor, pct: rec > 0 ? valor / rec * 100 : null, temLancamento: ls.length > 0 || contas > 0 };
}

// classifica UM cliente. org = { id, nome, consultor, metas, diasTrab, catTipos, lanc, contasAbertas, meios, receitaBruta }
export function analisarCliente(org, { mes, hoje }) {
  const [y, m] = mes.split('-').map(Number);
  const ini = `${mes}-01`, fim = `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const ds = Array.isArray(org.diasTrab) && org.diasTrab.length ? org.diasTrab.map(Number) : DIAS_PADRAO;
  const tipos = org.catTipos || {};
  const receitas = (org.lanc || []).filter((l) => l.data >= ini && l.data <= fim && l.data <= hoje && tipos[l.grupo] === 'receita');
  const faturado = receitas.reduce((s, l) => s + num(l.valor), 0);
  const ultimo = receitas.reduce((u, l) => (l.data > u ? l.data : u), '');
  const mt = org.metas || {};
  const metas = { minimo: num(mt.minimo), realista: num(mt.realista), desafiador: num(mt.desafiador) };
  const temMeta = metas.minimo > 0 || metas.realista > 0 || metas.desafiador > 0;

  const diasMes = diasTrabEntre(ini, fim, ds);
  const fechado = hoje > fim;
  const ateHoje = fechado ? fim : hoje;
  const ateLanc = ultimo || ini;
  const decorrHoje = diasTrabEntre(ini, ateHoje, ds);
  const decorr = fechado ? diasMes : diasTrabEntre(ini, ateLanc, ds);
  const ritmo = decorr > 0 ? faturado / decorr : 0;
  const projecao = fechado ? faturado : ritmo * diasMes;
  const atrasoDias = ultimo ? Math.max(0, decorrHoje - decorr) : null;   // dias de funcionamento sem receita lançada

  const base = {
    id: org.id, nome: org.nome || '—', consultor: org.consultor || null,
    faturado, projecao, ritmo, ultimoLancamento: ultimo || null, atrasoDias,
    diasMes, diasDecorridos: decorr, metas, fechado,
    resultado: resultadoDoMes(org, ini, fim)
  };
  if (!temMeta) return { ...base, faixa: 'semMeta' };
  if (!receitas.length) return { ...base, faixa: 'semLancamento' };

  let faixa;
  if (metas.desafiador > 0 && projecao >= metas.desafiador) faixa = 'supernova';
  else if (metas.realista > 0 && projecao >= metas.realista) faixa = 'estrela';
  else if (metas.minimo > 0 && projecao >= metas.minimo) faixa = 'atencao';
  else if (metas.minimo > 0) faixa = 'critico';
  // sem mínima cadastrada: mesma régua de cor do Flow (vermelho abaixo de 70% da realista)
  else faixa = metas.realista > 0 && projecao >= metas.realista * 0.7 ? 'atencao' : 'critico';

  // próximo degrau: quanto falta por dia de funcionamento restante
  const minimoEfetivo = metas.minimo > 0 ? metas.minimo : metas.realista * 0.7;
  const proxima = faixa === 'critico' ? minimoEfetivo : faixa === 'atencao' ? metas.realista : faixa === 'estrela' ? metas.desafiador : 0;
  const restantes = fechado ? 0 : Math.max(0, diasMes - decorrHoje);
  const faltaPorDia = proxima > faturado && restantes > 0 ? (proxima - faturado) / restantes : null;
  return {
    ...base, faixa, faltaPorDia, proximaMeta: proxima || null, diasRestantes: restantes, semMinima: !(metas.minimo > 0),
    inicioDoMes: !fechado && decorr < 3
  };
}

// ── leitura do banco do Flow (só os campos necessários, já filtrados no SQL) ──
const SQL = `
select o.id, o.nome, p.nome as consultor,
  o.dados->'fin'->'metasFat'->$1::text->'meses'->$2::text as metas,
  o.dados->'fin'->'diasTrabalho' as dias_trab,
  case when jsonb_typeof(o.dados->'categorias') = 'object'
    then (select jsonb_object_agg(k, v->'tipo') from jsonb_each(o.dados->'categorias') c(k, v)) end as cat_tipos,
  (select coalesce(jsonb_agg(jsonb_build_object('data', l->>'data', 'grupo', l->>'grupo', 'valor', l->'valor',
          'sub', l->>'sub', 'forma', l->>'forma', 'meioId', l->>'meioId')), '[]'::jsonb)
     from jsonb_array_elements(case when jsonb_typeof(o.dados->'lancamentos') = 'array' then o.dados->'lancamentos' else '[]'::jsonb end) l
    where l->>'data' >= $3 and l->>'data' <= $4) as lanc,
  -- contas a pagar em aberto que vencem no mês e ainda não viraram lançamento (contasAbertas do Flow)
  (select coalesce(jsonb_agg(jsonb_build_object('grupo', c->>'grupo', 'valor', c->'valor')), '[]'::jsonb)
     from jsonb_array_elements(case when jsonb_typeof(o.dados->'fin'->'contasPagar') = 'array' then o.dados->'fin'->'contasPagar' else '[]'::jsonb end) c
    where coalesce(c->>'pago', 'false') not in ('true', '1')
      and c->>'vencimento' >= $3 and c->>'vencimento' <= $4
      and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(o.dados->'lancamentos') = 'array' then o.dados->'lancamentos' else '[]'::jsonb end) l2
                       where l2->>'fromConta' = c->>'id')) as contas_abertas,
  case when jsonb_typeof(o.dados->'fin'->'meios') = 'array' then o.dados->'fin'->'meios' end as meios,
  o.dados->'fin'->'receitaBruta' as receita_bruta
from public.organizacoes o
left join public.perfis p on p.id = o.consultor_id
where coalesce(o.dados->>'_demo', 'false') not in ('true', '1')
  and coalesce(o.dados->>'_arquivado', 'false') not in ('true', '1')
  and coalesce(o.dados->>'_grupo', 'false') not in ('true', '1')`;

let pool = null;
function abrir() {
  if (!pool) pool = new pg.Pool({ connectionString: process.env.FLOW_DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  return pool;
}

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  if (!process.env.FLOW_DATABASE_URL) return res.status(200).json({ erro: 'sem_acesso_flow' });

  const agora = new Date(Date.now() - 3 * 3600 * 1000);          // Brasília
  const hoje = isoDia(agora);
  const q = req.query || {};
  const mes = /^\d{4}-\d{2}$/.test(q.mes || '') ? q.mes : hoje.slice(0, 7);
  const [y, m] = mes.split('-').map(Number);
  const fim = `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;

  let linhas;
  try {
    linhas = (await abrir().query(SQL, [mes.slice(0, 4), mes, `${mes}-01`, fim])).rows;
  } catch (e) {
    return res.status(200).json({ erro: 'flow_indisponivel', detalhe: String(e.message || e) });
  }

  const clientes = linhas.map((r) => analisarCliente({
    id: r.id, nome: r.nome, consultor: r.consultor, metas: r.metas, diasTrab: r.dias_trab, catTipos: r.cat_tipos, lanc: r.lanc,
    contasAbertas: r.contas_abertas, meios: r.meios, receitaBruta: r.receita_bruta
  }, { mes, hoje }));

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
  return res.status(200).json({ mes, hoje, faixas: FAIXAS, clientes, atualizadoEm: new Date().toISOString() });
}
