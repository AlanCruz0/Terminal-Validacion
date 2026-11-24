// Control de Acceso · Terminal de validación (PWA)
// Orquesta la UI: búsqueda predictiva, validación con pantalla completa de color,
// bitácora, configuración, importación/exportación y ciclo de vida del Service Worker.

import * as db from './db.js';
import { generateGuests, CATEGORY_LABELS } from './seed.js';
import {
  escapeHtml, highlight, highlightPrefix, initials, formatTime, formatDateTime, formatNumber,
  formatBytes, timeAgo, toCSV, parseCSV, downloadFile, looksLikeFolio, normalizeFolio, normalize,
  percentile, stamp,
} from './utils.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DEFAULT_SETTINGS = { eventName: 'Gala Fin de Año 2026', terminalId: '', autoDismiss: 2500, sound: true, vibrate: true };
const DEFAULT_DEMO_SIZE = 10000;
const SEARCH_LIMIT = 40;
const VIEWS = ['terminal', 'log', 'data'];

const RESULT_META = {
  granted: { title: 'Acceso permitido', label: 'Permitido', tone: 'ok' },
  duplicate: { title: 'Ya ingresó', label: 'Ya ingresó', tone: 'err' },
  denied: { title: 'Acceso denegado', label: 'Denegado', tone: 'err' },
  not_found: { title: 'Folio no registrado', label: 'No registrado', tone: 'err' },
  undo: { title: 'Entrada anulada', label: 'Anulado', tone: 'muted' },
  reset: { title: 'Entradas reiniciadas', label: 'Reinicio', tone: 'muted' },
};

const LOG_FILTERS = {
  all: null,
  granted: ['granted'],
  duplicate: ['duplicate'],
  rejected: ['denied', 'not_found'],
  undo: ['undo', 'reset'],
};

const SOURCE_LABELS = { manual: 'Búsqueda', search: 'Búsqueda', scan: 'Lector/folio', sim: 'Simulación', undo: 'Anulación', admin: 'Administración' };

const OVERLAY_ICONS = {
  granted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.3 4.3L19 7.2"/></svg>',
  duplicate: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/></svg>',
  denied: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>',
  not_found: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.5a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.5v.3"/><path d="M12 16.6v.1"/></svg>',
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  view: 'terminal',
  search: { seq: 0, query: '', data: null, active: 0, navigated: false, pending: Promise.resolve() },
  validating: false,
  overlayTimer: 0,
  lastGrant: null,
  logFilter: 'all',
  installPrompt: null,
  swRegistration: null,
  updateRequested: false,
  audio: null,
  lastLogId: 0,
};

const els = {};
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('control-acceso') : null;

// =====================================================================================
// Arranque
// =====================================================================================

init();

async function init() {
  cacheElements();
  bindEvents();
  updateNetwork();
  startClock();
  registerServiceWorker();

  try {
    await db.openDB();
    setLoader('Leyendo configuración', 0.08);
    const saved = await db.getMeta('settings', {});
    state.settings = { ...DEFAULT_SETTINGS, ...saved };
    if (!state.settings.terminalId) {
      state.settings.terminalId = `T-${String(Math.floor(Math.random() * 90) + 10)}`;
      await db.setMeta('settings', state.settings);
    }
    applySettings();

    const dataset = await db.getMeta('dataset');
    if (!dataset) await loadDemoData(DEFAULT_DEMO_SIZE);
    // Instalada como app: pedimos que el navegador no borre la base local por falta de espacio.
    if (matchMedia('(display-mode: standalone)').matches) requestPersistence(true);

    await Promise.all([refreshStats(), refreshRecent(true)]);
    setUI('idle');
    handleLaunchParams();
  } catch (err) {
    console.error(err);
    setLoader(`No se pudo iniciar la base de datos local: ${err.message}`, 1);
    $('.loader-title').textContent = 'Error al iniciar';
  }
}

function cacheElements() {
  Object.assign(els, {
    input: $('#search'),
    results: $('#results'),
    resultsMore: $('#results-more'),
    perf: $('#search-perf'),
    hint: $('#search-hint'),
    empty: $('#empty-state'),
    emptyTitle: $('#empty-title'),
    emptyText: $('#empty-text'),
    recent: $('#recent'),
    recentEmpty: $('#recent-empty'),
    overlay: $('#overlay'),
    overlayIcon: $('#overlay-icon'),
    overlayTitle: $('#overlay-title'),
    overlayName: $('#overlay-name'),
    overlayDetail: $('#overlay-detail'),
    overlayMeta: $('#overlay-meta'),
    overlayUndo: $('#overlay-undo'),
    overlayClose: $('#overlay-close'),
    overlayBar: $('#overlay-timer-bar'),
    toast: $('#toast'),
    logBody: $('#log-body'),
    logSummary: $('#log-summary'),
    logFilter: $('#log-filter'),
    settingsForm: $('#settings-form'),
  });
}

