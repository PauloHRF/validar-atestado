// Formato do token de atestado e as operações de assinatura/verificação.
//
// Um token é `base64url(payload JSON) + "." + base64url(assinatura)`.
// A assinatura é ECDSA P-256 com SHA-256, feita sobre os bytes exatos do
// payload que trafegam no token — não há reserialização na verificação, então
// não existe problema de canonicalização.
//
// Todo o dado do atestado vive dentro do token. Nada é armazenado no servidor:
// o papel que a pessoa tem em mãos É o banco de dados.

export const VERSAO_FORMATO = 1;

// Campos do payload, em ordem de exibição. `chave` é a sigla usada no token
// (curta, para o QR não crescer); `rotulo` é o que aparece na tela.
//
// `max` existe porque cada caractere aqui vira ~1,4 caractere no token e o QR
// ganha módulos junto — sem limite, um nome muito longo produz um QR denso
// demais para ser lido de um papel.
//
// A entidade emissora não é um campo: ela vem dos metadados da chave que
// assinou, em chaves-publicas.json. Assim ela não pode ser forjada nem por
// quem preenche o formulário, e não ocupa espaço no QR.
// Só estes três campos existem, e é de propósito: o que não está aqui não é
// apenas escondido da tela — não entra no token, logo não entra no QR. Campo
// carregado mas não exibido seria o pior dos dois mundos, porque continuaria
// legível para quem decodificasse o código.
//
// Em particular, não há CID: é o dado mais sensível de um atestado, e período
// ou comparecimento normalmente já cumprem a finalidade de quem confere.
export const CAMPOS = [
  { chave: 'pac',  rotulo: 'Paciente',         obrigatorio: true, max: 45 },
  { chave: 'prof', rotulo: 'Médico',           obrigatorio: true, max: 45 },
  { chave: 'em',   rotulo: 'Data da consulta', obrigatorio: true, tipo: 'data' },
];

const ALGORITMO = { name: 'ECDSA', namedCurve: 'P-256' };
const ASSINATURA = { name: 'ECDSA', hash: 'SHA-256' };

// --- base64url -----------------------------------------------------------

export function paraBase64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function deBase64url(texto) {
  const b64 = texto.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- Chaves --------------------------------------------------------------

export async function gerarParDeChaves() {
  const par = await crypto.subtle.generateKey(ALGORITMO, true, ['sign', 'verify']);
  return {
    privadaJwk: await crypto.subtle.exportKey('jwk', par.privateKey),
    publicaJwk: await crypto.subtle.exportKey('jwk', par.publicKey),
  };
}

/**
 * Importa a chave privada. `extraivel = false` permite guardar o CryptoKey no
 * IndexedDB sem que o material da chave possa ser lido de volta pelo JS.
 */
export function importarChavePrivada(jwk, extraivel = false) {
  return crypto.subtle.importKey('jwk', jwk, ALGORITMO, extraivel, ['sign']);
}

/**
 * Transforma o conteúdo de chaves-publicas.json no registro usado por
 * `verificarToken`. Chaves inválidas são ignoradas em vez de derrubar a página:
 * uma entrada corrompida não pode impedir a validação das demais.
 */
export async function carregarChaves(json) {
  const registro = {};
  for (const [kid, entrada] of Object.entries(json ?? {})) {
    try {
      registro[kid] = {
        chave: await importarChavePublica(entrada.jwk),
        entidade: entrada.entidade,
        criada_em: entrada.criada_em,
      };
    } catch (e) {
      console.warn(`Chave pública "${kid}" ignorada: ${e.message}`);
    }
  }
  return registro;
}

export function importarChavePublica(jwk) {
  const { d, ...publica } = jwk;   // aceita um JWK privado por engano sem vazar `d`
  return crypto.subtle.importKey('jwk', { ...publica, key_ops: ['verify'] }, ALGORITMO, true, ['verify']);
}

// --- Emissão -------------------------------------------------------------

/**
 * Assina os dados do atestado e devolve o token.
 * @param {object} dados      campos do atestado (ver CAMPOS)
 * @param {CryptoKey} chavePrivada
 * @param {string} kid        identificador da chave, para permitir rotação
 */
export async function emitirToken(dados, chavePrivada, kid) {
  const payload = { v: VERSAO_FORMATO, k: kid };
  for (const { chave } of CAMPOS) {
    const valor = dados[chave];
    if (valor === undefined || valor === null || valor === '') continue;
    payload[chave] = typeof valor === 'string' ? valor.trim() : valor;
  }

  for (const campo of CAMPOS) {
    const valor = payload[campo.chave];
    if (campo.obrigatorio && !valor) {
      throw new Error(`Campo obrigatório ausente: ${campo.rotulo}`);
    }
    if (campo.max && typeof valor === 'string' && valor.length > campo.max) {
      throw new Error(`${campo.rotulo}: máximo de ${campo.max} caracteres (tem ${valor.length}).`);
    }
  }

  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const assinatura = new Uint8Array(await crypto.subtle.sign(ASSINATURA, chavePrivada, bytes));
  return `${paraBase64url(bytes)}.${paraBase64url(assinatura)}`;
}

// --- Verificação ---------------------------------------------------------

/**
 * Verifica um token contra o registro de chaves públicas.
 * @param {string} token
 * @param {Record<string, {chave: CryptoKey, entidade?: string, criada_em?: string}>} chavesPorId
 * @returns {Promise<{valido: boolean, payload?: object, kid?: string,
 *                    entidade?: string, erro?: string}>}
 */
export async function verificarToken(token, chavesPorId) {
  const limpo = String(token ?? '').trim();
  if (!limpo) return { valido: false, erro: 'Nenhum código informado.' };

  const partes = limpo.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) {
    return { valido: false, erro: 'O código não tem o formato esperado.' };
  }

  let bytes, assinatura, payload;
  try {
    bytes = deBase64url(partes[0]);
    assinatura = deBase64url(partes[1]);
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { valido: false, erro: 'O código está corrompido ou incompleto.' };
  }

  if (payload.v !== VERSAO_FORMATO) {
    return { valido: false, erro: `Formato de código não reconhecido (versão ${payload.v}).` };
  }

  const registro = chavesPorId[payload.k];
  if (!registro) {
    return { valido: false, erro: 'O código foi assinado por uma chave desconhecida.' };
  }

  const ok = await crypto.subtle.verify(ASSINATURA, registro.chave, assinatura, bytes);
  if (!ok) {
    return { valido: false, erro: 'A assinatura não confere — o documento foi alterado ou é falso.' };
  }

  return { valido: true, payload, kid: payload.k, entidade: registro.entidade };
}

// --- Apresentação --------------------------------------------------------

export function formatarData(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso ?? '');
}

/** Converte o payload verificado em pares rótulo/valor prontos para exibir. */
export function camposParaExibir(payload) {
  return CAMPOS
    .filter(({ chave }) => payload[chave] !== undefined && payload[chave] !== '')
    .map((campo) => ({
      rotulo: campo.rotulo,
      valor: campo.tipo === 'data' ? formatarData(payload[campo.chave]) : String(payload[campo.chave]),
      sensivel: !!campo.sensivel,
    }));
}
