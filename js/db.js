// Capa de datos sobre IndexedDB.
//
// Esquema (DB "control-acceso", versión 1):
//   guests  keyPath: folio
//           índices: tokens (multiEntry) · nameKey · status
//   log     keyPath: id (autoIncrement)
//           índices: ts · folio · result
//   meta    keyPath: key   (configuración y datos del dataset)
//
// La búsqueda predictiva usa rangos de prefijo (IDBKeyRange.bound(p, p + '￿'))
// sobre la clave primaria (folio) o sobre el índice multiEntry "tokens" (cada palabra
// del nombre normalizada), por lo que nunca recorre la tabla completa.

import { normalize, tokenize, normalizeFolio, looksLikeFolio } from './utils.js';

const DB_NAME = 'control-acceso';
const DB_VERSION = 1;
const CANDIDATE_CAP = 3000;

let dbPromise = null;

export function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transacción abortada', 'AbortError'));
    tx.onerror = () => reject(tx.error);
  });
}

const prefixRange = (prefix) => IDBKeyRange.bound(prefix, `${prefix}￿`);

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) {
      reject(new Error('Este navegador no soporta IndexedDB.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('guests')) {
        const guests = db.createObjectStore('guests', { keyPath: 'folio' });
        guests.createIndex('tokens', 'tokens', { multiEntry: true });
        guests.createIndex('nameKey', 'nameKey');
        guests.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('log')) {
        const log = db.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
        log.createIndex('ts', 'ts');
        log.createIndex('folio', 'folio');
        log.createIndex('result', 'result');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Si otra pestaña abre una versión más nueva, cerramos para no bloquearla.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// ---------------------------------------------------------------- meta

export async function getMeta(key, fallback = null) {
  const db = await openDB();
  const rec = await promisify(db.transaction('meta').objectStore('meta').get(key));
  return rec ? rec.value : fallback;
}

export async function setMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  const finished = done(tx);
  tx.objectStore('meta').put({ key, value });
  await finished;
}

// ---------------------------------------------------------------- invitados

/** Convierte un invitado "crudo" (demo o importado) en el registro que se guarda. */
export function buildGuestRecord(raw) {
  const firstName = String(raw.firstName ?? '').trim();
  const lastName = String(raw.lastName ?? '').trim();
  const fullName = `${firstName} ${lastName}`.trim();
  const blocked = Boolean(raw.blocked);
  return {
    folio: normalizeFolio(raw.folio),
    firstName,
    lastName,
    fullName,
    nameKey: normalize(`${lastName} ${firstName}`),
    tokens: tokenize(fullName),
    category: String(raw.category ?? 'general').trim() || 'general',
    table: raw.table === '' || raw.table == null ? null : raw.table,
    status: blocked ? 'blocked' : 'pending',
    blockedReason: blocked ? raw.blockedReason || 'Acceso restringido' : null,
    checkedInAt: null,
    checkedInBy: null,
  };
}

/**
 * Reemplaza la lista de invitados en UNA sola transacción (atómica: o se carga todo o nada).
 * También reinicia la bitácora, porque los folios anteriores dejan de tener sentido.
 */
export async function replaceGuests(rawGuests, { source = 'demo', onProgress } = {}) {
  const db = await openDB();
  const records = rawGuests.map(buildGuestRecord);
  const tx = db.transaction(['guests', 'log', 'meta'], 'readwrite');
  const finished = done(tx);
  const guests = tx.objectStore('guests');
  guests.clear();
  tx.objectStore('log').clear();
  const step = Math.max(250, Math.floor(records.length / 40));
  records.forEach((record, i) => {
    const req = guests.put(record);
    if (onProgress && (i % step === step - 1 || i === records.length - 1)) {
      req.onsuccess = () => onProgress(i + 1, records.length);
    }
  });
  tx.objectStore('meta').put({ key: 'dataset', value: { count: records.length, source, loadedAt: Date.now() } });
  await finished;
  return records.length;
}

export async function getGuest(folio) {
  const db = await openDB();
  return promisify(db.transaction('guests').objectStore('guests').get(normalizeFolio(folio)));
}

export async function getAllGuests() {
  const db = await openDB();
  return promisify(db.transaction('guests').objectStore('guests').index('nameKey').getAll());
}

export async function getFolios(status = null) {
  const db = await openDB();
  const store = db.transaction('guests').objectStore('guests');
  return promisify(status ? store.index('status').getAllKeys(status) : store.getAllKeys());
}

export async function getRandomGuests(n) {
  const keys = await getFolios();
  if (!keys.length) return [];
  const db = await openDB();
  const store = db.transaction('guests').objectStore('guests');
  const picks = Array.from({ length: Math.min(n, keys.length) }, () => keys[Math.floor(Math.random() * keys.length)]);
  return Promise.all(picks.map((k) => promisify(store.get(k))));
}

export async function getStats() {
  const db = await openDB();
  const store = db.transaction('guests').objectStore('guests');
  const status = store.index('status');
  const [total, inside, blocked] = await Promise.all([
    promisify(store.count()),
    promisify(status.count('in')),
    promisify(status.count('blocked')),
  ]);
  return { total, inside, blocked, pending: total - inside - blocked };
}

/**
 * Búsqueda predictiva (as-you-type).
 *  - Con dígitos → rango de prefijo sobre la clave primaria (folio).
 *  - Con texto   → rango de prefijo sobre el índice multiEntry "tokens" usando la palabra
 *                  más larga (la más selectiva) y filtrando el resto de palabras en memoria.
 */
export async function searchGuests(query, limit = 40) {
  const raw = String(query ?? '').trim();
  if (!raw) return { mode: 'empty', results: [], total: 0, tokens: [] };

  const db = await openDB();
  const store = db.transaction('guests').objectStore('guests');

  if (looksLikeFolio(raw)) {
    const folio = normalizeFolio(raw);
    const range = prefixRange(folio);
    const [results, total] = await Promise.all([promisify(store.getAll(range, limit)), promisify(store.count(range))]);
    return { mode: 'folio', folio, results, total, tokens: [] };
  }

  const tokens = tokenize(raw);
  if (!tokens.length) return { mode: 'empty', results: [], total: 0, tokens: [] };

  const pivot = tokens.reduce((a, b) => (b.length > a.length ? b : a));
  const index = store.index('tokens');
  const range = prefixRange(pivot);

  if (tokens.length === 1) {
    // El índice ya devuelve los registros en orden alfabético por palabra coincidente.
    const [rows, total] = await Promise.all([promisify(index.getAll(range, limit * 2)), promisify(index.count(range))]);
    return { mode: 'name', results: dedupe(rows).slice(0, limit), total, tokens };
  }

  const others = tokens.filter((t) => t !== pivot);
  const rows = await promisify(index.getAll(range, CANDIDATE_CAP));
  const matched = dedupe(rows).filter((g) => others.every((t) => g.tokens.some((gt) => gt.startsWith(t))));
  matched.sort((a, b) => (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : 0));
  return { mode: 'name', results: matched.slice(0, limit), total: matched.length, tokens, capped: rows.length === CANDIDATE_CAP };
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((g) => (seen.has(g.folio) ? false : (seen.add(g.folio), true)));
}

// ---------------------------------------------------------------- validación de acceso

/**
 * Valida y registra una entrada de forma atómica.
 * La lectura del invitado, el cambio de estado y el asiento en la bitácora ocurren en la
 * MISMA transacción readwrite: IndexedDB serializa las transacciones que comparten
 * almacenes, así que dos pestañas/terminales nunca pueden dar acceso dos veces al mismo folio.
 */
export async function checkIn(folioInput, ctx) {
  const folio = normalizeFolio(folioInput);
  const db = await openDB();
  const tx = db.transaction(['guests', 'log'], 'readwrite', { durability: 'strict' });
  const finished = done(tx);
  const guests = tx.objectStore('guests');
  const now = Date.now();

  const guest = await promisify(guests.get(folio));
  let result;
  let previous = null;

  if (!guest) result = 'not_found';
  else if (guest.status === 'blocked') result = 'denied';
  else if (guest.status === 'in') {
    result = 'duplicate';
    previous = { at: guest.checkedInAt, by: guest.checkedInBy };
  } else {
    result = 'granted';
    guest.status = 'in';
    guest.checkedInAt = now;
    guest.checkedInBy = ctx.terminal;
    guests.put(guest);
  }

  const entry = {
    ts: now,
    folio,
    name: guest?.fullName ?? null,
    category: guest?.category ?? null,
    result,
    terminal: ctx.terminal,
    source: ctx.source ?? 'manual',
    online: Boolean(ctx.online),
  };
  entry.id = await promisify(tx.objectStore('log').add(entry));
  await finished;
  return { result, guest: guest ?? null, entry, previous };
}

/** Anula una entrada solo si el registro sigue exactamente como lo dejamos. */
export async function undoCheckIn(folio, checkedInAt, ctx) {
  const db = await openDB();
  const tx = db.transaction(['guests', 'log'], 'readwrite', { durability: 'strict' });
  const finished = done(tx);
  const guests = tx.objectStore('guests');
  const guest = await promisify(guests.get(folio));
  if (!guest || guest.status !== 'in' || guest.checkedInAt !== checkedInAt) {
    await finished;
    return false;
  }
  guest.status = 'pending';
  guest.checkedInAt = null;
  guest.checkedInBy = null;
  guests.put(guest);
  tx.objectStore('log').add({
    ts: Date.now(),
    folio,
    name: guest.fullName,
    category: guest.category,
    result: 'undo',
    terminal: ctx.terminal,
    source: 'undo',
    online: Boolean(ctx.online),
  });
  await finished;
  return true;
}

/** Regresa a "pendiente" a todos los que ya ingresaron (conserva la bitácora y deja constancia). */
export async function resetCheckIns(ctx) {
  const db = await openDB();
  const tx = db.transaction(['guests', 'log'], 'readwrite');
  const finished = done(tx);
  let count = 0;
  const req = tx.objectStore('guests').index('status').openCursor(IDBKeyRange.only('in'));
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      const g = cursor.value;
      g.status = 'pending';
      g.checkedInAt = null;
      g.checkedInBy = null;
      cursor.update(g);
      count++;
      cursor.continue();
      return;
    }
    tx.objectStore('log').add({
      ts: Date.now(),
      folio: null,
      name: `${count} entradas reiniciadas`,
      category: null,
      result: 'reset',
      terminal: ctx.terminal,
      source: 'admin',
      online: Boolean(ctx.online),
    });
  };
  await finished;
  return count;
}

// ---------------------------------------------------------------- bitácora

/** Últimos registros (más recientes primero) usando el índice "ts" en orden inverso. */
export async function getLog({ limit = 200, results = null } = {}) {
  const db = await openDB();
  const index = db.transaction('log').objectStore('log').index('ts');
  return new Promise((resolve, reject) => {
    const out = [];
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      if (!results || results.includes(cursor.value.result)) out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllLog() {
  const db = await openDB();
  return promisify(db.transaction('log').objectStore('log').index('ts').getAll());
}

export async function countLog() {
  const db = await openDB();
  return promisify(db.transaction('log').objectStore('log').count());
}
