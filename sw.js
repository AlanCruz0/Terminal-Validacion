// Service Worker · Control de Acceso
//
//  install  → precarga el App Shell (todo lo necesario para dibujar la interfaz).
//  activate → borra las cachés de versiones anteriores de ESTA app.
//  fetch    → Cache First, Network Fallback para el App Shell; las navegaciones que no
//             estén en caché y fallen por falta de red reciben el index.html cacheado.
//
// Para publicar una nueva versión basta con cambiar VERSION: el navegador detecta el
// cambio de bytes, instala el nuevo SW y la app muestra el aviso "Actualizar".

const VERSION = 'v1.0.0';
const CACHE_PREFIX = 'acceso-shell-';
const SHELL_CACHE = `${CACHE_PREFIX}${VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/seed.js',
  './js/seed-worker.js',
  './js/utils.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/shortcut-validar.png',
  './icons/shortcut-simular.png',
  './icons/shortcut-bitacora.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)),
  );
  // No llamamos skipWaiting() aquí: si ya hay una versión activa, la nueva espera a que el
  // operador pulse "Actualizar" para no recargar la terminal a mitad de una validación.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Solo se borran cachés de esta app (en GitHub Pages el origen se comparte con otros proyectos).
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const isNavigation = request.mode === 'navigate';

  // 1) Caché primero. Para navegaciones se ignora la query (?view=log, ?source=pwa…).
  const cached = await cache.match(request, { ignoreSearch: isNavigation });
  if (cached) return cached;

  // 2) Red como respaldo; lo obtenido se guarda para la próxima vez.
  try {
    const response = await fetch(request);
    if (response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // 3) Sin red: cualquier navegación cae en el App Shell.
    if (isNavigation) {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('Sin conexión y el recurso no está en caché.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