function bindEvents() {
  // ----- búsqueda
  els.input.addEventListener('input', () => runSearch(els.input.value));
  els.input.addEventListener('keydown', onSearchKeydown);
  els.results.addEventListener('click', (e) => {
    const item = e.target.closest('.result');
    if (item) validate(item.dataset.folio, 'search');
  });
  els.results.addEventListener('pointermove', (e) => {
    const item = e.target.closest('.result');
    if (item && Number(item.dataset.index) !== state.search.active) setActive(Number(item.dataset.index), false);
  });
  $('#clear-search').addEventListener('click', () => {
    clearSearch();
    els.input.focus();
  });
  $('#sim-scan').addEventListener('click', simulateScan);

  // ----- overlay de resultado
  els.overlayClose.addEventListener('click', hideOverlay);
  els.overlayUndo.addEventListener('click', undoLastGrant);
  els.overlay.addEventListener('click', (e) => {
    if (e.target === els.overlay || e.target.closest('.overlay-inner') && !e.target.closest('button')) hideOverlay();
  });
  els.overlay.addEventListener('pointerover', (e) => {
    if (e.target.closest('.overlay-actions')) pauseOverlayTimer();
  });

  document.addEventListener('keydown', onGlobalKeydown);

  // ----- navegación
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = VIEWS.indexOf(state.view);
    const next = VIEWS[(i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
    switchView(next);
    $(`#tab-${next}`).focus();
  });
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.goto)));

  // ----- bitácora
  els.logFilter.addEventListener('change', () => {
    state.logFilter = els.logFilter.value;
    refreshLog();
  });
  $('#export-log-csv').addEventListener('click', () => exportLog('csv'));
  $('#export-log-json').addEventListener('click', () => exportLog('json'));

  // ----- datos
  els.settingsForm.addEventListener('submit', (e) => e.preventDefault());
  els.settingsForm.addEventListener('change', saveSettings);
  $('#regen-btn').addEventListener('click', regenerateDemo);
  $('#import-file').addEventListener('change', (e) => importFile(e.target.files?.[0]));
  $('#template-btn').addEventListener('click', downloadTemplate);
  $('#export-guests').addEventListener('click', exportGuests);
  $('#reset-checkins').addEventListener('click', resetCheckIns);
  $('#persist-btn').addEventListener('click', () => requestPersistence(false));
  $('#bench-btn').addEventListener('click', runBenchmark);

  // ----- red
  window.addEventListener('online', updateNetwork);
  window.addEventListener('offline', updateNetwork);

  // ----- instalación
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('#install-btn').hidden = false;
  });
  $('#install-btn').addEventListener('click', async () => {
    const prompt = state.installPrompt;
    if (!prompt) return;
    state.installPrompt = null;
    $('#install-btn').hidden = true;
    prompt.prompt();
    await prompt.userChoice.catch(() => null);
  });
  window.addEventListener('appinstalled', () => {
    $('#install-btn').hidden = true;
    toast('Terminal instalada en este dispositivo', 'ok');
  });

  // ----- concurrencia entre pestañas/ventanas
  channel?.addEventListener('message', (e) => onRemoteChange(e.data));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.body.dataset.ui !== 'loading') onRemoteChange({ type: 'refresh' });
  });
}

// =====================================================================================
// Estado de UI
// =====================================================================================

/** Estado visual global: loading | idle | results | empty | validating | granted | duplicate | denied | not_found */
function setUI(name) {
  document.body.dataset.ui = name;
}

function setLoader(text, ratio) {
  $('#loader-detail').textContent = text;
  $('#loader-bar').style.width = `${Math.round(Math.max(0.04, Math.min(1, ratio)) * 100)}%`;
}

function applySettings() {
  const s = state.settings;
  $('#event-name').textContent = s.eventName || 'Control de Acceso';
  $('#terminal-id').textContent = s.terminalId;
  document.title = `${s.eventName || 'Control de Acceso'} · Terminal ${s.terminalId}`;
  const form = els.settingsForm;
  form.eventName.value = s.eventName;
  form.terminalId.value = s.terminalId;
  form.autoDismiss.value = String(s.autoDismiss);
  form.sound.checked = s.sound;
  form.vibrate.checked = s.vibrate;
}

async function saveSettings() {
  const form = els.settingsForm;
  state.settings = {
    eventName: form.eventName.value.trim() || DEFAULT_SETTINGS.eventName,
    terminalId: form.terminalId.value.trim().toUpperCase() || state.settings.terminalId,
    autoDismiss: Number(form.autoDismiss.value),
    sound: form.sound.checked,
    vibrate: form.vibrate.checked,
  };
  await db.setMeta('settings', state.settings);
  applySettings();
  broadcast('settings');
  toast('Configuración guardada', 'ok');
}

function startClock() {
  const clock = $('#clock');
  const tick = () => { clock.textContent = formatTime(Date.now()); };
  tick();
  setInterval(tick, 1000);
}

function updateNetwork() {
  const online = navigator.onLine;
  const pill = $('#net-status');
  pill.className = `pill ${online ? 'pill-online' : 'pill-offline'}`;
  $('#net-label').textContent = online ? 'En línea' : 'Sin conexión · modo local';
  const pwaNet = $('#pwa-net');
  if (pwaNet) pwaNet.textContent = online ? 'En línea' : 'Sin conexión (operando con datos locales)';
  if (document.body.dataset.ui !== 'loading') {
    toast(online ? 'Conexión restablecida. Todo sigue guardado localmente.' : 'Sin conexión: la terminal sigue validando con la base local.', online ? 'ok' : 'info');
  }
}

function switchView(view) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  for (const v of VIEWS) {
    const tab = $(`#tab-${v}`);
    const active = v === view;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(`#view-${v}`).hidden = !active;
  }
  if (view === 'log') refreshLog();
  if (view === 'data') refreshDataPanel();
  if (view === 'terminal') els.input.focus({ preventScroll: true });
  const url = new URL(location.href);
  url.searchParams.set('view', view);
  url.searchParams.delete('action');
  history.replaceState(null, '', url);
}

