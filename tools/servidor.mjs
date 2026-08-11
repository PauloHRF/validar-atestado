// Servidor estático para testar o site antes de publicar.
//
//   node tools/servidor.mjs [porta]
//
// Serve a pasta docs/ — exatamente o que o GitHub Pages vai servir. É preciso
// um servidor de verdade porque o site usa módulos ES, que o navegador recusa
// carregar via file://.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORTA = Number(process.argv[2] ?? 4173);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  // Só o caminho interessa; o fragmento (#token) nem chega ao servidor.
  const caminho = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  // normalize + verificação de prefixo barram travessia de diretório (../).
  let alvo = normalize(join(RAIZ, caminho));
  if (alvo !== RAIZ && !alvo.startsWith(RAIZ + sep)) {
    res.writeHead(403).end('Proibido');
    return;
  }

  try {
    if ((await stat(alvo)).isDirectory()) alvo = join(alvo, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Não encontrado');
    return;
  }

  try {
    await stat(alvo);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Não encontrado');
    return;
  }

  res.writeHead(200, {
    'content-type': TIPOS[extname(alvo).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(alvo).pipe(res);
}).listen(PORTA, () => {
  console.log(`Servindo docs/ em http://localhost:${PORTA}/`);
  console.log(`Emissão:  http://localhost:${PORTA}/emitir/`);
});
