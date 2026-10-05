// Agenda comercial (Google Agenda "PLL | Comercial") lida pelo link iCal SECRETO — sem OAuth.
// Usada só pela guia SDR. Env: GCAL_COMERCIAL_ICS (endereço secreto no formato iCal).
//   /api/agenda?ini=AAAA-MM-DD&fim=AAAA-MM-DD
// Devolve, por semana (domingo), quantas 1ªs reuniões foram MARCADAS e pra quando (mesma semana/próxima/depois),
// e o mapa de no-show por dia da semana × turno (no-shows do LeadForge casados com o evento da agenda).
import { autorizado } from './_auth.js';

const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;
const ICS_URL = process.env.GCAL_COMERCIAL_ICS;
const BR = 3 * 3600 * 1000;                       // Brasília = UTC-3 (sem horário de verão)
const DIA = 86400000;

// datas do iCal → "horário de Brasília guardado como UTC" (mesma convenção do /api/sdr)
function icsData(v, params) {
  if (/VALUE=DATE(?![-\w])/i.test(params) || /^\d{8}$/.test(v)) return null;   // dia inteiro: ignora
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7] === 'Z') t -= BR;                      // UTC → Brasília; com TZID=America/Sao_Paulo já é local
  return t;
}
const desescapa = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function lerIcs(txt) {
  const linhas = txt.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);   // "desdobra" linhas longas
  const evs = []; let cur = null;
  for (const l of linhas) {
    if (l === 'BEGIN:VEVENT') { cur = { emails: [] }; continue; }
    if (l === 'END:VEVENT') { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = l.indexOf(':'); if (i < 0) continue;
    const [nome, ...ps] = l.slice(0, i).split(';');
    const p = ps.join(';'), val = l.slice(i + 1);
    if (nome === 'SUMMARY') cur.titulo = desescapa(val);
    else if (nome === 'DTSTART') cur.inicio = icsData(val, p);
    else if (nome === 'CREATED') cur.criado = icsData(val, p);
    else if (nome === 'STATUS') cur.status = val.trim().toUpperCase();
    else if (nome === 'UID') cur.uid = val.trim();
    else if (nome === 'RECURRENCE-ID') cur.rec = val.trim();
    else if (nome === 'ATTENDEE') { const m = val.match(/mailto:(.+)$/i); if (m) cur.emails.push(m[1].trim().toLowerCase()); }
  }
  return evs;
}

// "PLL Sandra - Lanchonete" / "R2 - PLL Guilherme - Excelência" → reunião comercial
const RE_REUNIAO = /^\s*(R(\d+)\s*-\s*)?PLL\b\s*(.*)$/i;
const interno = (e) => /somoslidera\.com\.br$|calendar\.google\.com$/.test(e);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const primeiroNome = (s) => norm(s).split(/\s+/)[0] || '';

function reunioesDaAgenda(txt) {
  const vistos = new Set();
  return lerIcs(txt).map((e) => {
    const m = (e.titulo || '').match(RE_REUNIAO);
    if (!m || !e.inicio || e.status === 'CANCELLED') return null;
    const k = (e.uid || '') + '|' + (e.rec || '');
    if (vistos.has(k)) return null; vistos.add(k);
    const resto = m[3] || '';
    return {
      inicio: e.inicio, criado: e.criado || null,
      retorno: !!m[1],                                   // R2, R3… (não é 1ª reunião)
      nome: primeiroNome(resto.split(' - ')[0]),
      emails: e.emails.filter((x) => !interno(x))
    };
  }).filter(Boolean);
}

const domingo = (t) => { const d = new Date(t); const z = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); return z - new Date(z).getUTCDay() * DIA; };
const isoDia = (t) => new Date(t).toISOString().slice(0, 10);
const turno = (t) => { const h = new Date(t).getUTCHours(); return h < 12 ? 'manha' : h < 18 ? 'tarde' : 'noite'; };

