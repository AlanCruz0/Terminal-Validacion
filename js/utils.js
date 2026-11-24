// Utilidades compartidas: normalización de texto, formato, CSV y descargas con Blob URLs.

/** Minúsculas, sin acentos y sin signos: "María-José Núñez" → "maria jose nunez". */
export function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Palabras únicas normalizadas; se usan como claves del índice multiEntry "tokens". */
export function tokenize(value) {
  const n = normalize(value);
  return n ? [...new Set(n.split(' '))] : [];
}

export function normalizeFolio(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/** Si la consulta contiene un dígito se trata como folio (clave primaria). */
export function looksLikeFolio(value) {
  return /\d/.test(String(value ?? ''));
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Resalta con <mark> el prefijo de cada palabra que coincide con algún token buscado. */
export function highlight(text, tokens) {
  if (!tokens?.length) return escapeHtml(text);
  return String(text ?? '')
    .split(/(\s+)/)
    .map((part) => {
      if (!part.trim()) return part;
      const n = normalize(part);
      const token = tokens.find((t) => n.startsWith(t));
      if (!token) return escapeHtml(part);
      const chars = [...part];
      let consumed = 0;
      let i = 0;
      while (i < chars.length && consumed < token.length) {
        consumed += normalize(chars[i]).length;
        i++;
      }
      return `<mark>${escapeHtml(chars.slice(0, i).join(''))}</mark>${escapeHtml(chars.slice(i).join(''))}`;
    })
    .join('');
}

export function highlightPrefix(text, prefix) {
  const t = String(text ?? '');
  if (prefix && t.toUpperCase().startsWith(prefix)) {
    return `<mark>${escapeHtml(t.slice(0, prefix.length))}</mark>${escapeHtml(t.slice(prefix.length))}`;
  }
  return escapeHtml(t);
}

export function initials(first, last) {
  const a = String(first ?? '').trim().charAt(0);
  const b = String(last ?? '').trim().charAt(0);
  return (a + b).toUpperCase() || '?';
}

const timeFmt = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'medium', hour12: false });
const numberFmt = new Intl.NumberFormat('es-MX');

export const formatTime = (ts) => timeFmt.format(ts);
export const formatDateTime = (ts) => dateTimeFmt.format(ts);
export const formatNumber = (n) => numberFmt.format(n);

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  return `hace ${h} h ${m % 60} min`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Genera CSV (con BOM para que Excel respete los acentos). */
export function toCSV(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.value(r))).join(','));
  return '﻿' + [head, ...body].join('\r\n');
}

/** Parser CSV con soporte de comillas; detecta "," o ";" como separador. */
export function parseCSV(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Descarga un archivo generado en el navegador mediante una Blob URL. */
export function downloadFile(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}
