// Receptor dos webhooks do LeadForge → soma os contadores por mês no Redis (Upstash REST).
// Eventos usados: deal.won (venda/reunião) e deal.created (lead/agendamento/no-show).

const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;

// Funis do LeadForge
const F_VENDAS               = 'b765f6c0-49da-4ad1-9c78-447606006901'; // Vendas
const F_PREVENDAS            = 'e72026a9-756b-4db0-ad9f-2aacc2a5a113'; // Pré Vendas
const F_RASTREIO_AGENDAMENTO = 'eba4042d-db40-436b-8efb-3c5d6602d756'; // [SISTEMA] Rastreio - Agendamentos  (CONFIRMAR)
const F_RASTREIO_NOSHOW      = 'a8bda2e1-e970-41bc-ab62-3158ead4ffc2'; // [SISTEMA] Rastreio - No-Show        (CONFIRMAR)

// Etapas de encerramento do Pré Vendas que contam como DESQUALIFICAÇÃO (saem do MQL)
const S_DESQUALIFICADO = '0ca30456-0b96-4452-a014-3a71db256270'; // LEAD DESQUALIFICADO (status "abandoned")
const S_PERDA_SDR      = '7184bfe4-539f-4f9c-b3a4-b59f6a277ee8'; // PERDA SDR          (status "lost")

// Instância "API Oficial - Lidera" (nº 51 997708817) = leads-lixo do posto de saúde → NÃO contam
const INSTANCIA_POSTO = '8f8cb4b9-25fd-4f5d-93a1-e7dcf03fa338';

// Faixas de valor (etiquetas do Facebook → tag na negociação). Código curto p/ chaves do Redis.
const FAIXAS = [
  { nome: 'Até 50k', cod: 'f1' },
  { nome: '50k - 80k', cod: 'f2' },
  { nome: '80k - 100k', cod: 'f3' },
  { nome: '100k - 150k', cod: 'f4' },
  { nome: '150k - 300k', cod: 'f5' },
  { nome: 'Acima 300k', cod: 'f6' }
];

// Descobre a faixa de um lead consultando as tags das negociações dele na API do LeadForge.
async function faixaDoLead(leadId) {
  const key = process.env.LEADFORGE_API_KEY;
  if (!leadId || !key) return null;
  try {
    const r = await fetch(`https://api.leadforge.com.br/api/v1/deals/search?lead_id=${leadId}`, { headers: { 'X-API-Key': key } });
    const j = await r.json();
    for (const d of (j && j.deals) || []) {
      for (const t of (d.tags || [])) {
        const f = FAIXAS.find((x) => x.nome === (t.name || '').trim());
        if (f) return f.cod;
      }
    }
  } catch (e) { /* ignora */ }
  return null;
}

// obtém a faixa do lead (usa o cache no Redis; se não tiver, consulta a API e guarda)
async function obterFaixa(leadId) {
  if (!leadId) return null;
  const cache = await redis(['GET', `banda:${leadId}`]);
  if (cache) return cache;
  const cod = await faixaDoLead(leadId);
  if (cod) await redis(['SET', `banda:${leadId}`, cod]);
  return cod;
}

async function redis(cmd) {
  const r = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  return j.result;
}

// Mês no fuso do Brasil (UTC-3) → "YYYY-MM"
function mesBR(iso) {
  const d = iso ? new Date(iso) : new Date();
  const br = new Date(d.getTime() - 3 * 3600 * 1000);
  return br.toISOString().slice(0, 7);
}
// Dia no fuso do Brasil (UTC-3) → "YYYY-MM-DD" (registro diário, a partir de jul/2026)
function diaBR(iso) {
  const d = iso ? new Date(iso) : new Date();
  const br = new Date(d.getTime() - 3 * 3600 * 1000);
  return br.toISOString().slice(0, 10);
}

// idempotência: SADD retorna 1 se novo, 0 se já processado (evita contar 2x em retries)
async function primeiraVez(mes, chave) {
  return (await redis(['SADD', `proc:${mes}`, chave])) === 1;
}

