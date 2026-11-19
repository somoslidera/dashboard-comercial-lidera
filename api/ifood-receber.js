// Recebe o data.json do iFood (gerado pelo app no Toqan) e guarda no Redis.
// NUNCA vai para o GitHub (o repositório é público) — fica só no banco do painel.
//
// Quem pode enviar:
//   1) o Toqan, com o cabeçalho  Authorization: Bearer <IFOOD_TOKEN>   (ou  x-ifood-token: <IFOOD_TOKEN>)
//      → IFOOD_TOKEN é uma env da Vercel; sem ela, esse caminho fica desligado.
//   2) alguém logado no painel (botão "enviar arquivo" da tela iFood).
//
// ?teste=1 → só confere o arquivo e guarda numa chave separada; NÃO troca o que aparece no painel.
import crypto from 'node:crypto';
import { autorizado, AUTH_ATIVO } from './_auth.js';

const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;
const MAX_BYTES = 3 * 1024 * 1024;

async function pipeline(cmds) {
  const r = await fetch(`${R_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis_' + r.status);
  const j = await r.json();
  return j.map((x) => x.result);
}

function tokenOk(req) {
  const esperado = process.env.IFOOD_TOKEN;
  if (!esperado) return false;
  const h = req.headers || {};
  const m = String(h.authorization || '').match(/^Bearer\s+(.+)$/i);
  const recebido = (m && m[1].trim()) || String(h['x-ifood-token'] || '').trim();
  if (!recebido) return false;
  const a = Buffer.from(recebido), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lerCorpo(req) {
  let b;
  try { b = req.body; } catch { return null; }   // JSON quebrado: a Vercel lança erro ao ler req.body
  if (b == null) return null;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return null; } }
  return b && typeof b === 'object' ? b : null;
}

// confere se o arquivo tem o formato que a tela entende
function validar(d) {
  if (!d || typeof d !== 'object') return 'corpo_nao_e_json';
  if (!d.periods || typeof d.periods !== 'object') return 'falta_periods';
  if (!Array.isArray(d.order) || !d.order.length) return 'falta_order';
  for (const k of d.order) {
    const p = d.periods[k];
    if (!p) return 'periodo_ausente:' + k;
    if (!p.empty && (!Array.isArray(p.stores) || !p.network)) return 'periodo_incompleto:' + k;
  }
  return null;
}

// registra CADA tentativa de envio (aceita ou recusada) — o plano da Vercel só guarda 1h de log,
// então o histórico fica no Redis (últimas 30) e aparece na tela iFood (/api/ifood → envios).
async function registrar(info) {
  const linha = { em: new Date().toISOString(), ...info };
  console.log('[ifood-receber]', JSON.stringify(linha));
  try { await pipeline([['LPUSH', 'ifood:envios', JSON.stringify(linha)], ['LTRIM', 'ifood:envios', 0, 29]]); } catch { /* sem histórico, segue */ }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use_post' });
  const teste = String((req.query && req.query.teste) || '') === '1';

  const viaToken = tokenOk(req);
  const viaPainel = !viaToken && AUTH_ATIVO && autorizado(req);
  const origem = viaToken ? 'toqan' : viaPainel ? 'painel' : 'desconhecida';
  const recusar = async (status, corpo) => { await registrar({ status, origem, teste, erro: corpo.erro, detalhe: corpo.detalhe || null }); return res.status(status).json(corpo); };
  if (!R_URL || !R_TOKEN) return res.status(500).json({ erro: 'sem_redis' });
  if (!viaToken && !viaPainel) return recusar(401, { erro: 'nao_autorizado', detalhe: req.headers.authorization || req.headers['x-ifood-token'] ? 'token_diferente' : 'sem_token' });

  const d = lerCorpo(req);
  const problema = validar(d);
  if (problema) return recusar(400, { erro: 'arquivo_invalido', detalhe: problema });

  const texto = JSON.stringify(d);
  if (Buffer.byteLength(texto) > MAX_BYTES) return recusar(413, { erro: 'arquivo_grande_demais' });

  const recebido = JSON.stringify({ em: new Date().toISOString(), origem, gerado: d.generated_at || null });
  try {
    if (teste) await pipeline([['SET', 'ifood:teste', texto, 'EX', 7 * 86400], ['SET', 'ifood:teste:recebido', recebido, 'EX', 7 * 86400]]);
    else await pipeline([['SET', 'ifood:data', texto], ['SET', 'ifood:recebido', recebido]]);
  } catch (e) {
    return recusar(502, { erro: 'falha_ao_gravar', detalhe: String(e.message || e) });
  }

  const p0 = d.periods[d.default] || d.periods[d.order[0]];
  await registrar({ status: 200, origem, teste, gerado: d.generated_at || null, lojas: (p0 && p0.stores && p0.stores.length) || 0 });
  return res.status(200).json({
    ok: true,
    teste,
    gravado_em: teste ? 'ifood:teste (não aparece no painel)' : 'painel',
    gerado: d.generated_at || null,
    periodos: d.order,
    lojas: (p0 && p0.stores && p0.stores.length) || 0,
    bytes: Buffer.byteLength(texto)
  });
}
