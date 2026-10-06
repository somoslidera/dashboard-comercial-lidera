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

  // ── NO-SHOW por dia da semana e turno.
  // Regra do comercial: NO-SHOW = reunião que caiu no funil "Rastreio - No-Show"; REALIZADA = marcada como "Reunião realizada".
  // Taxa = no-shows ÷ reuniões agendadas na agenda (reunião sem nenhum registro conta como agendada, não como no-show).
  // Pra saber o dia/turno, cada registro é casado com o evento da agenda:
  //   • pela PESSOA (e-mail do convidado ou nome): realizadas antigas via API (fxs:r → cache rx:), novas via rl:{mes};
  //     no-shows a partir do registro nsl:{mes} do webhook;
  //   • o que não tem identidade: pela contagem do dia (r:dia / n:dia), reunião mais recente primeiro, até 2–3 dias antes.
  // Dias úteis sem nenhum registro no painel (apagão de ago/26) ficam de fora.
  const evs = primeiras.filter((e) => e.inicio >= ini && e.inicio < fim && e.inicio < agora).sort((a, b) => a.inicio - b.inicio);
  const diasLista = [];
  for (let t = ini; t < fim; t += DIA) diasLista.push(isoDia(t));
  const meses = [];
  for (let d = new Date(Date.UTC(new Date(ini).getUTCFullYear(), new Date(ini).getUTCMonth(), 1)); d.getTime() < fim; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) meses.push(d.toISOString().slice(0, 7));

  let cont = [], idsR = [], rls = [], nsls = [];
  if (R_URL && R_TOKEN) {
    try {
      const out = await redisPipe([
        ['MGET', ...diasLista.flatMap((d) => [`l:${d}`, `o:${d}`, `r:${d}`, `d:${d}`, `n:${d}`])],
        ...meses.map((m) => ['SMEMBERS', `fxs:r:${m}`]),
        ...meses.map((m) => ['LRANGE', `rl:${m}`, 0, -1]),
        ...meses.map((m) => ['LRANGE', `nsl:${m}`, 0, -1])
      ]);
      const json = (x) => { try { return JSON.parse(x); } catch (e) { return null; } };
      cont = out[0] || [];
      idsR = [...new Set(out.slice(1, 1 + meses.length).flat().filter(Boolean))];
      rls = out.slice(1 + meses.length, 1 + 2 * meses.length).flat().filter(Boolean).map(json).filter(Boolean);
      nsls = out.slice(1 + 2 * meses.length).flat().filter(Boolean).map(json).filter(Boolean);
    } catch (e) { /* sem dados do Redis */ }
  }
  const num = (v) => parseFloat(v || 0) || 0;
  const apagao = new Set(), rDia = {}, nDia = {};
  diasLista.forEach((d, i) => {
    const dow = new Date(Date.parse(d)).getUTCDay();
    const v = [0, 1, 2, 3, 4].map((k) => num(cont[i * 5 + k]));
    rDia[d] = v[2]; nDia[d] = v[4];
    if (dow >= 1 && dow <= 5 && v.every((x) => !x)) apagao.add(d);
  });

  // identidade das realizadas (antigas via API com cache; novas via rl)
  const ident = {};
  const rlPorDeal = {};
  rls.forEach((r) => { if (r.deal) rlPorDeal[r.deal] = r; });
  await Promise.all(Object.values(rlPorDeal).map(async (rec) => {
    const atual = await leadAtual(rec);
    ident[rec.deal] = { t: rec.t, email: (atual && atual.email) || rec.email || null, nomes: [atual && atual.full_name, rec.nome].filter(Boolean) };
  }));
  const semIdent = idsR.filter((id) => !ident[id]);
  if (semIdent.length && R_URL && R_TOKEN) {
    try {
      const cache = (await redisPipe([['MGET', ...semIdent.map((id) => `rx:${id}`)]]))[0] || [];
      const faltando = [];
      semIdent.forEach((id, i) => { const c = cache[i]; if (c && c !== '_') { try { ident[id] = JSON.parse(c); } catch (e) {} } else if (!c) faltando.push(id); });
      const lote = faltando.slice(0, 15);                       // resolve aos poucos e guarda (cache permanente)
      if (lote.length) {
        const dls = (await redisPipe([['MGET', ...lote.map((id) => `dl:${id}`)]]))[0] || [];
        const sets = [];
        await Promise.all(lote.map(async (id, i) => {
          const r = await resolverRealizada(id, dls[i]);
          if (r) { ident[id] = r; sets.push(['SET', `rx:${id}`, JSON.stringify(r)]); }
          else sets.push(['SET', `rx:${id}`, '_', 'EX', 21600]);   // tenta de novo em 6h
        }));
        if (sets.length) await redisPipe(sets);
      }
    } catch (e) { /* segue com o que tiver */ }
  }
  // identidade dos no-shows (só existe a partir do registro nsl; nome/e-mail ATUAIS pelo telefone)
  const identNs = await Promise.all(nsls.map(async (rec) => {
    const atual = await leadAtual(rec);
    return { t: rec.t, email: (atual && atual.email) || rec.email || null, nomes: [atual && atual.full_name, rec.nome].filter(Boolean) };
  }));

  const status = new Map();
  evs.forEach((e) => { if (apagao.has(isoDia(e.inicio))) status.set(e, 'fora'); });

  // casa registros identificados com o evento da mesma pessoa (até 3 dias antes / 12h depois do registro)
  const casarPorPessoa = (lista, marca) => {
    const porDiaCasado = {};
    lista.map((r) => ({ tt: Date.parse(r.t) - BR, email: norm(r.email), nomes: (r.nomes || []).map(primeiroNome).filter(Boolean) }))
      .filter((r) => !isNaN(r.tt)).sort((a, b) => a.tt - b.tt).forEach((r) => {
        const cand = evs.filter((e) => !status.has(e) && e.inicio <= r.tt + 12 * 3600 * 1000 && e.inicio >= r.tt - 3 * DIA)
          .sort((a, b) => b.inicio - a.inicio);
        const ev = (r.email && cand.find((e) => e.emails.includes(r.email))) || cand.find((e) => r.nomes.includes(e.nome));
        // só desconta da contagem do dia o registro que CASOU; o que não casou volta p/ a contagem (não pode sumir)
        if (ev) { status.set(ev, marca); const k = isoDia(r.tt); porDiaCasado[k] = (porDiaCasado[k] || 0) + 1; }
      });
    return porDiaCasado;
  };
  // registros sem identidade: pela contagem do dia, na reunião sem registro mais recente (mesmo dia primeiro)
  const casarPorContagem = (porDia, jaCasados, janelaDias, marca) => {
    diasLista.forEach((d) => {
      if (apagao.has(d)) return;
      let livres = Math.max(0, (porDia[d] || 0) - (jaCasados[d] || 0));
      if (!livres) return;
      const t = Date.parse(d);
      const cand = evs.filter((e) => {
        if (status.has(e)) return false;
        const de = Date.parse(isoDia(e.inicio));
        return de <= t && t - de <= janelaDias * DIA;
      }).sort((a, b) => b.inicio - a.inicio);
      while (livres-- > 0 && cand.length) status.set(cand.shift(), marca);
    });
  };
  const rCasadas = casarPorPessoa(Object.values(ident), 'ok');
  const nCasados = casarPorPessoa(identNs, 'noshow');
  casarPorContagem(rDia, rCasadas, 2, 'ok');
  casarPorContagem(nDia, nCasados, 3, 'noshow');

  // conferência (p/ o usuário checar): registros do LeadForge no período × o que foi atribuído a reuniões da agenda
  const hojeDia = Date.parse(isoDia(agora));
  const conferencia = { reunioesAgenda: 0, realizadas: 0, noshow: 0, semRegistro: 0, realizadasNoLeadForge: 0, noshowNoLeadForge: 0 };
  diasLista.forEach((d) => {
    if (apagao.has(d) || Date.parse(d) > hojeDia) return;
    conferencia.realizadasNoLeadForge += rDia[d] || 0; conferencia.noshowNoLeadForge += nDia[d] || 0;
  });
  const slots = {}, porDow = {};
  const conta = (obj, k, ns) => { const a = obj[k] || (obj[k] = { reunioes: 0, faltas: 0 }); a.reunioes++; if (ns) a.faltas++; };
  evs.forEach((e) => {
    const s = status.get(e);
    if (s === 'fora') return;
    conferencia.reunioesAgenda++;
    if (s === 'ok') conferencia.realizadas++;
    else if (s === 'noshow') conferencia.noshow++;
    else conferencia.semRegistro++;                       // agendada, mas não é no-show (entra só no denominador)
    conta(slots, new Date(e.inicio).getUTCDay() + '-' + turno(e.inicio), s === 'noshow');
    conta(porDow, new Date(e.inicio).getUTCDay(), s === 'noshow');
  });

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
  return res.status(200).json({
    semanas,
    porDia,
    noshow: {
      dias: porDow, slots, conferencia,
      casadasPelaPessoa: Object.values(rCasadas).reduce((s, x) => s + x, 0) + Object.values(nCasados).reduce((s, x) => s + x, 0),
      diasForaApagao: [...apagao].filter((d) => evs.some((e) => isoDia(e.inicio) === d))
    }
  });
}

