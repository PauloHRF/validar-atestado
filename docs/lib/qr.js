// Codificador de QR Code — modo byte, níveis de correção L e M, versões 1 a 20.
// Implementação própria, sem dependências externas: o site precisa rodar inteiro
// no GitHub Pages, sem CDN e sem build.
//
// Suficiente para os tokens de atestado (~400 caracteres). Versão 20 nível M
// comporta 1769 bytes, folga larga.

// Total de codewords (dados + correção) por versão.
const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
];

// [codewords de correção por bloco, quantidade de blocos] por versão.
const EC_BLOCKS = {
  L: [[7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4],
      [20, 4], [24, 4], [26, 4], [30, 4], [22, 6], [24, 6], [28, 6], [30, 6], [28, 7], [28, 8]],
  M: [[10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5],
      [30, 5], [22, 8], [22, 9], [24, 9], [24, 10], [28, 10], [28, 11], [26, 13], [26, 14], [26, 16]],
};

// Centros dos padrões de alinhamento por versão.
const ALIGN_CENTERS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

const EC_LEVEL_BITS = { L: 0b01, M: 0b00 };

const MAX_VERSION = 20;

// --- Aritmética em GF(256), polinômio primitivo 0x11d ---------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Polinômio gerador de grau `degree`: produto de (x - alfa^i).
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                      // multiplica por x
      next[j + 1] ^= gfMul(poly[j], EXP[i]);   // multiplica por alfa^i
    }
    poly = next;
  }
  return poly;
}

// Resto da divisão polinomial = codewords de correção de erro.
function ecCodewords(data, count) {
  const gen = generatorPoly(count);
  const res = new Uint8Array(data.length + count);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

// --- Montagem do fluxo de bits -------------------------------------------

class Bits {
  constructor() {
    this.bytes = [];
    this.length = 0;
  }
  push(value, bitCount) {
    for (let i = bitCount - 1; i >= 0; i--) {
      if (this.length % 8 === 0) this.bytes.push(0);
      if ((value >>> i) & 1) this.bytes[this.bytes.length - 1] |= 0x80 >>> (this.length % 8);
      this.length++;
    }
  }
}

function dataCapacity(version, level) {
  const [ecPerBlock, blocks] = EC_BLOCKS[level][version - 1];
  return TOTAL_CODEWORDS[version - 1] - ecPerBlock * blocks;
}

function pickVersion(byteLength, level) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (dataCapacity(v, level) * 8 >= headerBits + byteLength * 8) return v;
  }
  throw new Error(
    `Conteúdo longo demais para QR versão ${MAX_VERSION} nível ${level} (${byteLength} bytes).`
  );
}

// Codewords finais, já intercalados entre blocos como manda a norma.
function buildCodewords(data, version, level) {
  const [ecPerBlock, blocks] = EC_BLOCKS[level][version - 1];
  const dataCw = dataCapacity(version, level);
  const shortLen = Math.floor(dataCw / blocks);
  const longBlocks = dataCw % blocks;   // blocos com um codeword extra, sempre no fim

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const len = shortLen + (b >= blocks - longBlocks ? 1 : 0);
    const chunk = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(chunk);
    ecBlocks.push(ecCodewords(chunk, ecPerBlock));
  }

  const out = [];
  for (let i = 0; i <= shortLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const blk of ecBlocks) out.push(blk[i]);
  }
  return out;
}

// --- Padrões fixos e reservas -------------------------------------------

function makeMatrix(version) {
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Int8Array(size).fill(-1));

  // Localizadores + separadores (a moldura de 0 ao redor).
  for (const [pr, pc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = pr + r, cc = pc + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = onRing || inCore ? 1 : 0;
      }
    }
  }

  // Linhas de temporização.
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Padrões de alinhamento, pulando os que colidem com os localizadores.
  const centers = ALIGN_CENTERS[version - 1];
  const last = centers[centers.length - 1];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr][c + dc] = ring === 1 ? 0 : 1;
        }
      }
    }
  }

  // Reserva das áreas de formato (preenchidas depois da máscara).
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === -1) m[8][i] = 0;
    if (m[i][8] === -1) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    m[8][size - 1 - i] = 0;
    m[size - 1 - i][8] = 0;
  }
  m[size - 8][8] = 1;   // módulo escuro fixo

  // Reserva das áreas de versão.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        m[size - 11 + j][i] = 0;
        m[i][size - 11 + j] = 0;
      }
    }
  }

  return m;
}

// Percurso em ziguezague, duas colunas por vez, da direita para a esquerda.
function placeData(m, codewords) {
  const size = m.length;
  const bits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  }

  let bi = 0;
  let upward = true;
  for (let col = size - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5;   // a coluna 6 é temporização, não recebe dados
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (m[row][c] === -1) m[row][c] = bi < bits.length ? bits[bi++] : 0;
      }
    }
    upward = !upward;
  }
}

// --- Máscaras ------------------------------------------------------------

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i, j) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => ((((i * j) % 2) + ((i * j) % 3)) % 2) === 0,
  (i, j) => ((((i + j) % 2) + ((i * j) % 3)) % 2) === 0,
];

