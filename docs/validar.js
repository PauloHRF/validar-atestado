// Página pública de verificação.
//
// Fluxo: a chave de 16 dígitos deriva o identificador e a chave AES do registro
// (PBKDF2), abre o registro cifrado do índice, e o que sai de lá dentro é o
// token assinado — que só então é conferido contra a chave pública.
//
// Ou seja, há duas barreiras independentes: sem os 16 dígitos não se abre o
// registro, e sem a chave privada não se produz um token que passe na
// conferência de assinatura.
//
// Nada é enviado a lugar nenhum: o índice e as chaves públicas são baixados uma
// vez, e todo o resto acontece dentro do navegador.

import { abrirRegistro, chaveCompleta, formatarChave, normalizarChave } from './lib/indice.js';
import { camposParaExibir, carregarChaves, verificarToken } from './lib/token.js';

const $ = (id) => document.getElementById(id);

let chaves = null;
let indice = null;
let ocupado = false;

// --- Inicialização -------------------------------------------------------

async function iniciar() {
  try {
    // `no-store` evita que o navegador sirva dados defasados depois de uma
    // emissão ou de uma rotação de chaves.
    const opcoes = { cache: 'no-store' };
    const [respChaves, respIndice] = await Promise.all([
      fetch('chaves-publicas.json', opcoes),
      fetch('atestados.json', opcoes),
    ]);
    if (!respChaves.ok) throw new Error(`chaves-publicas.json: HTTP ${respChaves.status}`);
    if (!respIndice.ok) throw new Error(`atestados.json: HTTP ${respIndice.status}`);

    chaves = await carregarChaves(await respChaves.json());
    indice = await respIndice.json();
    if (Object.keys(chaves).length === 0) throw new Error('nenhuma chave pública utilizável');
    if (!indice?.kdf?.salt) throw new Error('índice de atestados sem parâmetros de derivação');
  } catch (e) {
    $('carregando').classList.add('oculto');
    $('falha-chaves').classList.remove('oculto');
    $('falha-chaves-detalhe').textContent = `Detalhe técnico: ${e.message}`;
    return;
  }

  $('carregando').classList.add('oculto');
  $('tela-consulta').classList.remove('oculto');

  $('form-consulta').addEventListener('submit', (ev) => {
    ev.preventDefault();
    verificarDaCaixa();
  });
  $('codigo').addEventListener('input', aoDigitar);
  $('btn-nova').addEventListener('click', novaConsulta);
  $('btn-imprimir').addEventListener('click', () => window.print());

  // A chave chega no fragmento (#) e não na query string: o fragmento nunca é
  // enviado ao servidor, então não entra em log nem em cabeçalho Referer.
  window.addEventListener('hashchange', verificarDoEndereco);
  await verificarDoEndereco();
}

// --- Máscara do campo ----------------------------------------------------

function aoDigitar(ev) {
  const campo = ev.target;
  // Conta quantos dígitos existiam antes do cursor para reposicioná-lo depois
  // que os hífens forem reinseridos.
  const digitosAntes = normalizarChave(campo.value.slice(0, campo.selectionStart)).length;
  campo.value = formatarChave(campo.value);

  let posicao = 0, vistos = 0;
  while (posicao < campo.value.length && vistos < digitosAntes) {
    if (/\d/.test(campo.value[posicao])) vistos++;
    posicao++;
  }
  campo.setSelectionRange(posicao, posicao);
  $('erro-entrada').textContent = '';
}

async function verificarDoEndereco() {
  const bruto = decodeURIComponent(location.hash.slice(1)).trim();
  if (!bruto) return;
  $('codigo').value = formatarChave(bruto);
  await mostrarResultado(bruto);
}