// realizada antiga → quando foi marcada + nome/e-mail do lead (título da negociação; nome/e-mail atuais via busca)
async function resolverRealizada(dealId, leadId) {
  const key = process.env.LEADFORGE_API_KEY;
  if (!key || !leadId) return null;
  const LF = 'https://api.leadforge.com.br/api/v1', H = { headers: { 'X-API-Key': key } };
  try {
    const jd = await (await fetch(`${LF}/deals/search?lead_id=${leadId}`, H)).json();
    const d = ((jd && jd.deals) || []).find((x) => x.id === dealId);
    if (!d) return null;
    const t = d.closed_at || d.updated_at;
    if (!t) return null;
    const titulo = (d.title || '').trim();
    const nomeTit = titulo.includes(' - ') ? titulo.split(' - ').slice(1).join(' - ').trim() : titulo;
    let email = null, nomeAtual = null;
    if (nomeTit) {
      try {
        const jl = await (await fetch(`${LF}/leads/search?name=${encodeURIComponent(nomeTit)}`, H)).json();
        const l = ((jl && jl.leads) || []).find((x) => x.id === leadId);
        if (l) { email = l.email || null; nomeAtual = l.full_name || null; }
      } catch (e) { /* fica só com o título */ }
    }
    return { t, email, nomes: [nomeAtual, nomeTit].filter(Boolean) };
  } catch (e) { return null; }
}
