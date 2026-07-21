// Autenticação simples por senha única (cookie assinado). Compartilhado entre as funções.
// A proteção só LIGA quando a env DASHBOARD_SENHA existe — antes disso tudo fica aberto
// (pra não derrubar o dashboard que já está no ar enquanto você não configura).
import crypto from 'node:crypto';

const SENHA = process.env.DASHBOARD_SENHA;
const SECRET = process.env.AUTH_SECRET || SENHA || 'lidera-fallback-secret';
const USUARIO = process.env.DASHBOARD_USUARIO || 'lidera';

export const AUTH_ATIVO = !!SENHA;

function assinar(payloadB64) {
  return crypto.createHmac('sha256', SECRET).update(payloadB64).digest('hex');
}

// valida usuário/senha; retorna true se bater
export function credenciaisOk(usuario, senha) {
  return AUTH_ATIVO && String(usuario || '').trim() === USUARIO && String(senha || '') === SENHA;
}

// cria o token assinado (payload em base64url + HMAC)
export function criarToken(dias = 180) {
  const payload = Buffer.from(JSON.stringify({ u: USUARIO, exp: Date.now() + dias * 86400000 })).toString('base64url');
  return { token: `${payload}.${assinar(payload)}`, dias };
}

// verifica o cookie da requisição
export function autorizado(req) {
  if (!AUTH_ATIVO) return true; // proteção desligada até configurar a senha
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sess=([^;]+)/);
  if (!m) return false;
  const [payload, sig] = decodeURIComponent(m[1]).split('.');
  if (!payload || !sig) return false;
  const esperado = assinar(payload);
  const a = Buffer.from(sig), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.exp > Date.now();
  } catch { return false; }
}
