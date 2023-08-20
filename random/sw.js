// stale-while-revalidate
self.addEventListener('fetch', function(event) {
  if (event.request.url.endsWith('/random/rep-calculator.html')) {
    event.respondWith(
      caches.open('mypage-cache').then(function(cache) {
        return cache.match(event.request).then(function(response) {
          var fetchPromise = fetch(event.request).then(function(networkResponse) {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          });
          return response || fetchPromise;
        });
      })
    );
  }
});