function handleLaunchParams() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  if (VIEWS.includes(view)) switchView(view);
  else els.input.focus({ preventScroll: true });
  if (params.get('action') === 'simular') {
    switchView('terminal');
    simulateScan();
  }
}

// =====================================================================================
// Búsqueda predictiva
// =====================================================================================

function runSearch(rawQuery) {
  const query = rawQuery.trim();
  const seq = ++state.search.seq;
  state.search.query = query;
  state.search.pending = (async () => {
    if (!query) {
      state.search.data = null;
      renderResults();
      return;
    }
    const t0 = performance.now();
    const data = await db.searchGuests(query, SEARCH_LIMIT);
    const ms = performance.now() - t0;
    if (seq !== state.search.seq) return; // llegó una consulta más nueva: descartamos esta
    state.search.data = { ...data, ms, query };
    state.search.active = 0;
    state.search.navigated = false;
    renderResults();
  })().catch((err) => {
    console.error(err);
    toast(`Error en la búsqueda: ${err.message}`, 'error');
  });
  return state.search.pending;
}

function renderResults() {
  const d = state.search.data;
  const { results: list, input } = els;

  if (!d || d.mode === 'empty') {
    list.innerHTML = '';
    els.resultsMore.hidden = true;
    els.perf.textContent = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    els.empty.hidden = false;
    els.emptyTitle.textContent = 'Listo para validar';
    els.emptyText.innerHTML = 'Escribe un nombre (ej. <span class="mono">gar</span>) o un folio (ej. <span class="mono">1002</span>). Los resultados aparecen mientras escribes, directo desde IndexedDB.';
    if (document.body.dataset.ui !== 'loading') setUI('idle');
    return;
  }

  const plural = d.total === 1 ? 'coincidencia' : 'coincidencias';
  const via = d.mode === 'folio' ? 'clave primaria (folio)' : 'índice multiEntry “tokens”';
  els.perf.textContent = `${formatNumber(d.total)}${d.capped ? '+' : ''} ${plural} · ${d.ms.toFixed(1)} ms · ${via}`;

  if (!d.results.length) {
    list.innerHTML = '';
    els.resultsMore.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    els.empty.hidden = false;
    els.emptyTitle.textContent = 'Sin coincidencias';
    els.emptyText.innerHTML = d.mode === 'folio'
      ? `Ningún folio empieza con <span class="mono">${escapeHtml(d.folio)}</span>. Presiona Enter para registrarlo como intento no válido.`
      : `No hay invitados con “${escapeHtml(d.query)}”. Revisa la ortografía o busca por folio.`;
    setUI('empty');
    return;
  }

  els.empty.hidden = true;
  list.innerHTML = d.results.map((g, i) => resultItem(g, i, d)).join('');
  const shown = d.results.length;
  els.resultsMore.hidden = d.total <= shown;
  els.resultsMore.textContent = `Mostrando ${shown} de ${formatNumber(d.total)}${d.capped ? '+' : ''}. Escribe más letras para afinar.`;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', `opt-${state.search.active}`);
  setUI('results');
}

function categoryKey(category) {
  const key = normalize(category);
  return key in CATEGORY_LABELS ? key : 'general';
}

function categoryLabel(category) {
  const key = normalize(category);
  return CATEGORY_LABELS[key] ?? String(category ?? '');
}

function resultItem(g, i, d) {
  const cat = categoryKey(g.category);
  const name = highlight(g.fullName, d.tokens);
  const folio = d.mode === 'folio' ? highlightPrefix(g.folio, d.folio) : escapeHtml(g.folio);
  const table = g.table != null ? `<span>Mesa ${escapeHtml(g.table)}</span>` : '';
  return `<li id="opt-${i}" class="result" role="option" aria-selected="${i === state.search.active}" data-index="${i}" data-folio="${escapeHtml(g.folio)}" data-status="${escapeHtml(g.status)}">
    <span class="avatar cat-${cat}" aria-hidden="true">${escapeHtml(initials(g.firstName, g.lastName))}</span>
    <span class="result-main">
      <span class="result-name">${name}</span>
      <span class="result-meta"><span class="folio">${folio}</span><span class="badge cat-${cat}">${escapeHtml(categoryLabel(g.category))}</span>${table}</span>
    </span>
    ${statusChip(g)}
  </li>`;
}

function statusChip(g) {
  if (g.status === 'in') return `<span class="chip chip-in">Ingresó ${formatTime(g.checkedInAt)}</span>`;
  if (g.status === 'blocked') return '<span class="chip chip-blocked">Bloqueado</span>';
  return '<span class="chip chip-pending">Pendiente</span>';
}

function setActive(index, byKeyboard) {
  const items = $$('.result', els.results);
  if (!items.length) return;
  state.search.active = index;
  if (byKeyboard) state.search.navigated = true;
  items.forEach((el, i) => el.setAttribute('aria-selected', String(i === index)));
  els.input.setAttribute('aria-activedescendant', `opt-${index}`);
  if (byKeyboard) items[index].scrollIntoView({ block: 'nearest' });
}

