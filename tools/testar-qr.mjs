// Verifica o codificador de QR contra um decodificador independente.
//
//   npm install          (traz o jsQR, usado só aqui)
//   node tools/testar-qr.mjs
//
// O codificador em docs/lib/qr.js foi escrito do zero para o site não depender
// de CDN nem de build. Este teste é o que garante que ele está certo: gera QRs
// em todas as versões e níveis usados e manda o jsQR decodificar de volta.

import { createRequire } from 'node:module';
import { encodeQR } from '../docs/lib/qr.js';

const require = createRequire(import.meta.url);
let jsQR;
try {
  const mod = require('jsqr');
  jsQR = mod.default ?? mod;
} catch {
  console.error('jsQR não encontrado. Rode `npm install` na raiz do projeto.');
  process.exit(1);
}

const ESCALA = 4;
const ZONA_SILENCIO = 4;

// Desenha a matriz como imagem RGBA, que é o que o jsQR consome.
function desenhar(modulos) {
  const lado = modulos.length;
  const dim = (lado + ZONA_SILENCIO * 2) * ESCALA;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < lado; r++) {
    for (let c = 0; c < lado; c++) {
      if (!modulos[r][c]) continue;
      for (let dy = 0; dy < ESCALA; dy++) {
        for (let dx = 0; dx < ESCALA; dx++) {
          const y = (r + ZONA_SILENCIO) * ESCALA + dy;
          const x = (c + ZONA_SILENCIO) * ESCALA + dx;
          const i = (y * dim + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, dim };
}

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.:/#';
const amostra = (n) => {
  let s = '';
  for (let i = 0; i < n; i++) s += ALFABETO[(i * 37 + n * 11) % ALFABETO.length];
  return s;
};

let ok = 0;
const falhas = [];

function conferir(texto, nivel, rotulo) {
  let qr;
  try {
    qr = encodeQR(texto, { ecLevel: nivel });
  } catch (e) {
    if (/longo demais/.test(e.message)) return;   // acima da capacidade, esperado
    falhas.push(`${rotulo}: erro ao codificar — ${e.message}`);
    return;
  }
  const { data, dim } = desenhar(qr.modules);
  const lido = jsQR(data, dim, dim);
  if (!lido) falhas.push(`${rotulo} (v${qr.version}, máscara ${qr.mask}): não decodificou`);
  else if (lido.data !== texto) falhas.push(`${rotulo} (v${qr.version}): conteúdo divergente`);
  else ok++;
}

// Tamanhos escolhidos para cair logo abaixo e logo acima de cada troca de versão.
const TAMANHOS = [1, 2, 5, 10, 17, 20, 32, 34, 40, 60, 62, 80, 84, 106, 108, 120, 122, 134, 154,
  155, 180, 192, 194, 216, 232, 250, 274, 290, 300, 322, 334, 365, 400, 415, 428, 453, 460, 500,
  507, 523, 563, 589, 600, 627, 647, 700, 721, 795, 800, 861];

for (const nivel of ['L', 'M']) {
  for (const n of TAMANHOS) conferir(amostra(n), nivel, `${nivel}/${n}`);
}

// UTF-8 multibyte: nomes com acento têm que sobreviver ao trajeto.
conferir('ATESTADO Nº 42 — José Antônio da Conceição, CRM-SP 123456', 'M', 'acentuação');
conferir('https://exemplo.github.io/validar/#áéíóúçÃÕ', 'M', 'URL com acento');

console.log(`QR: ${ok} casos ok, ${falhas.length} falhas`);
for (const f of falhas) console.log('  x ' + f);
process.exit(falhas.length === 0 ? 0 : 1);
