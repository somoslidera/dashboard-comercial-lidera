// Carteira de clientes × metas de faturamento do Flow (flow.somoslidera.com.br).
// Lê o banco do Flow (Supabase/Postgres) com um usuário SOMENTE LEITURA — env FLOW_DATABASE_URL.
// Mesma conta do Dashboard do Flow:
//   faturamento = soma dos lançamentos de RECEITA do mês (categorias[grupo].tipo === 'receita')
//   metas       = fin.metasFat[ano].meses['AAAA-MM'] = { minimo, realista, desafiador }
//   dias úteis  = fin.diasTrabalho (0=dom … 6=sáb; padrão seg–sáb), MENOS os feriados em que o restaurante fecha
//                 (fin.feriados, igual ao Flow desde 06/11/2026 — ver feriadosFechados)
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
  estrela: { nome: 'Meta', ordem: 2 },
  supernova: { nome: 'Super Meta', ordem: 3 }
};

const isoDia = (d) => d.toISOString().slice(0, 10);

// ── FERIADOS — cópia da regra do Flow (Parâmetros › Metas de faturamento) ──
// fin.feriados = { abre:false, extras:[{data,nome}], excecoes:{'AAAA-MM-DD':true|false}, ocultos:['AAAA-MM-DD'] }
// Nacionais (fixos + móveis pela Páscoa), menos os "ocultos", mais os "extras" (municipais etc.).
// Cada feriado abre ou fecha conforme `abre` (padrão: fecha), com exceção por data. Feriado FECHADO não é dia de funcionamento.
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(ano, mes - 1, dia, 12);
}
const FER_FIXOS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];
const FER_MOVEIS = [-48, -47, -2, 60];          // carnaval (seg e ter), sexta-feira santa, corpus christi
export function feriadosFechados(cfg, anos) {
  const f = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const ocultos = Array.isArray(f.ocultos) ? f.ocultos : [];
  const excecoes = f.excecoes && typeof f.excecoes === 'object' ? f.excecoes : {};
  const extras = Array.isArray(f.extras) ? f.extras : [];
  const fechados = new Set();
  for (const ano of anos) {
    const p = pascoa(ano);
    const nac = FER_FIXOS.map((md) => `${ano}-${md}`).concat(FER_MOVEIS.map((n) => isoDia(new Date(p + n * 86400000))))
      .filter((d) => !ocultos.includes(d));
    const ext = extras.map((x) => x && x.data).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && +d.slice(0, 4) === ano);
    for (const d of new Set(nac.concat(ext))) {
      const abre = d in excecoes ? !!excecoes[d] : !!f.abre;
      if (!abre) fechados.add(d);
    }
  }
  return fechados;
}