function onSearchKeydown(e) {
  const count = state.search.data?.results.length ?? 0;
  if (e.key === 'ArrowDown' && count) {
    e.preventDefault();
    setActive((state.search.active + 1) % count, true);
  } else if (e.key === 'ArrowUp' && count) {
    e.preventDefault();
    setActive((state.search.active - 1 + count) % count, true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    submitSearch();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    clearSearch();
  }
}

/**
 * Enter en el buscador:
 *  - Folio (contiene dígitos): se valida ese folio exacto, como lo haría un lector de códigos.
 *    Si el operador eligió un resultado con ↑↓, se valida el elegido.
 *  - Nombre: se valida solo si hay un único resultado o si el operador eligió uno.
 */
async function submitSearch() {
  const query = els.input.value.trim();
  if (!query || state.validating) return;

  if (looksLikeFolio(query)) {
    const d = state.search.data;
    if (state.search.navigated && d?.query === query && d.results[state.search.active]) {
      validate(d.results[state.search.active].folio, 'search');
    } else {
      validate(normalizeFolio(query), 'scan');
    }
    return;
  }

  if (state.search.query !== query) runSearch(els.input.value);
  await state.search.pending;
  const d = state.search.data;
  const count = d?.results.length ?? 0;
  if (!count) {
    nudge(`Sin coincidencias para “${query}”.`);
  } else if (count === 1 || state.search.navigated) {
    validate(d.results[state.search.active].folio, 'search');
  } else {
    nudge('Hay varias coincidencias: elige con ↑ ↓ o toca al invitado.');
  }
}

function nudge(message) {
  els.hint.textContent = message;
  const box = $('.search-box');
  box.classList.remove('shake');
  void box.offsetWidth;
  box.classList.add('shake');
  clearTimeout(nudge.timer);
  nudge.timer = setTimeout(() => {
    els.hint.textContent = 'Escribe para buscar · ↑ ↓ para elegir · Enter para validar';
  }, 3200);
}

function clearSearch() {
  els.input.value = '';
  state.search.seq++;
  state.search.query = '';
  state.search.data = null;
  state.search.navigated = false;
  renderResults();
}

// =====================================================================================
// Validación de acceso
// =====================================================================================

function context(source) {
  return { terminal: state.settings.terminalId, online: navigator.onLine, source };
}

async function validate(folio, source) {
  if (state.validating) return;
  state.validating = true;
  setUI('validating');
  try {
    const t0 = performance.now();
    const res = await db.checkIn(folio, context(source));
    res.ms = performance.now() - t0;
    state.lastGrant = res.result === 'granted'
      ? { folio: res.guest.folio, at: res.guest.checkedInAt, name: res.guest.fullName }
      : null;
    clearSearch();
    showOverlay(res);
    feedback(res.result);
    afterMutation();
  } catch (err) {
    console.error(err);
    setUI('idle');
    toast(`No se pudo registrar: ${err.message}`, 'error');
  } finally {
    state.validating = false;
  }
}

function showOverlay(res) {
  const { result, guest, entry, previous } = res;
  const meta = RESULT_META[result];
  const o = els.overlay;

  o.dataset.result = result;
  setUI(result);
  els.overlayIcon.innerHTML = OVERLAY_ICONS[result];
  els.overlayTitle.textContent = meta.title;
  els.overlayName.textContent = guest ? guest.fullName : `Folio ${entry.folio}`;

  const parts = [];
  if (guest) {
    parts.push(`Folio ${guest.folio}`, categoryLabel(guest.category));
    if (guest.table != null) parts.push(`Mesa ${guest.table}`);
  }
  let detail = parts.join(' · ');
  if (result === 'duplicate') {
    detail = `Su entrada ya fue registrada a las ${formatTime(previous.at)} (${timeAgo(previous.at)}) en la terminal ${previous.by}.`;
  } else if (result === 'denied') {
    detail = `${guest.blockedReason ?? 'Acceso restringido'} · ${detail}`;
  } else if (result === 'not_found') {
    detail = 'Este folio no existe en la lista de invitados cargada en la terminal.';
  }
  els.overlayDetail.textContent = detail;
  els.overlayMeta.textContent = `${formatTime(entry.ts)} · Terminal ${entry.terminal} · ${entry.online ? 'en línea' : 'sin conexión'} · ${res.ms.toFixed(1)} ms`;
  els.overlayUndo.hidden = result !== 'granted';

  o.hidden = false;
  els.overlayClose.focus({ preventScroll: true });

  // Temporizador de cierre automático (los errores se quedan un poco más en pantalla).
  clearTimeout(state.overlayTimer);
  const bar = els.overlayBar;
  bar.classList.remove('run', 'paused');
  const base = state.settings.autoDismiss;
  bar.parentElement.hidden = !(base > 0);
  if (base > 0) {
    const duration = result === 'granted' ? base : Math.round(base * 1.6);
    bar.style.setProperty('--dur', `${duration}ms`);
    void bar.offsetWidth;
    bar.classList.add('run');
    state.overlayTimer = setTimeout(hideOverlay, duration);
  }
}

function pauseOverlayTimer() {
  if (!state.overlayTimer) return;
  clearTimeout(state.overlayTimer);
  state.overlayTimer = 0;
  els.overlayBar.classList.add('paused');
}

function hideOverlay() {
  clearTimeout(state.overlayTimer);
  state.overlayTimer = 0;
  if (els.overlay.hidden) return;
  els.overlay.hidden = true;
  delete els.overlay.dataset.result;
  setUI(state.search.data?.results.length ? 'results' : 'idle');
  if (state.view === 'terminal') els.input.focus({ preventScroll: true });
}

async function undoLastGrant() {
  const grant = state.lastGrant;
  if (!grant) return;
  state.lastGrant = null;
  const ok = await db.undoCheckIn(grant.folio, grant.at, context('undo'));
  hideOverlay();
  toast(ok ? `Entrada anulada: ${grant.name}` : 'No se pudo anular: el registro cambió en otra terminal.', ok ? 'ok' : 'error');
  afterMutation();
}

function onGlobalKeydown(e) {
  if (!els.overlay.hidden) {
    const onUndo = e.target === els.overlayUndo;
    if (e.key === 'Escape' || ((e.key === 'Enter' || e.key === ' ') && !onUndo)) {
      e.preventDefault();
      hideOverlay();
    } else if (e.key === 'Tab') {
      pauseOverlayTimer();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Un lector de códigos empieza a "teclear" el siguiente folio: cerramos y el carácter cae en el buscador.
      if (state.view !== 'terminal') switchView('terminal');
      hideOverlay();
    }
    return;
  }
  const typing = e.target.closest?.('input, select, textarea');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    switchView('terminal');
    els.input.focus();
  }
}

