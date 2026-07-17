// Receptor dos webhooks do LeadForge → soma os contadores por mês no Redis (Upstash REST).
// Eventos usados: deal.won (venda/reunião) e deal.created (lead/agendamento/no-show).

const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;

// Funis do LeadForge
const F_VENDAS               = 'b765f6c0-49da-4ad1-9c78-447606006901'; // Vendas
const F_PREVENDAS            = 'e72026a9-756b-4db0-ad9f-2aacc2a5a113'; // Pré Vendas
const F_RASTREIO_AGENDAMENTO = 'eba4042d-db40-436b-8efb-3c5d6602d756'; // [SISTEMA] Rastreio - Agendamentos  (CONFIRMAR)
const F_RASTREIO_NOSHOW      = 'a8bda2e1-e970-41bc-ab62-3158ead4ffc2'; // [SISTEMA] Rastreio - No-Show        (CONFIRMAR)

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

  try {
    if (evento === 'deal.won') {
      const mes = mesBR(deal.closed_at || deal.updated_at);
      if (deal.funnel_id === F_VENDAS) {                        // VENDA
        if (await primeiraVez(mes, `venda:${deal.id}`)) {
          const valor = parseFloat(deal.value || '0') || 0;
          await redis(['INCR', `v:count:${mes}`]);
          await redis(['INCRBYFLOAT', `v:valor:${mes}`, valor]);
        }
      } else if (deal.funnel_id === F_PREVENDAS) {              // REUNIÃO REALIZADA
        if (await primeiraVez(mes, `reuniao:${deal.id}`)) await redis(['INCR', `r:${mes}`]);
      }
    } else if (evento === 'deal.created') {
      const mes = mesBR(deal.created_at);
      if (deal.funnel_id === F_PREVENDAS) {                     // NOVO LEAD (distinto por lead_id)
        if (deal.lead_id) await redis(['SADD', `l:${mes}`, deal.lead_id]);
      } else if (deal.funnel_id === F_RASTREIO_AGENDAMENTO) {   // OPORTUNIDADE (agendamento)
        if (await primeiraVez(mes, `oport:${deal.id}`)) await redis(['INCR', `o:${mes}`]);
      } else if (deal.funnel_id === F_RASTREIO_NOSHOW) {        // NO-SHOW
        if (await primeiraVez(mes, `noshow:${deal.id}`)) await redis(['INCR', `n:${mes}`]);
      }
    }
  } catch (e) {
    console.error('erro no webhook:', e);
  }

  // sempre responde 200 rápido pro LeadForge não ficar re-tentando
  return res.status(200).json({ ok: true });
}
