// Entrega para a tela iFood o último data.json recebido (ver ifood-receber.js)
// + o histórico das últimas tentativas de envio (aceitas e recusadas), para saber por que não atualizou.
import { autorizado } from './_auth.js';

const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  res.setHeader('Cache-Control', 'no-store');
  if (!R_URL || !R_TOKEN) return res.status(500).json({ erro: 'sem_redis' });
  try {
    const r = await fetch(`${R_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['MGET', 'ifood:data', 'ifood:recebido'], ['LRANGE', 'ifood:envios', 0, 9]])
    });
    const j = await r.json();
    const [dados, recebido] = (j[0] && j[0].result) || [];
    const envios = ((j[1] && j[1].result) || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    if (!dados) return res.status(200).json({ vazio: true, envios });
    return res.status(200).json({ dados: JSON.parse(dados), recebido: recebido ? JSON.parse(recebido) : null, envios });
  } catch (e) {
    return res.status(502).json({ erro: 'falha_ao_ler', detalhe: String(e.message || e) });
  }
}
