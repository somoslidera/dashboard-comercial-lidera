// Versão publicada do painel: a TV consulta de tempos em tempos e se recarrega sozinha quando muda (novo deploy).
import { autorizado } from './_auth.js';

export default function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ v: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || null });
}
