// Recebe usuário/senha, valida e devolve o cookie de sessão assinado.
import { AUTH_ATIVO, credenciaisOk, criarToken } from './_auth.js';

async function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });
  if (!AUTH_ATIVO) return res.status(500).json({ erro: 'login ainda nao configurado (defina DASHBOARD_SENHA no Vercel)' });

  const body = await lerCorpo(req);
  if (!credenciaisOk(body.usuario, body.senha)) {
    return res.status(401).json({ erro: 'usuário ou senha inválidos' });
  }
  const { token, dias } = criarToken();
  res.setHeader('Set-Cookie', `sess=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${dias * 86400}`);
  return res.status(200).json({ ok: true });
}