/** Sonido (Web Audio) + vibración según el resultado. */
function feedback(result) {
  const ok = result === 'granted';
  if (state.settings.vibrate && 'vibrate' in navigator) {
    try { navigator.vibrate(ok ? 70 : [180, 80, 180]); } catch { /* sin soporte */ }
  }
  if (!state.settings.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    state.audio ??= new Ctx();
    const ctx = state.audio;
    const tones = ok
      ? [[880, 0, 0.09, 'sine'], [1320, 0.1, 0.14, 'sine']]
      : result === 'duplicate'
        ? [[392, 0, 0.12, 'square'], [392, 0.18, 0.12, 'square']]
        : [[196, 0, 0.38, 'sawtooth']];
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, start, dur, type] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.03);
    }
  } catch { /* audio no disponible */ }
}

/** Simula a un lector de códigos: escribe un folio (válido, repetido o inexistente) y presiona Enter. */
async function simulateScan() {
  if (state.validating || !els.overlay.hidden) return;
  const roll = Math.random();
  let folio = null;
  if (roll < 0.15) {
    folio = String(900000 + Math.floor(Math.random() * 99999));
  } else if (roll < 0.32) {
    const inside = await db.getFolios('in');
    if (inside.length) folio = inside[Math.floor(Math.random() * inside.length)];
  }
  if (!folio) {
    const [guest] = await db.getRandomGuests(1);
    folio = guest?.folio ?? '100001';
  }
  switchView('terminal');
  els.input.value = '';
  for (const ch of folio) {
    els.input.value += ch;
    runSearch(els.input.value);
    await sleep(28);
  }
  await sleep(140);
  validate(folio, 'sim');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================================
// Refrescos y concurrencia
// =====================================================================================

function afterMutation() {
  refreshStats();
  refreshRecent();
  if (state.view === 'log') refreshLog();
  if (state.view === 'data') refreshDataPanel();
  broadcast('changed');
}

function broadcast(type) {
  channel?.postMessage({ type, from: state.settings.terminalId, at: Date.now() });
}

async function onRemoteChange(msg) {
  if (msg?.type === 'settings') {
    const saved = await db.getMeta('settings', {});
    // El identificador de terminal es de esta ventana; solo sincronizamos el resto.
    state.settings = { ...state.settings, ...saved, terminalId: state.settings.terminalId };
    applySettings();
    return;
  }
  await Promise.all([refreshStats(), refreshRecent()]);
  if (state.search.query) runSearch(state.search.query);
  if (state.view === 'log') refreshLog();
  if (state.view === 'data') refreshDataPanel();
}

async function refreshStats() {
  const s = await db.getStats();
  $('#stat-in').textContent = formatNumber(s.inside);
  $('#stat-pending').textContent = formatNumber(s.pending);
  $('#stat-blocked').textContent = formatNumber(s.blocked);
  $('#stat-total').textContent = formatNumber(s.total);
  const eligible = s.total - s.blocked;
  const pct = eligible ? (s.inside / eligible) * 100 : 0;
  $('#progress-bar').style.width = `${pct.toFixed(2)}%`;
  $('#progress').setAttribute('aria-valuenow', pct.toFixed(0));
  $('#progress-label').textContent = `${pct < 10 && pct > 0 ? pct.toFixed(1) : pct.toFixed(0)} %`;
}

async function refreshRecent(initial = false) {
  const entries = await db.getLog({ limit: 12 });
  els.recentEmpty.hidden = entries.length > 0;
  const newestId = entries[0]?.id ?? 0;
  els.recent.innerHTML = entries
    .map((e) => logItem(e, !initial && e.id > state.lastLogId))
    .join('');
  state.lastLogId = Math.max(state.lastLogId, newestId);
}

function logItem(entry, isNew) {
  const meta = RESULT_META[entry.result] ?? { label: entry.result, tone: 'muted' };
  const who = entry.name ?? (entry.result === 'not_found' ? 'Folio desconocido' : '—');
  const offline = entry.online === false ? ' · <span class="tag-offline">sin red</span>' : '';
  const folio = entry.folio ? `<span class="folio">${escapeHtml(entry.folio)}</span> · ` : '';
  return `<li class="log-item tone-${meta.tone}${isNew ? ' is-new' : ''}">
    <span class="dot" aria-hidden="true"></span>
    <span class="log-main">
      <span class="log-name">${escapeHtml(who)}</span>
      <span class="log-meta">${folio}${escapeHtml(entry.terminal)}${offline}</span>
    </span>
    <span class="log-side">
      <span class="chip tone-${meta.tone}">${escapeHtml(meta.label)}</span>
      <time datetime="${new Date(entry.ts).toISOString()}">${formatTime(entry.ts)}</time>
    </span>
  </li>`;
}

async function refreshLog() {
  const filter = LOG_FILTERS[state.logFilter];
  const [entries, total] = await Promise.all([db.getLog({ limit: 300, results: filter }), db.countLog()]);
  els.logSummary.textContent = total
    ? `${formatNumber(total)} registros en total · mostrando ${formatNumber(entries.length)} ${filter ? 'del filtro seleccionado' : 'más recientes'} · las exportaciones incluyen todo.`
    : 'La bitácora está vacía. Cada validación (permitida o rechazada) queda registrada aquí con su marca de tiempo.';
  if (!entries.length) {
    els.logBody.innerHTML = '<tr class="empty-row"><td colspan="6">Sin registros para este filtro.</td></tr>';
    return;
  }
  els.logBody.innerHTML = entries.map((e) => {
    const meta = RESULT_META[e.result] ?? { label: e.result, tone: 'muted' };
    return `<tr>
      <td class="mono"><time datetime="${new Date(e.ts).toISOString()}" title="${escapeHtml(formatDateTime(e.ts))}">${formatTime(e.ts)}</time></td>
      <td class="mono">${escapeHtml(e.folio ?? '—')}</td>
      <td class="name-cell">${escapeHtml(e.name ?? (e.result === 'not_found' ? 'Folio desconocido' : '—'))}</td>
      <td><span class="chip tone-${meta.tone}">${escapeHtml(meta.label)}</span></td>
      <td class="mono">${escapeHtml(e.terminal)}</td>
      <td>${e.online ? 'En línea' : '<span class="tag-offline">Sin red</span>'}</td>
    </tr>`;
  }).join('');
}

async function refreshDataPanel() {
  const [stats, logCount, dataset] = await Promise.all([db.getStats(), db.countLog(), db.getMeta('dataset')]);
  $('#db-guests').textContent = `${formatNumber(stats.total)} (${formatNumber(stats.inside)} dentro)`;
  $('#db-log').textContent = formatNumber(logCount);
  $('#db-source').textContent = dataset
    ? `${dataset.source === 'demo' ? 'Datos demo' : dataset.source} · ${formatDateTime(dataset.loadedAt)}`
    : '—';

  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    $('#db-usage').textContent = `${formatBytes(usage)} de ${formatBytes(quota)}`;
  } else $('#db-usage').textContent = 'No disponible';
  await updatePersistLabel();

  // PWA
  const sw = navigator.serviceWorker;
  $('#pwa-sw').textContent = !sw
    ? 'No soportado'
    : sw.controller ? 'Activo (controla esta página)' : state.swRegistration ? 'Registrado (recarga para que controle)' : 'Registrando…';
  if ('caches' in window) {
    const keys = (await caches.keys()).filter((k) => k.startsWith('acceso-shell'));
    if (keys.length) {
      const cache = await caches.open(keys[0]);
      const files = await cache.keys();
      $('#pwa-cache').textContent = `${keys[0]} · ${files.length} archivos`;
    } else $('#pwa-cache').textContent = 'Aún no creada';
  }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#pwa-display').textContent = standalone ? 'App instalada (standalone)' : 'Pestaña del navegador';
  $('#pwa-net').textContent = navigator.onLine ? 'En línea' : 'Sin conexión (operando con datos locales)';
  $('#pwa-sync').textContent = channel ? 'BroadcastChannel activo' : 'Por visibilidad de pestaña';
}