async function verificarDaCaixa() {
  const digitos = normalizarChave($('codigo').value);
  if (!digitos) {
    esconderFaixa();
    $('erro-entrada').textContent = 'Informe a chave de validação.';
    $('codigo').focus();
    return;
  }
  if (!chaveCompleta(digitos)) {
    esconderFaixa();
    $('erro-entrada').textContent = `A chave tem 16 dígitos — faltam ${16 - digitos.length}.`;
    $('codigo').focus();
    return;
  }
  await mostrarResultado(digitos);
}

// --- Faixa de status -----------------------------------------------------

function mostrarFaixa(tipo, texto) {
  const faixa = $('faixa');
  faixa.classList.remove('oculto', 'ok', 'erro');
  faixa.classList.add(tipo);
  $('faixa-icone').textContent = tipo === 'ok' ? '✓' : '!';
  $('faixa-texto').textContent = texto;
}

const esconderFaixa = () => $('faixa').classList.add('oculto');

// --- Verificação ---------------------------------------------------------

function mostrarFalha(motivo) {
  $('dados').replaceChildren();
  $('tela-resultado').classList.add('oculto');
  $('tela-consulta').classList.remove('oculto');
  $('btn-nova').classList.add('oculto');
  $('topo-vazio').classList.remove('oculto');
  mostrarFaixa('erro', 'Não foi possível validar');
  $('erro-entrada').textContent = motivo;
  window.scrollTo({ top: 0 });
}

async function mostrarResultado(entrada) {
  const digitos = normalizarChave(entrada);
  if (!chaveCompleta(digitos)) {
    mostrarFalha('A chave de validação tem 16 dígitos.');
    return;
  }
  if (ocupado) return;

  // A derivação é lenta de propósito (PBKDF2), então avisa e trava o botão.
  ocupado = true;
  $('btn-verificar').disabled = true;
  $('btn-verificar').textContent = 'Verificando…';
  try {
    const token = await abrirRegistro(digitos, indice);
    if (token === null) {
      mostrarFalha('Chave de validação não encontrada. Confira os 16 dígitos.');
      return;
    }

    // O registro abriu, mas a assinatura ainda precisa conferir: é isso que
    // impede que um índice adulterado produza um documento aceito.
    const resultado = await verificarToken(token, chaves);
    if (!resultado.valido) {
      mostrarFalha(resultado.erro);
      return;
    }

    const emissor = resultado.entidade ? ` por ${resultado.entidade}` : '';
    $('resumo').textContent =
      `Documento assinado digitalmente${emissor}. Os dados abaixo não foram alterados desde a emissão.`;
    preencherDados(resultado.payload);

    $('erro-entrada').textContent = '';
    $('tela-consulta').classList.add('oculto');
    $('tela-resultado').classList.remove('oculto');
    $('btn-nova').classList.remove('oculto');
    $('topo-vazio').classList.add('oculto');
    mostrarFaixa('ok', 'Validação concluída');
    window.scrollTo({ top: 0 });
  } finally {
    ocupado = false;
    $('btn-verificar').disabled = false;
    $('btn-verificar').textContent = 'Próximo';
  }
}

function preencherDados(payload) {
  const dl = $('dados');
  dl.replaceChildren();
  for (const campo of camposParaExibir(payload)) {
    const linha = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = `${campo.rotulo}:`;
    const dd = document.createElement('dd');
    // textContent, nunca innerHTML: o conteúdo do token não vira markup.
    dd.textContent = campo.valor;
    linha.append(dt, dd);
    dl.append(linha);
  }
}

// --- Nova consulta -------------------------------------------------------

function novaConsulta() {
  $('dados').replaceChildren();
  $('codigo').value = '';
  $('erro-entrada').textContent = '';
  $('tela-resultado').classList.add('oculto');
  $('tela-consulta').classList.remove('oculto');
  $('btn-nova').classList.add('oculto');
  $('topo-vazio').classList.remove('oculto');
  esconderFaixa();

  // Tira a chave do endereço para não ficar visível na barra nem no histórico.
  history.replaceState(null, '', location.pathname + location.search);

  window.scrollTo({ top: 0 });
  $('codigo').focus();
}

iniciar();
