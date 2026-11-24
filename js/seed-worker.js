// Web Worker: genera y guarda la lista demo en IndexedDB fuera del hilo principal,
// para que la interfaz siga fluida mientras se escriben miles de registros.

import { generateGuests } from './seed.js';
import { replaceGuests } from './db.js';

self.addEventListener('message', async (event) => {
  const { count, source = 'demo' } = event.data ?? {};
  try {
    const guests = generateGuests(count);
    const saved = await replaceGuests(guests, {
      source,
      onProgress: (done, total) => self.postMessage({ type: 'progress', done, total }),
    });
    self.postMessage({ type: 'done', count: saved });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
});
