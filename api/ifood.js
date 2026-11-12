// Entrega para a tela iFood o último data.json recebido (ver ifood-receber.js).
import { autorizado } from './_auth.js';

const R_URL = process.env.KV_REST_API_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  res.setHeader('Cache-Control', 'no-store');
  if (!R_URL || !R_TOKEN) return res.status(500).json({ erro: 'sem_redis' });
  try {
    const r = await fetch(`${R_URL}/mget/ifood:data/ifood:recebido`, { headers: { Authorization: `Bearer ${R_TOKEN}` } });
    const j = await r.json();
    const [dados, recebido] = (j && j.result) || [];
    if (!dados) return res.status(200).json({ vazio: true });
    return res.status(200).json({ dados: JSON.parse(dados), recebido: recebido ? JSON.parse(recebido) : null });
  } catch (e) {
    return res.status(502).json({ erro: 'falha_ao_ler', detalhe: String(e.message || e) });
  }
}