async function redisPipe(cmds) {
  const r = await fetch(`${R_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  return (await r.json()).map((x) => x.result);
}

// nome/e-mail ATUAIS do lead (o nome pode ter sido corrigido depois do no-show) — busca pelo telefone
async function leadAtual(rec) {
  const key = process.env.LEADFORGE_API_KEY;
  if (!key || !rec.fone) return null;
  try {
    const r = await fetch(`https://api.leadforge.com.br/api/v1/leads/search?phone=${encodeURIComponent(rec.fone)}`, { headers: { 'X-API-Key': key } });
    if (!r.ok) return null;
    const ls = ((await r.json()) || {}).leads || [];
    return ls.find((l) => l.id === rec.lead) || ls[0] || null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  if (!ICS_URL) return res.status(200).json({ erro: 'sem_agenda' });

  const q = req.query || {};
  const okData = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (!okData(q.ini) || !okData(q.fim)) return res.status(400).json({ erro: 'use ?ini=AAAA-MM-DD&fim=AAAA-MM-DD' });
  const ini = Date.parse(q.ini + 'T00:00:00Z'), fim = Date.parse(q.fim + 'T00:00:00Z') + DIA;   // [ini, fim)

  let reunioes;
  try {
    const r = await fetch(ICS_URL);
    if (!r.ok) return res.status(200).json({ erro: 'agenda_inacessivel', detalhe: 'HTTP ' + r.status });
    reunioes = reunioesDaAgenda(await r.text());
  } catch (e) { return res.status(200).json({ erro: 'agenda_inacessivel', detalhe: String(e) }); }

  const agora = Date.now() - BR;
  const primeiras = reunioes.filter((e) => !e.retorno);

  // ── por semana: marcadas na semana (pela data de criação do evento) e pra quando
  const semanas = {};
  const sem = (t) => (semanas[isoDia(domingo(t))] || (semanas[isoDia(domingo(t))] = { marcadas: 0, mesma: 0, proxima: 0, depois: 0, acontecem: 0, retornos: 0 }));
  for (let w = domingo(ini); w < fim; w += 7 * DIA) sem(w);
  for (const e of primeiras) {
    if (e.criado != null && e.criado >= domingo(ini) && e.criado < fim) {
      const s = sem(e.criado), dif = Math.round((domingo(e.inicio) - domingo(e.criado)) / (7 * DIA));
      s.marcadas++;
      if (dif <= 0) s.mesma++; else if (dif === 1) s.proxima++; else s.depois++;
    }
    if (e.inicio >= domingo(ini) && e.inicio < fim) sem(e.inicio).acontecem++;
  }
  reunioes.filter((e) => e.retorno && e.inicio >= domingo(ini) && e.inicio < fim).forEach((e) => { sem(e.inicio).retornos++; });

  // ── por DIA: 1ªs reuniões que estavam marcadas p/ aquele dia e cujo horário já passou
  // (base do no-show "pela agenda": marcadas p/ acontecer − realizadas). Remarcada sai do dia antigo; cancelada não entra.
  const porDia = {};
  primeiras.filter((e) => e.inicio >= ini && e.inicio < fim && e.inicio < agora)
    .forEach((e) => { const k = isoDia(e.inicio); porDia[k] = (porDia[k] || 0) + 1; });

  // ── no-show por TURNO (manhã/tarde/noite) — a partir do 1º registro de reunião REALIZADA (rl:{mes}).
  // Antes disso o LeadForge só guardou QUANTAS foram realizadas por dia, não QUAL; aí não dá p/ saber o turno.
  // Cada realizada é casada com o evento da agenda (e-mail do convidado > nome ATUAL do lead > nome gravado).
  // As que sobram sem casar são as faltas — limitadas, por dia, a (marcadas − realizadas) p/ bater com a tabela.
  const meses = [];
  for (let d = new Date(Date.UTC(new Date(ini).getUTCFullYear(), new Date(ini).getUTCMonth(), 1)); d.getTime() < fim; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) meses.push(d.toISOString().slice(0, 7));
  let registros = [];
  if (R_URL && R_TOKEN && meses.length) {
    try {
      const listas = await redisPipe(meses.map((m) => ['LRANGE', `rl:${m}`, 0, -1]));
      registros = listas.flat().filter(Boolean).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } })
        .filter(Boolean).map((r) => ({ ...r, tt: Date.parse(r.t) - BR })).filter((r) => r.tt >= ini - 2 * DIA && r.tt < fim + DIA);
    } catch (e) { /* sem registros */ }
  }
  const slots = {};
  const chave = (t) => new Date(t).getUTCDay() + '-' + turno(t);
  const slot = (t) => (slots[chave(t)] || (slots[chave(t)] = { reunioes: 0, faltas: 0 }));
  let turnoDesde = null, casadas = 0;
  if (registros.length) {
    const d0 = Math.min(...registros.map((r) => r.tt));
    turnoDesde = Date.UTC(new Date(d0).getUTCFullYear(), new Date(d0).getUTCMonth(), new Date(d0).getUTCDate());
    const evs = primeiras.filter((e) => e.inicio >= Math.max(ini, turnoDesde) && e.inicio < fim && e.inicio < agora);
    const atuais = await Promise.all(registros.map((r) => leadAtual(r)));   // nome/e-mail de HOJE (o nome pode ter mudado)
    const realizado = new Set(), rPorDia = {};
    registros.slice().sort((a, b) => a.tt - b.tt).forEach((rec) => {
      const i = registros.indexOf(rec), atual = atuais[i];
      const dk = isoDia(rec.tt); rPorDia[dk] = (rPorDia[dk] || 0) + 1;
      const email = norm((atual && atual.email) || rec.email);
      const nomes = [primeiroNome(atual && atual.full_name), primeiroNome(rec.nome)].filter(Boolean);
      // reunião mais recente antes de marcarem "realizada" (até 2 dias antes / 12h depois), ainda não usada
      const cand = evs.filter((e) => !realizado.has(e) && e.inicio <= rec.tt + 12 * 3600 * 1000 && e.inicio >= rec.tt - 2 * DIA)
        .sort((a, b) => b.inicio - a.inicio);
      const ev = (email && cand.find((e) => e.emails.includes(email))) || cand.find((e) => nomes.includes(e.nome));
      if (ev) { realizado.add(ev); casadas++; }
    });
    // por dia: faltas = marcadas − realizadas; distribuídas entre as reuniões que ficaram sem casar
    const porDiaEv = {};
    evs.forEach((e) => { (porDiaEv[isoDia(e.inicio)] = porDiaEv[isoDia(e.inicio)] || []).push(e); });
    Object.entries(porDiaEv).forEach(([dk, lista]) => {
      const soltas = lista.filter((e) => !realizado.has(e));
      const faltas = Math.max(0, lista.length - (rPorDia[dk] || 0));
      const peso = soltas.length ? Math.min(1, faltas / soltas.length) : 0;
      lista.forEach((e) => { const s = slot(e.inicio); s.reunioes++; if (!realizado.has(e)) s.faltas += peso; });
    });
  }

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
  return res.status(200).json({
    semanas,
    porDia,
    turno: { desde: turnoDesde != null ? isoDia(turnoDesde) : null, realizadasRegistradas: registros.length, casadas, slots }
  });
}