async function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  // valida o segredo do webhook (se configurado no Vercel)
  const segredo = process.env.LF_WEBHOOK_SECRET;
  if (segredo && req.headers['x-api-key'] !== segredo) {
    return res.status(401).json({ erro: 'segredo invalido' });
  }
  if (!R_URL || !R_TOKEN) return res.status(500).json({ erro: 'Redis nao configurado' });

  const body = await lerCorpo(req);
  const evento = body.event;
  const deal = (body.data && body.data.deal) || {};
  const lead = (body.data && body.data.lead) || {};

  // SENSOR TEMPORÁRIO: captura o payload completo dos eventos de tag p/ achar a faixa (REMOVER depois)
  try {
    await redis(['LPUSH', 'debug:tags', JSON.stringify({ ev: evento, dkeys: Object.keys((body && body.data) || {}), data: (body && body.data) || null })]);
    await redis(['LTRIM', 'debug:tags', 0, 19]);
  } catch (e) { /* ignora */ }

  try {
    if (evento === 'deal.won') {
      const iso = deal.closed_at || deal.updated_at;
      const mes = mesBR(iso), dia = diaBR(iso);
      if (deal.funnel_id === F_VENDAS) {                        // VENDA
        if (await primeiraVez(mes, `venda:${deal.id}`)) {
          const valor = parseFloat(deal.value || '0') || 0;
          await redis(['INCR', `v:count:${mes}`]);
          await redis(['INCRBYFLOAT', `v:valor:${mes}`, valor]);
          await redis(['INCR', `v:count:${dia}`]);              // diário
          await redis(['INCRBYFLOAT', `v:valor:${dia}`, valor]);
          const cod = await obterFaixa(deal.lead_id);           // por faixa
          if (cod) { await redis(['SADD', `fx:v:${cod}:${mes}`, deal.lead_id]); await redis(['INCRBYFLOAT', `fx:vv:${cod}:${mes}`, valor]); }
        }
      } else if (deal.funnel_id === F_PREVENDAS) {              // REUNIÃO REALIZADA
        if (await primeiraVez(mes, `reuniao:${deal.id}`)) {
          await redis(['INCR', `r:${mes}`]);
          await redis(['INCR', `r:${dia}`]);
        }
      }
    } else if (evento === 'deal.created') {
      const mes = mesBR(deal.created_at), dia = diaBR(deal.created_at);
      if (deal.funnel_id === F_PREVENDAS) {                     // NOVO LEAD (conta cada deal do Pré Vendas 1x)
        // ignora leads-lixo do posto de saúde (vêm pela instância "API Oficial")
        if (lead.instance_id !== INSTANCIA_POSTO && await primeiraVez(mes, `lead:${deal.id}`)) {
          await redis(['INCR', `l:${mes}`]);
          await redis(['INCR', `l:${dia}`]);
          const cod = await obterFaixa(deal.lead_id);           // por faixa
          if (cod) await redis(['SADD', `fx:l:${cod}:${mes}`, deal.lead_id]);
        }
      } else if (deal.funnel_id === F_RASTREIO_AGENDAMENTO) {   // OPORTUNIDADE (agendamento)
        if (await primeiraVez(mes, `oport:${deal.id}`)) {
          await redis(['INCR', `o:${mes}`]);
          await redis(['INCR', `o:${dia}`]);
          const cod = await obterFaixa(deal.lead_id);           // SQL por faixa
          if (cod) await redis(['SADD', `fx:sql:${cod}:${mes}`, deal.lead_id]);
        }
      } else if (deal.funnel_id === F_RASTREIO_NOSHOW) {        // NO-SHOW
        if (await primeiraVez(mes, `noshow:${deal.id}`)) {
          await redis(['INCR', `n:${mes}`]);
          await redis(['INCR', `n:${dia}`]);
        }
      }
    } else if (evento === 'deal.closed') {
      // DESQUALIFICAÇÃO no Pré Vendas → tira do MQL (MQL = leads − desqualificados).
      // deal.closed dispara em qualquer encerramento e traz a etapa; só contam LEAD DESQUALIFICADO e PERDA SDR.
      if (deal.funnel_id === F_PREVENDAS &&
          (deal.funnel_stage_id === S_DESQUALIFICADO || deal.funnel_stage_id === S_PERDA_SDR)) {
        const iso = deal.closed_at || deal.updated_at;
        const mes = mesBR(iso), dia = diaBR(iso);
        if (await primeiraVez(mes, `desq:${deal.id}`)) {
          await redis(['INCR', `d:${mes}`]);
          await redis(['INCR', `d:${dia}`]);
          const cod = await obterFaixa(deal.lead_id);           // desq por faixa
          if (cod) await redis(['SADD', `fx:d:${cod}:${mes}`, deal.lead_id]);
        }
      }
    }
  } catch (e) {
    console.error('erro no webhook:', e);
  }

  // sempre responde 200 rápido pro LeadForge não ficar re-tentando
  return res.status(200).json({ ok: true });
}