async function updatePersistLabel() {
  const label = $('#db-persist');
  if (!navigator.storage?.persisted) {
    label.textContent = 'No soportado';
    return;
  }
  const persisted = await navigator.storage.persisted();
  label.textContent = persisted ? 'Sí (el navegador no la borrará)' : 'No (puede liberarse con poco espacio)';
  $('#persist-btn').hidden = persisted;
}

async function requestPersistence(silent) {
  if (!navigator.storage?.persist) {
    if (!silent) toast('Este navegador no permite solicitar almacenamiento persistente.', 'error');
    return;
  }
  const granted = await navigator.storage.persist().catch(() => false);
  if (!silent) toast(granted ? 'Almacenamiento persistente concedido.' : 'El navegador no concedió persistencia (instalar la app suele habilitarla).', granted ? 'ok' : 'info');
  if (state.view === 'data') updatePersistLabel();
}

// =====================================================================================
// Carga de datos (demo / importación) y exportaciones
// =====================================================================================

async function loadDemoData(count) {
  setUI('loading');
  setLoader(`Generando ${formatNumber(count)} invitados de demostración`, 0.12);
  const onProgress = (done, total) => setLoader(`Guardando en IndexedDB · ${formatNumber(done)} / ${formatNumber(total)}`, 0.15 + (done / total) * 0.85);
  try {
    await seedInWorker(count, onProgress);
  } catch (err) {
    // Navegadores sin module workers: misma operación en el hilo principal.
    console.warn('Siembra en Web Worker no disponible; se usa el hilo principal.', err);
    await db.replaceGuests(generateGuests(count), { source: 'demo', onProgress });
  }
}

