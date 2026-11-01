var VERSION = 'v10';
var CACHE_SHELL = 'inventory-shell-' + VERSION;
var CACHE_CDN = 'inventory-cdn-' + VERSION;

var SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  './logo.svg'
];

var CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/exceljs@4.3.0/dist/exceljs.min.js'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_SHELL).then(function(cache) {
      return Promise.all(
        SHELL_URLS.map(function(url) {
          return fetch(url, { cache: 'reload' }).then(function(response) {
            if (response && response.ok) {
              return cache.put(url, response);
            }
          }).catch(function() {});
        })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.map(function(key) {
          if (key !== CACHE_SHELL && key !== CACHE_CDN) {
            return caches.delete(key);
          }
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

function getUrl(request) {
  try {
    return new URL(request.url);
  } catch (error) {
    return null;
  }
}

function isDynamic(url) {
  var path = url.pathname.toLowerCase();
  return url.search !== '' || path.indexOf('.xlsx') !== -1 || path.indexOf('.xls') !== -1 || path.indexOf('.php') !== -1;
}

function isCdn(url) {
  return CDN_URLS.indexOf(url.href) !== -1;
}

function isSwScript(url) {
  return url.pathname.toLowerCase().indexOf('/sw.js') !== -1;
}

function offlineResponse() {
  return new Response('', { status: 503, statusText: 'Service Unavailable' });
}

function networkOnly(request) {
  return fetch(request, { cache: 'no-store' }).catch(function() {
    return offlineResponse();
  });
}

function networkFirst(request, cacheName) {
  return fetch(request, { cache: 'no-store' }).then(function(response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(cacheName).then(function(cache) {
        return cache.put(request, copy);
      }).catch(function() {});
    }
    return response;
  }).catch(function() {
    return caches.match(request).then(function(cached) {
      return cached || offlineResponse();
    });
  });
}

function cacheFirst(request, cacheName) {
  return caches.match(request).then(function(cached) {
    if (cached) {
      return cached;
    }
    return fetch(request).then(function(response) {
      if (response && (response.ok || response.type === 'opaque')) {
        var copy = response.clone();
        caches.open(cacheName).then(function(cache) {
          return cache.put(request, copy);
        }).catch(function() {});
      }
      return response;
    }).catch(function() {
      return offlineResponse();
    });
  });
}

self.addEventListener('fetch', function(event) {
  var request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  var url = getUrl(request);

  if (!url) {
    return;
  }

  if (isDynamic(url)) {
    event.respondWith(networkOnly(request));
    return;
  }

  if (isCdn(url)) {
    event.respondWith(cacheFirst(request, CACHE_CDN));
    return;
  }

  if (url.origin === self.location.origin) {
    if (isSwScript(url)) {
      event.respondWith(networkOnly(request));
      return;
    }

    event.respondWith(networkFirst(request, CACHE_SHELL));
    return;
  }
});