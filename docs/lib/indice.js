// Índice de atestados: a ponte entre a chave curta de 16 dígitos e o token
// assinado.
//
// Por que existe: uma chave de 16 dígitos tem ~53 bits. Uma assinatura ECDSA
// P-256 tem 512 bits, e ainda haveria os dados. Chave curta o bastante para ser
// digitada à mão, portanto, não pode carregar o documento — ela só pode apontar
// para ele. Daí um índice publicado junto do site.
//
// Como o índice é publicado num repositório público, cada registro fica cifrado
// com AES-GCM usando uma chave derivada dos próprios 16 dígitos. Quem tem a
// chave em mãos abre o seu registro; quem baixa o arquivo vê apenas blocos
// opacos, sem nome de paciente nem de médico.
//
// Dentro do registro cifrado vai o token assinado, inteiro. Ou seja: descobrir
// a chave de alguém revela aquele atestado, mas não permite forjar nenhum —
// forjar continua exigindo a chave privada de assinatura.

import { deBase64url, paraBase64url } from './token.js';

export const DIGITOS_CHAVE = 16;

// Custo de derivação. Alto de propósito: é o que torna inviável varrer o espaço
// de 10^16 chaves contra o arquivo publicado. Medido em ~125 ms por tentativa
// no navegador — imperceptível para quem valida uma vez, proibitivo para quem
// quer testar bilhões.
//
// O valor efetivo de cada índice fica gravado no próprio arquivo, então mudar
// esta constante não invalida registros já publicados.
export const ITERACOES_PADRAO = 600000;

// --- Formato da chave ----------------------------------------------------

/** Deixa só os dígitos: aceita a chave com ou sem hífens, com ou sem espaços. */
export function normalizarChave(texto) {
  return String(texto ?? '').replace(/\D/g, '').slice(0, DIGITOS_CHAVE);
}

/** 1234567890123456 -> 1234-5678-9012-3456 */
export function formatarChave(texto) {
  return normalizarChave(texto).replace(/(\d{4})(?=\d)/g, '$1-');
}

export function chaveCompleta(texto) {
  return normalizarChave(texto).length === DIGITOS_CHAVE;
}

/**
 * Sorteia uma chave nova. Usa amostragem por rejeição em vez de `% 10` direto
 * para que os dígitos saiam uniformes — 256 não é múltiplo de 10, e o resto
 * enviesaria 0..5 contra 6..9.
 */
export function gerarChave() {
  const digitos = [];
  const buffer = new Uint8Array(32);
  while (digitos.length < DIGITOS_CHAVE) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= 250) continue;            // 250 = 25 * 10, descarta a sobra
      digitos.push(byte % 10);
      if (digitos.length === DIGITOS_CHAVE) break;
    }
  }
  return digitos.join('');
}

// --- Derivação -----------------------------------------------------------

// De uma passada de PBKDF2 saem 44 bytes: 12 viram o identificador do registro
// no índice e 32 viram a chave AES. Derivar o identificador junto (em vez de um
// hash rápido da chave) é o que impede varrer o índice de graça.
async function derivar(digitos, kdf) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(digitos), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: deBase64url(kdf.salt),
      iterations: kdf.iteracoes,
      hash: 'SHA-256',
    },
    base,
    44 * 8
  );
  const dk = new Uint8Array(bits);
  return { id: paraBase64url(dk.slice(0, 12)), chaveAes: dk.slice(12, 44) };
}

// --- Índice --------------------------------------------------------------

/** Estrutura de um índice recém-criado, com sal aleatório. */
export function indiceVazio() {
  return {
    v: 1,
    kdf: {
      alg: 'PBKDF2-SHA256',
      iteracoes: ITERACOES_PADRAO,
      salt: paraBase64url(crypto.getRandomValues(new Uint8Array(16))),
    },
    registros: {},
  };
}

/**
 * Cifra `conteudo` sob a chave de 16 dígitos e devolve o par
 * identificador/valor para gravar em `indice.registros`.
 */
export async function criarRegistro(digitos, conteudo, kdf) {
  const { id, chaveAes } = await derivar(normalizarChave(digitos), kdf);
  const aes = await crypto.subtle.importKey('raw', chaveAes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(conteudo))
  );

  // O vetor de inicialização viaja junto, na frente do texto cifrado.
  const juntos = new Uint8Array(iv.length + cifrado.length);
  juntos.set(iv);
  juntos.set(cifrado, iv.length);
  return { id, valor: paraBase64url(juntos) };
}

/**
 * Procura e decifra o registro correspondente à chave.
 * @returns {Promise<string|null>} o conteúdo, ou null se a chave não existe no
 *          índice (que é o mesmo resultado de uma chave simplesmente errada —
 *          de propósito: não há como distinguir os dois casos de fora).
 */
export async function abrirRegistro(digitos, indice) {
  const { id, chaveAes } = await derivar(normalizarChave(digitos), indice.kdf);
  const valor = indice.registros?.[id];
  if (!valor) return null;

  const bytes = deBase64url(valor);
  const aes = await crypto.subtle.importKey('raw', chaveAes, 'AES-GCM', false, ['decrypt']);
  try {
    const claro = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) }, aes, bytes.slice(12)
    );
    return new TextDecoder().decode(claro);
  } catch {
    // A autenticação do AES-GCM falhou: registro corrompido ou adulterado.
    return null;
  }
}