// dias de funcionamento entre duas datas: dia da semana marcado E não é feriado fechado
function diasTrabEntre(de, ate, ds, fer) {
  if (!de || !ate || ate < de) return 0;
  let n = 0;
  for (let d = new Date(de + 'T12:00:00Z'); isoDia(d) <= ate; d = new Date(d.getTime() + 86400000))
    if (ds.includes(d.getUTCDay()) && !(fer && fer.has(isoDia(d)))) n++;
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

// semana de compras: SÁBADO a SEXTA (pedido de 18/11/2026: o escritório não trabalha sáb/dom, então a
// semana fecha na sexta e a equipe já acompanha a semana nova na segunda). Base da meta = sáb–sex anterior.
export function semanas(hoje) {
  const d = new Date(hoje + 'T12:00:00Z');
  const sab = new Date(d.getTime() - ((d.getUTCDay() + 1) % 7) * 86400000);   // sáb=0, dom=1 … sex=6
  const mais = (x, n) => isoDia(new Date(x.getTime() + n * 86400000));
  return { ini: isoDia(sab), fim: mais(sab, 6), antIni: mais(sab, -7), antFim: mais(sab, -1) };
}

// CMV LANÇADO do mês = igual ao Flow (cmvLancPeriodo): lançamentos do grupo "CMV" ÷ receitas do mês.
// META DE COMPRA da semana = regra do comercial: vendido na semana anterior (sáb–sex) × CMV alvo.
//   Fica fixa a semana inteira (muda todo sábado). Comprado = lançamentos "CMV" de sábado até hoje.
export function comprasDoCliente(org, { mesIni, mesFim, hoje }) {
  const tipos = org.catTipos || {};
  const ls = org.lanc || [];
  const soma = (f) => ls.filter(f).reduce((s, l) => s + num(l.valor), 0);
  const entre = (l, a, b) => l.data >= a && l.data <= b;
  const ehCMV = (l) => l.grupo === 'CMV';
  const ehRec = (l) => tipos[l.grupo] === 'receita';

  const cmvMes = soma((l) => ehCMV(l) && entre(l, mesIni, mesFim));
  const recMes = soma((l) => ehRec(l) && entre(l, mesIni, mesFim));
  const alvo = num(org.cmvAlvo) > 0 ? num(org.cmvAlvo) : 30;            // padrão do Flow: 30%
  const S = semanas(hoje);
  const vendasBase = soma((l) => ehRec(l) && entre(l, S.antIni, S.antFim));
  const meta = vendasBase * alvo / 100;
  const comprado = soma((l) => ehCMV(l) && entre(l, S.ini, hoje < S.fim ? hoje : S.fim));
  const saldo = meta - comprado;
  const status = meta <= 0 ? (comprado > 0 ? 'semBase' : 'semDado')
    : comprado > meta ? 'estourou' : comprado >= meta * 0.85 ? 'limite' : 'dentro';
  return {
    alvo, cmvLancado: recMes > 0 && cmvMes > 0 ? cmvMes / recMes * 100 : null, cmvMesRS: cmvMes,
    vendasBase, meta, comprado, saldo, usoPct: meta > 0 ? comprado / meta * 100 : null, status
  };
}

// classifica UM cliente. org ={ id, nome, consultor, metas, diasTrab, catTipos, lanc, contasAbertas, meios, receitaBruta }
export function analisarCliente(org, { mes, hoje }) {
  const [y, m] = mes.split('-').map(Number);
  const ini = `${mes}-01`, fim = `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const ds = Array.isArray(org.diasTrab) && org.diasTrab.length ? org.diasTrab.map(Number) : DIAS_PADRAO;
  const fer = feriadosFechados(org.feriados, [y]);
  const tipos = org.catTipos || {};
  const receitas = (org.lanc || []).filter((l) => l.data >= ini && l.data <= fim && l.data <= hoje && tipos[l.grupo] === 'receita');
  const faturado = receitas.reduce((s, l) => s + num(l.valor), 0);
  const ultimo = receitas.reduce((u, l) => (l.data > u ? l.data : u), '');
  const mt = org.metas || {};
  const metas = { minimo: num(mt.minimo), realista: num(mt.realista), desafiador: num(mt.desafiador) };
  const temMeta = metas.minimo > 0 || metas.realista > 0 || metas.desafiador > 0;

  const diasMes = diasTrabEntre(ini, fim, ds, fer);
  const fechado = hoje > fim;
  const ateHoje = fechado ? fim : hoje;
  const ateLanc = ultimo || ini;
  const decorrHoje = diasTrabEntre(ini, ateHoje, ds, fer);
  const decorr = fechado ? diasMes : diasTrabEntre(ini, ateLanc, ds, fer);
  const ritmo = decorr > 0 ? faturado / decorr : 0;
  const projecao = fechado ? faturado : ritmo * diasMes;
  const atrasoDias = ultimo ? Math.max(0, decorrHoje - decorr) : null;   // dias de funcionamento sem receita lançada

  const base = {
    id: org.id, nome: org.nome || '—', consultor: org.consultor || null,
    faturado, projecao, ritmo, ultimoLancamento: ultimo || null, atrasoDias,
    diasMes, diasDecorridos: decorr, feriadosNoMes: [...fer].filter((d) => d >= ini && d <= fim && ds.includes(new Date(d + 'T12:00:00Z').getUTCDay())).sort(),
    metas, fechado,
    resultado: resultadoDoMes(org, ini, fim),
    compras: comprasDoCliente(org, { mesIni: ini, mesFim: fim, hoje })
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
  o.dados->'fin'->'feriados' as feriados,
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
      and c->>'vencimento' >= $5 and c->>'vencimento' <= $6
      and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(o.dados->'lancamentos') = 'array' then o.dados->'lancamentos' else '[]'::jsonb end) l2
                       where l2->>'fromConta' = c->>'id')) as contas_abertas,
  case when jsonb_typeof(o.dados->'fin'->'meios') = 'array' then o.dados->'fin'->'meios' end as meios,
  o.dados->'fin'->'receitaBruta' as receita_bruta,
  o.dados->'cmvAlvo' as cmv_alvo
from public.organizacoes o
left join public.perfis p on p.id = o.consultor_id
where coalesce(o.dados->>'_demo', 'false') not in ('true', '1')
  and coalesce(o.dados->>'_arquivado', 'false') not in ('true', '1')
  and coalesce(o.dados->>'_grupo', 'false') not in ('true', '1')`;

// ── clientes que estão no Flow mas não entram nesta tela (nem metas de vendas, nem compras da semana) ──
// Comparação pelo nome sem acento, maiúscula, espaço ou pontuação: "Panifício da XV" = "panificio da xv".
// Nome exato — "CD" não esconde "CD Centro". Para esconder mais um, é só acrescentar aqui.
const OCULTOS = ['Bar do Cris', 'CD', 'Panificio da XV', 'Panifico da XV', 'Arena', 'O Rustico', 'Restaurante Janeti'];
// e pelo código do restaurante no Flow, que não muda se o nome for editado
const OCULTOS_ID = new Set([
  '18886750-60f2-410d-bc7f-451a387e15a5'   // Panifico da XV
]);
const chaveNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const OCULTOS_SET = new Set(OCULTOS.map(chaveNome));
export const oculto = (nome, id) => OCULTOS_ID.has(String(id)) || OCULTOS_SET.has(chaveNome(nome));

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
    // lançamentos: o mês escolhido + a semana anterior à atual (base da meta de compra), que pode cair em outro mês
    const S = semanas(hoje);
    const jIni = [`${mes}-01`, S.antIni].sort()[0], jFim = [fim, S.fim].sort()[1];
    linhas = (await abrir().query(SQL, [mes.slice(0, 4), mes, jIni, jFim, `${mes}-01`, fim])).rows;
  } catch (e) {
    return res.status(200).json({ erro: 'flow_indisponivel', detalhe: String(e.message || e) });
  }

  const clientes = linhas.filter((r) => !oculto(r.nome, r.id)).map((r) => analisarCliente({
    id: r.id, nome: r.nome, consultor: r.consultor, metas: r.metas, diasTrab: r.dias_trab, feriados: r.feriados, catTipos: r.cat_tipos, lanc: r.lanc,
    contasAbertas: r.contas_abertas, meios: r.meios, receitaBruta: r.receita_bruta, cmvAlvo: r.cmv_alvo
  }, { mes, hoje }));

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
  const S = semanas(hoje);
  return res.status(200).json({ mes, hoje, semana: { ini: S.ini, fim: S.fim, baseIni: S.antIni, baseFim: S.antFim }, faixas: FAIXAS, clientes, atualizadoEm: new Date().toISOString() });
}