const FINDER_LIKE = [
  [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
];

function penalty(m) {
  const size = m.length;
  let score = 0;

  // Regra 1: sequências de 5 ou mais módulos da mesma cor.
  const runScore = (get) => {
    let total = 0;
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
        } else {
          if (run >= 5) total += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) total += 3 + (run - 5);
    }
    return total;
  };
  score += runScore((a, b) => m[a][b]);
  score += runScore((a, b) => m[b][a]);

  // Regra 2: blocos 2x2 de cor uniforme.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Regra 3: padrões parecidos com localizador (1:1:3:1:1 + zona clara).
  for (let a = 0; a < size; a++) {
    for (let b = 0; b <= size - 11; b++) {
      for (const pat of FINDER_LIKE) {
        let okRow = true, okCol = true;
        for (let k = 0; k < 11; k++) {
          if (m[a][b + k] !== pat[k]) okRow = false;
          if (m[b + k][a] !== pat[k]) okCol = false;
          if (!okRow && !okCol) break;
        }
        if (okRow) score += 40;
        if (okCol) score += 40;
      }
    }
  }

  // Regra 4: desequilíbrio entre módulos claros e escuros.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

// --- Informação de formato e de versão (BCH) ------------------------------

function formatBits(level, mask) {
  const data = (EC_LEVEL_BITS[level] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function versionInfoBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return ((version << 12) | rem) & 0x3ffff;
}

function placeFormatInfo(m, level, mask) {
  const size = m.length;
  const bits = formatBits(level, mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >>> i) & 1;
    // Cópia vertical: coluna 8, de cima para baixo, saltando a temporização.
    const row = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    m[row][8] = bit;
    // Cópia horizontal: linha 8, da direita para a esquerda.
    const col = i < 8 ? size - 1 - i : i < 9 ? 15 - i : 14 - i;
    m[8][col] = bit;
  }
}

function placeVersionInfo(m, version) {
  if (version < 7) return;
  const size = m.length;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
    m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
  }
}

// --- API pública ---------------------------------------------------------

/**
 * Codifica `text` (UTF-8) em uma matriz de QR Code.
 * @param {string} text
 * @param {{ecLevel?: 'L'|'M', minVersion?: number}} [options]
 * @returns {{version: number, ecLevel: string, mask: number, size: number, modules: number[][]}}
 *          `modules[linha][coluna]` vale 1 para módulo escuro, 0 para claro.
 */
export function encodeQR(text, options = {}) {
  const level = options.ecLevel ?? 'M';
  if (!EC_LEVEL_BITS.hasOwnProperty(level)) {
    throw new Error(`Nível de correção não suportado: ${level} (use 'L' ou 'M').`);
  }

  const payload = new TextEncoder().encode(text);
  let version = pickVersion(payload.length, level);
  if (options.minVersion) version = Math.max(version, options.minVersion);

  // Fluxo de bits: indicador de modo, contagem, dados, terminador e enchimento.
  const bits = new Bits();
  bits.push(0b0100, 4);
  bits.push(payload.length, version < 10 ? 8 : 16);
  for (const b of payload) bits.push(b, 8);

  const capacity = dataCapacity(version, level);
  const remainingBits = capacity * 8 - bits.length;
  bits.push(0, Math.min(4, remainingBits));            // terminador
  while (bits.length % 8 !== 0) bits.push(0, 1);       // alinha em byte
  const padding = [0xec, 0x11];
  for (let i = 0; bits.bytes.length < capacity; i++) bits.push(padding[i % 2], 8);

  const codewords = buildCodewords(Uint8Array.from(bits.bytes), version, level);

  // Marca quais módulos são de função — a máscara não os afeta.
  const base = makeMatrix(version);
  const isFunction = base.map((row) => row.map((v) => v !== -1));
  placeData(base, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.map((row) => Int8Array.from(row));
    for (let r = 0; r < candidate.length; r++) {
      for (let c = 0; c < candidate.length; c++) {
        if (!isFunction[r][c] && MASKS[mask](r, c)) candidate[r][c] ^= 1;
      }
    }
    placeFormatInfo(candidate, level, mask);
    placeVersionInfo(candidate, version);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, mask, matrix: candidate };
  }

  return {
    version,
    ecLevel: level,
    mask: best.mask,
    size: best.matrix.length,
    modules: best.matrix.map((row) => Array.from(row)),
  };
}

/**
 * Desenha o QR como SVG. Escala em unidades de módulo — use CSS/width para
 * dimensionar; assim imprime nítido em qualquer tamanho.
 * @param {string} text
 * @param {{ecLevel?: 'L'|'M', quietZone?: number, dark?: string, light?: string}} [options]
 * @returns {string} markup SVG
 */
export function qrToSVG(text, options = {}) {
  const { size, modules } = encodeQR(text, options);
  const quiet = options.quietZone ?? 4;
  const total = size + quiet * 2;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';

  // Um único <path> com todos os módulos escuros: SVG pequeno e rápido.
  const parts = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR Code de verificação">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${parts.join('')}" fill="${dark}"/></svg>`;
}