/** Genera y escribe los invitados en un Web Worker para no bloquear la interfaz. */
function seedInWorker(count, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./seed-worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    worker.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress(msg.done, msg.total);
      else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.count);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    });
    worker.addEventListener('error', (e) => {
      e.preventDefault();
      worker.terminate();
      reject(new Error(e.message || 'No se pudo iniciar el Web Worker'));
    });
    worker.postMessage({ count, source: 'demo' });
  });
}

async function regenerateDemo() {
  const count = Number($('#demo-size').value) || DEFAULT_DEMO_SIZE;
  if (!confirm(`Se reemplazará la lista actual por ${formatNumber(count)} invitados de demostración y se borrará la bitácora. ¿Continuar?`)) return;
  await withDatasetReload(() => loadDemoData(count));
  toast(`${formatNumber(count)} invitados cargados.`, 'ok');
}

async function withDatasetReload(task) {
  clearSearch();
  try {
    await task();
  } finally {
    state.lastLogId = 0;
    await Promise.all([refreshStats(), refreshRecent(true)]);
    if (state.view === 'data') await refreshDataPanel();
    if (state.view === 'log') await refreshLog();
    setUI('idle');
    broadcast('dataset');
  }
}

const FIELD_ALIASES = {
  folio: ['folio', 'id', 'codigo', 'code', 'clave', 'boleto'],
  firstName: ['nombre', 'nombres', 'first_name', 'firstname', 'name'],
  lastName: ['apellidos', 'apellido', 'last_name', 'lastname', 'surname'],
  fullName: ['nombre_completo', 'full_name', 'fullname', 'invitado'],
  category: ['categoria', 'category', 'tipo', 'type'],
  table: ['mesa', 'table', 'zona'],
  blocked: ['bloqueado', 'blocked', 'cancelado'],
  blockedReason: ['motivo', 'reason', 'motivo_bloqueo'],
};

function mapImportedRow(row) {
  const pick = (field) => {
    for (const alias of FIELD_ALIASES[field]) {
      if (row[alias] != null && String(row[alias]).trim() !== '') return String(row[alias]).trim();
    }
    return '';
  };
  let firstName = pick('firstName');
  let lastName = pick('lastName');
  const full = pick('fullName');
  if (!firstName && full) {
    const parts = full.split(/\s+/);
    firstName = parts.shift();
    lastName = parts.join(' ');
  }
  const blockedRaw = normalize(pick('blocked'));
  const rawCategory = pick('category');
  return {
    folio: pick('folio'),
    firstName,
    lastName,
    category: rawCategory ? (normalize(rawCategory) in CATEGORY_LABELS ? normalize(rawCategory) : rawCategory) : 'general',
    table: pick('table') || null,
    blocked: ['si', 'true', '1', 'x', 'yes', 'bloqueado'].includes(blockedRaw),
    blockedReason: pick('blockedReason') || null,
  };
}

