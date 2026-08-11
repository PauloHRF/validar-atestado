// Ferramenta interna de emissão.
//
// A chave privada é importada como CryptoKey NÃO-EXTRAÍVEL e guardada no
// IndexedDB deste navegador. A partir daí nem este código consegue ler o
// material da chave — apenas pedir ao navegador que assine com ela.

import { criarRegistro, formatarChave, gerarChave, indiceVazio } from '../lib/indice.js';
import { qrToSVG } from '../lib/qr.js';
import { emitirToken } from '../lib/token.js';

const $ = (id) => document.getElementById(id);

const BD_NOME = 'atestados-emissor';
const BD_STORE = 'chaves';
const BD_ID = 'ativa';
const LS_URL = 'atestados:url-base';

let chaveAtiva = null;   // { kid, chave: CryptoKey }
let ultimo = null;       // { chave, url, paciente }
let indice = null;       // conteúdo de atestados.json com as emissões desta sessão
let pendentes = 0;       // emitidos aqui e ainda não publicados no repositório

// --- IndexedDB -----------------------------------------------------------

function abrirBanco() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BD_NOME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(BD_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transacionar(modo, acao) {
  return abrirBanco().then((bd) => new Promise((resolve, reject) => {
    const tx = bd.transaction(BD_STORE, modo);
    const req = acao(tx.objectStore(BD_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => bd.close();
  }));
}

const lerChaveGuardada  = () => transacionar('readonly',  (s) => s.get(BD_ID));
const gravarChave       = (v) => transacionar('readwrite', (s) => s.put(v, BD_ID));
const apagarChave       = () => transacionar('readwrite', (s) => s.delete(BD_ID));

// --- Estado da chave -----------------------------------------------------

function pintarStatusChave() {
  const carregada = !!chaveAtiva;
  $('status-chave').textContent = carregada
    ? `Chave "${chaveAtiva.kid}" carregada neste navegador. Pronto para emitir.`
    : 'Nenhuma chave carregada. Selecione o arquivo da chave privada para poder emitir.';
  $('area-carregar').classList.toggle('oculto', carregada);
  $('btn-esquecer').classList.toggle('oculto', !carregada);
  $('btn-emitir').disabled = !carregada;
}

async function restaurarChave() {
  try {
    const guardada = await lerChaveGuardada();
    // O IndexedDB devolve o CryptoKey pelo algoritmo de clonagem estruturada,
    // sem nunca expor os bytes da chave ao JavaScript.
    if (guardada?.chave instanceof CryptoKey) chaveAtiva = guardada;
  } catch (e) {
    console.warn('Não foi possível ler a chave guardada:', e);
  }
  pintarStatusChave();
}

async function carregarDoArquivo(arquivo) {
  $('erro-chave').textContent = '';
  try {
    const conteudo = JSON.parse(await arquivo.text());
    const kid = conteudo.kid;
    const jwk = conteudo.jwk ?? conteudo;
    if (!kid) throw new Error('o arquivo não tem o campo "kid".');
    if (!jwk?.d) throw new Error('o arquivo não contém uma chave privada.');

    // extraivel = false: a partir daqui a chave não pode mais ser exportada.
    const { importarChavePrivada } = await import('../lib/token.js');
    const chave = await importarChavePrivada(jwk, false);

    chaveAtiva = { kid, chave };
    await gravarChave(chaveAtiva);
    pintarStatusChave();
  } catch (e) {
    $('erro-chave').textContent = `Não foi possível carregar a chave: ${e.message}`;
  }
}

// --- Emissão -------------------------------------------------------------

function urlBase() {
  const bruto = $('url-base').value.trim();
  if (!bruto) throw new Error('Informe o endereço da página de validação.');
  let u;
  try {
    u = new URL(bruto);
  } catch {
    throw new Error('O endereço da página de validação não é uma URL válida.');
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error('Use um endereço https:// — o QR impresso vai durar anos.');
  }
  return u.origin + u.pathname.replace(/\/*$/, '/');
}

/**
 * Carrega o índice publicado uma única vez, para que as emissões desta sessão
 * sejam acrescentadas ao que já existe em vez de substituí-lo. Se o arquivo
 * ainda não existe, começa um novo com sal aleatório.
 */
async function garantirIndice() {
  if (indice) return;
  const alvo = new URL('../atestados.json', location.href);
  try {
    const resposta = await fetch(alvo, { cache: 'no-store' });
    if (resposta.ok) {
      const lido = await resposta.json();
      if (lido?.kdf?.salt && lido.registros) {
        indice = lido;
        return;
      }
      throw new Error('arquivo existente não tem o formato esperado');
    }
    if (resposta.status !== 404) throw new Error(`HTTP ${resposta.status}`);
    indice = indiceVazio();
  } catch (e) {
    throw new Error(
      `Não foi possível ler atestados.json (${e.message}). ` +
      `Emitir agora criaria um índice novo e apagaria os registros já publicados.`
    );
  }
}

function baixarIndice() {
  const blob = new Blob([JSON.stringify(indice, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'atestados.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function coletarDados() {
  return {
    pac: $('f-pac').value.trim(),
    prof: $('f-prof').value.trim(),
    em: $('f-em').value,
  };
}

async function emitir(ev) {
  ev.preventDefault();
  $('erro-form').textContent = '';
  $('feedback-copia').textContent = '';

  if (!chaveAtiva) {
    $('erro-form').textContent = 'Carregue a chave privada antes de emitir.';
    return;
  }

  let base, token, chave, registro;
  try {
    base = urlBase();
    localStorage.setItem(LS_URL, base);
    token = await emitirToken(coletarDados(), chaveAtiva.chave, chaveAtiva.kid);
    await garantirIndice();

    // Sorteia até cair numa chave livre. Com 10^16 possibilidades a primeira
    // tentativa basta na prática, mas colidir silenciosamente sobrescreveria
    // um atestado já emitido.
    do {
      chave = gerarChave();
      registro = await criarRegistro(chave, token, indice.kdf);
    } while (indice.registros[registro.id]);

    indice.registros[registro.id] = registro.valor;
    pendentes++;
  } catch (e) {
    $('erro-form').textContent = e.message;
    return;
  }

  const url = `${base}#${formatarChave(chave)}`;
  const svg = qrToSVG(url, { ecLevel: 'M' });

  ultimo = { chave: formatarChave(chave), url, paciente: $('f-pac').value.trim() };

  $('chave-grande').textContent = ultimo.chave;
  $('qr').innerHTML = svg;   // markup gerado localmente por qrToSVG, sem entrada externa
  $('selo-url').textContent = base.replace(/^https:\/\//, '');
  $('selo-chave').textContent = ultimo.chave;
  $('publicar').classList.remove('oculto');
  $('info-indice').textContent =
    `O arquivo contém ${Object.keys(indice.registros).length} registro(s), ` +
    `incluindo ${pendentes} emitido(s) nesta sessão e ainda não publicado(s).`;

  // Quantos módulos o QR tem determina o tamanho mínimo em que ele ainda é
  // legível no papel: cerca de 0,4 mm por módulo para leitura por celular.
  // O viewBox inclui a zona de silêncio (4 módulos de cada lado), que também
  // precisa ser impressa — por isso o mínimo é calculado sobre ele.
  const comZonaDeSilencio = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
  const modulos = comZonaDeSilencio - 8;
  const minimoMm = Math.ceil(comZonaDeSilencio * 0.4);
  $('info-qr').textContent =
    `QR de ${modulos}×${modulos} módulos: imprima o bloco com pelo menos ${minimoMm} mm de lado, ` +
    `margem branca incluída (o selo já usa 42 mm).`;

  $('saida').classList.remove('oculto');
  $('saida').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// --- Ações da saída ------------------------------------------------------

async function copiar(texto, rotulo) {
  try {
    await navigator.clipboard.writeText(texto);
    $('feedback-copia').textContent = `${rotulo} copiado.`;
  } catch {
    $('feedback-copia').textContent = `Não foi possível copiar automaticamente — use o bloco "Ver código completo".`;
  }
}

function baixarSVG() {
  const svg = $('qr').innerHTML;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `qr-${(ultimo?.paciente || 'atestado').replace(/[^\w-]/g, '_')}.svg`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function limparFormulario() {
  for (const id of ['f-pac', 'f-prof']) $(id).value = '';
  $('f-em').value = new Date().toISOString().slice(0, 10);
  $('saida').classList.add('oculto');
  // `publicar` continua visível de propósito: pode haver emissão pendente de
  // download, e escondê-la faria perder registros sem aviso.
  $('erro-form').textContent = '';
  atualizarContadores();
  $('f-pac').focus();
}

function atualizarContadores() {
  $('cont-pac').textContent = $('f-pac').value.length;
  $('cont-prof').textContent = $('f-prof').value.length;
}

// --- Inicialização -------------------------------------------------------

$('url-base').value = localStorage.getItem(LS_URL) ?? '';
$('f-em').value = new Date().toISOString().slice(0, 10);

$('arquivo-chave').addEventListener('change', (ev) => {
  const arquivo = ev.target.files?.[0];
  if (arquivo) carregarDoArquivo(arquivo);
  ev.target.value = '';
});

$('btn-esquecer').addEventListener('click', async () => {
  await apagarChave();
  chaveAtiva = null;
  pintarStatusChave();
});

$('f-pac').addEventListener('input', atualizarContadores);
$('f-prof').addEventListener('input', atualizarContadores);

$('form').addEventListener('submit', emitir);
$('btn-limpar-form').addEventListener('click', limparFormulario);
$('btn-imprimir').addEventListener('click', () => window.print());
$('btn-copiar-link').addEventListener('click', () => copiar(ultimo.url, 'Link'));
$('btn-copiar-chave').addEventListener('click', () => copiar(ultimo.chave, 'Chave'));
$('btn-baixar-svg').addEventListener('click', baixarSVG);
$('btn-baixar-indice').addEventListener('click', baixarIndice);
$('btn-testar').addEventListener('click', () => window.open(ultimo.url, '_blank', 'noopener'));

// Fechar a aba com emissão pendente perde o registro: a chave existe impressa,
// mas o índice que a reconhece nunca chegou ao repositório.
window.addEventListener('beforeunload', (ev) => {
  if (pendentes > 0) ev.preventDefault();
});

restaurarChave();
