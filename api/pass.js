/* InnPass · api/pass.js
   Función serverless para Vercel (Node.js). Solo POST.

   Entrada:  { "url": "https://.../#p=amlodipine:5mg:tab" }
   Salida:   { shareUrl, googleSaveUrl, applePass }

   Crea un pase de Wallet en WalletWallet con la URL del pase InnPass como
   valor del QR. La clave vive SOLO en la variable de entorno WALLETWALLET_KEY
   (Vercel → Settings → Environment Variables). Sin clave → 501. */

const WALLETWALLET_ENDPOINT = 'https://api.walletwallet.dev/api/passes';
const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_BARCODE_LENGTH = 1024; // límite documentado de barcodeValue

const PASS_DESIGN = {
  logoText: 'InnPass',
  organizationName: 'InnPass',
  color: '#2D6A4F',
  primaryFields: [{ label: 'PASE', value: 'DCI' }],
  barcodeFormat: 'QR',
  barcodeAltText: 'InnPass',
};

function sendJson(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

// Vercel ya parsea application/json en req.body; se cubre también el caso string.
function readBody(req) {
  const body = req.body;
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return null; }
  }
  if (typeof body === 'object') return body;
  return null;
}

function validateUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Falta "url" en el body.';
  if (value.length > MAX_BARCODE_LENGTH) return `"url" supera ${MAX_BARCODE_LENGTH} caracteres.`;
  let parsed;
  try { parsed = new URL(value); } catch { return '"url" no es una URL válida.'; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '"url" debe ser http(s).';
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Método no permitido. Usa POST.' });
  }

  const apiKey = process.env.WALLETWALLET_KEY;
  if (!apiKey) {
    return sendJson(res, 501, {
      error: 'Wallet no configurado en este despliegue (falta WALLETWALLET_KEY).',
    });
  }

  const body = readBody(req);
  if (body === null) return sendJson(res, 400, { error: 'Body JSON inválido.' });

  const url = typeof body.url === 'string' ? body.url.trim() : body.url;
  const problem = validateUrl(url);
  if (problem) return sendJson(res, 400, { error: problem });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(WALLETWALLET_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ ...PASS_DESIGN, barcodeValue: url }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err && err.name === 'AbortError';
    return sendJson(res, 504, {
      error: timedOut ? 'WalletWallet no respondió a tiempo.' : 'No se pudo contactar con WalletWallet.',
    });
  }
  clearTimeout(timer);

  let data = null;
  try { data = await upstream.json(); } catch { data = null; }

  if (!upstream.ok) {
    const detail = data && (data.error || data.message);
    return sendJson(res, 502, {
      error: 'WalletWallet devolvió un error.',
      upstreamStatus: upstream.status,
      detail: typeof detail === 'string' ? detail : undefined,
    });
  }

  if (!data || typeof data !== 'object') {
    return sendJson(res, 502, { error: 'Respuesta inesperada de WalletWallet.' });
  }

  return sendJson(res, 200, {
    shareUrl: data.shareUrl,
    googleSaveUrl: data.googleSaveUrl,
    applePass: data.applePass,
  });
};