async function importFile(file) {
  const input = $('#import-file');
  if (!file) return;
  try {
    const text = await file.text();
    let rows;
    if (/\.json$/i.test(file.name) || /^\s*[[{]/.test(text)) {
      const json = JSON.parse(text);
      const list = Array.isArray(json) ? json : json.invitados ?? json.guests ?? [];
      rows = list.map((obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [normalize(k).replace(/ /g, '_'), v])));
    } else {
      const table = parseCSV(text);
      const header = (table.shift() ?? []).map((h) => normalize(h).replace(/ /g, '_'));
      rows = table.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
    }

    const seen = new Set();
    let skipped = 0;
    const guests = [];
    for (const row of rows) {
      const g = mapImportedRow(row);
      const folio = normalizeFolio(g.folio);
      if (!folio || !g.firstName || seen.has(folio)) {
        skipped++;
        continue;
      }
      seen.add(folio);
      guests.push(g);
    }
    if (!guests.length) throw new Error('El archivo no contiene invitados válidos (se requieren al menos las columnas folio y nombre).');

    const msg = `Se importarán ${formatNumber(guests.length)} invitados desde “${file.name}”${skipped ? ` (${skipped} filas omitidas por datos incompletos o folio repetido)` : ''}. La lista actual y la bitácora se reemplazarán. ¿Continuar?`;
    if (!confirm(msg)) return;

    await withDatasetReload(async () => {
      setUI('loading');
      setLoader(`Importando ${formatNumber(guests.length)} invitados`, 0.1);
      await db.replaceGuests(guests, {
        source: `Archivo ${file.name}`,
        onProgress: (done, total) => setLoader(`Guardando en IndexedDB · ${formatNumber(done)} / ${formatNumber(total)}`, 0.1 + (done / total) * 0.9),
      });
    });
    toast(`${formatNumber(guests.length)} invitados importados.`, 'ok');
  } catch (err) {
    console.error(err);
    toast(`No se pudo importar: ${err.message}`, 'error');
  } finally {
    input.value = '';
  }
}

function downloadTemplate() {
  const csv = '﻿folio,nombre,apellidos,categoria,mesa,bloqueado,motivo\r\n'
    + '200001,Ana Sofía,Ramírez Torres,VIP,3,no,\r\n'
    + '200002,Luis,Hernández Cruz,General,27,no,\r\n'
    + '200003,Patricia,Gómez Luna,Staff,,no,\r\n'
    + '200004,Jorge,Salazar Peña,General,31,si,Invitación cancelada\r\n';
  downloadFile(csv, 'plantilla-invitados.csv', 'text/csv;charset=utf-8');
}

async function exportLog(format) {
  const entries = await db.getAllLog();
  if (!entries.length) {
    toast('La bitácora está vacía; no hay nada que exportar.', 'info');
    return;
  }
  const base = `bitacora-accesos-${state.settings.terminalId}-${stamp()}`;
  if (format === 'json') {
    const payload = {
      evento: state.settings.eventName,
      terminal: state.settings.terminalId,
      generado: new Date().toISOString(),
      total: entries.length,
      registros: entries.map((e) => ({
        id: e.id,
        fecha_hora: new Date(e.ts).toISOString(),
        folio: e.folio,
        invitado: e.name,
        categoria: e.category,
        resultado: e.result,
        terminal: e.terminal,
        origen: e.source,
        en_linea: e.online,
      })),
    };
    downloadFile(JSON.stringify(payload, null, 2), `${base}.json`, 'application/json');
  } else {
    const csv = toCSV(entries, [
      { label: 'id', value: (e) => e.id },
      { label: 'fecha_hora_iso', value: (e) => new Date(e.ts).toISOString() },
      { label: 'hora_local', value: (e) => formatDateTime(e.ts) },
      { label: 'folio', value: (e) => e.folio },
      { label: 'invitado', value: (e) => e.name },
      { label: 'categoria', value: (e) => (e.category ? categoryLabel(e.category) : '') },
      { label: 'resultado', value: (e) => RESULT_META[e.result]?.label ?? e.result },
      { label: 'terminal', value: (e) => e.terminal },
      { label: 'origen', value: (e) => SOURCE_LABELS[e.source] ?? e.source },
      { label: 'conexion', value: (e) => (e.online ? 'en línea' : 'sin red') },
    ]);
    downloadFile(csv, `${base}.csv`, 'text/csv;charset=utf-8');
  }
  toast(`Bitácora exportada (${formatNumber(entries.length)} registros).`, 'ok');
}

async function exportGuests() {
  const guests = await db.getAllGuests();
  const csv = toCSV(guests, [
    { label: 'folio', value: (g) => g.folio },
    { label: 'nombre', value: (g) => g.firstName },
    { label: 'apellidos', value: (g) => g.lastName },
    { label: 'categoria', value: (g) => categoryLabel(g.category) },
    { label: 'mesa', value: (g) => g.table ?? '' },
    { label: 'estado', value: (g) => ({ in: 'Ingresó', blocked: 'Bloqueado', pending: 'Pendiente' })[g.status] },
    { label: 'hora_ingreso', value: (g) => (g.checkedInAt ? formatDateTime(g.checkedInAt) : '') },
    { label: 'terminal', value: (g) => g.checkedInBy ?? '' },
    { label: 'motivo_bloqueo', value: (g) => g.blockedReason ?? '' },
  ]);
  downloadFile(csv, `invitados-${stamp()}.csv`, 'text/csv;charset=utf-8');
  toast(`${formatNumber(guests.length)} invitados exportados.`, 'ok');
}

async function resetCheckIns() {
  if (!confirm('Todos los invitados que ya ingresaron volverán a “Pendiente”. La bitácora se conserva. ¿Continuar?')) return;
  const n = await db.resetCheckIns(context('admin'));
  toast(`${formatNumber(n)} entradas reiniciadas.`, 'ok');
  afterMutation();
  if (state.search.query) runSearch(state.search.query);
}

// =====================================================================================
// Prueba de rendimiento
// =====================================================================================

async function runBenchmark() {
  const btn = $('#bench-btn');
  btn.disabled = true;
  btn.textContent = 'Midiendo…';
  try {
    const sample = await db.getRandomGuests(60);
    const queries = [];
    for (const g of sample) {
      const first = g.firstName.split(' ')[0];
      const last = g.lastName.split(' ')[0];
      queries.push(first.slice(0, 2), first.slice(0, 4), last.slice(0, 3), `${first} ${last.slice(0, 2)}`, g.folio.slice(0, 4), g.folio);
    }
    const times = [];
    for (const q of queries) {
      const t0 = performance.now();
      await db.searchGuests(q, SEARCH_LIMIT);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const fmt = (v) => `${v.toFixed(2)} ms`;
    $('#bench-n').textContent = `${formatNumber(times.length)} sobre ${$('#stat-total').textContent} invitados`;
    $('#bench-avg').textContent = fmt(avg);
    $('#bench-p50').textContent = fmt(percentile(times, 50));
    $('#bench-p95').textContent = fmt(percentile(times, 95));
    $('#bench-max').textContent = fmt(times[times.length - 1]);
    $('#bench-out').hidden = false;
  } catch (err) {
    toast(`La prueba falló: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ejecutar prueba';
  }
}

// =====================================================================================
// Service Worker
// =====================================================================================

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (state.updateRequested) location.reload();
  });
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      state.swRegistration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(worker);
        });
      });
    })
    .catch((err) => console.warn('No se pudo registrar el Service Worker', err));
}

function showUpdateBanner(worker) {
  const banner = $('#update-banner');
  banner.hidden = false;
  $('#update-btn').onclick = () => {
    state.updateRequested = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
}

// =====================================================================================
// Toast
// =====================================================================================

function toast(message, tone = 'info') {
  const t = els.toast;
  t.textContent = message;
  t.className = `toast toast-${tone}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3600);
}
