(() => {
  const form = document.getElementById('fare-form');
  const fields = form.elements;
  const origin = document.getElementById('fare-origin');
  const destination = document.getElementById('fare-destination');
  const matches = document.getElementById('fare-matches');
  const submit = document.getElementById('fare-submit');
  const routeButton = document.getElementById('fare-route');
  const mapElement = document.getElementById('fare-map');
  const status = document.getElementById('fare-status');
  const total = document.getElementById('fare-total');
  const detail = document.getElementById('fare-detail');
  const google = document.getElementById('fare-google');
  const quote = document.getElementById('fare-quote');

  const initialStatus = status.textContent;
  const tariff = {
    diurna: { base: 119, perKm: 63 },
    nocturna: { base: 143, perKm: 68 },
  };
  const number = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 1 });
  const money = new Intl.NumberFormat('es-UY', {
    style: 'currency', currency: 'UYU', maximumFractionDigits: 0,
  });
  const searchCache = new Map();
  let map;
  let mapTimeout;
  let pending;
  let lastRouteRequest = -Infinity;

  fields.date.value = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo' }).format();

  function clearResult() {
    clearTimeout(mapTimeout);
    map?.remove();
    map = null;
    for (const element of [mapElement, total, detail, google, quote]) element.hidden = true;
    status.textContent = initialStatus;
  }

  function setBusy(busy) {
    submit.disabled = busy;
    routeButton.disabled = busy;
  }

  function resetSearch() {
    pending?.abort();
    pending = null;
    setBusy(false);
    clearResult();
  }

  function linkToTrip(from, to) {
    const directions = new URL('https://www.google.com/maps/dir/');
    directions.search = new URLSearchParams({
      api: '1', origin: from, destination: to, travelmode: 'driving',
    });
    google.href = directions.href;
    google.hidden = false;

    const [year, month, day] = fields.date.value.split('-');
    const arrival = fields.end.value ? ' y me gustaría llegar a las ' + fields.end.value : '';
    const message = 'Hola, ¿cómo estás? Quiero cotizar un viaje desde ' + from + ' hasta ' + to +
      ' el ' + day + '/' + month + '/' + year + ' a las ' + fields.start.value + arrival + '. ¿Me pasás el precio?';
    quote.href = 'https://wa.me/59897466810?text=' + encodeURIComponent(message);
    quote.hidden = false;
  }

  async function readJson(url, signal) {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
    if (!response.ok) throw new Error('Servicio de mapas no disponible');
    return response.json();
  }

  async function findAddress(address, signal) {
    const key = address.toLocaleLowerCase('es-UY');
    if (searchCache.has(key)) return searchCache.get(key);
    const url = new URL('https://photon.komoot.io/api/');
    url.search = new URLSearchParams({
      q: address, countrycode: 'UY', bbox: '-58.142,-32.374,-58.021,-32.26', limit: '5',
    });
    const { features } = await readJson(url, signal);
    const places = (features ?? []).filter(({ geometry }) => geometry?.type === 'Point');
    if (searchCache.size >= 24) searchCache.clear();
    searchCache.set(key, places);
    return places;
  }

  function addressOptions(select, places) {
    select.replaceChildren(new Option('Elegí una dirección', ''));
    for (const { properties, geometry } of places) {
      const { name, street, housenumber, locality, city, postcode } = properties;
      const streetAddress = [street, housenumber].filter(Boolean).join(' ');
      const label = [...new Set([name, streetAddress, locality, city, postcode].filter(Boolean))].join(', ');
      if (label) select.add(new Option(label, geometry.coordinates.join(',')));
    }
    select.disabled = false;
  }

  function showRoute(geometry) {
    function useGoogleMaps() {
      map?.remove();
      map = null;
      mapElement.hidden = true;
      status.textContent = 'El mapa integrado no está disponible. Podés ver el recorrido en Google Maps.';
    }
    if (!window.maplibregl) {
      useGoogleMaps();
      return;
    }
    const { coordinates } = geometry;
    const bounds = new maplibregl.LngLatBounds();
    for (const point of coordinates) bounds.extend(point);
    mapElement.hidden = false;
    try {
      map = new maplibregl.Map({
        container: mapElement,
        style: 'https://tiles.openfreemap.org/styles/positron',
        bounds,
        fitBoundsOptions: { padding: 30, maxZoom: 17, animate: false },
        scrollZoom: false,
        dragRotate: false,
        attributionControl: {
          customAttribution: '<a href="https://openstreetmap.de/">OSRM/FOSSGIS</a> · ' +
            '<a href="https://www.openstreetmap.org/">Corregir el mapa</a>',
        },
      });
    } catch {
      useGoogleMaps();
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    mapTimeout = setTimeout(useGoogleMaps, 15000);
    map.once('load', () => {
      clearTimeout(mapTimeout);
      const endpoints = [coordinates[0], coordinates.at(-1)];
      map.addSource('trip', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: {}, geometry },
            ...endpoints.map((point) => ({
              type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point },
            })),
          ],
        },
      });
      map.addLayer({
        id: 'trip-line', type: 'line', source: 'trip',
        filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#151618', 'line-width': 5 },
      });
      map.addLayer({
        id: 'trip-points', type: 'circle', source: 'trip',
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-color': '#ffd400', 'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': '#151618' },
      });
      mapElement.dataset.ready = '';
    });
  }

  function showPrice(route) {
    const hour = Number(fields.start.value.slice(0, 2));
    const sunday = new Date(fields.date.value + 'T00:00:00Z').getUTCDay() === 0;
    const period = sunday || fields.holiday.checked || hour < 6 || hour >= 22 ? 'nocturna' : 'diurna';
    const rate = tariff[period];
    const kilometers = route.distance / 1000;
    total.textContent = money.format(rate.base + rate.perKm * kilometers) + ' aprox.';
    detail.textContent = number.format(kilometers) + ' km · ' + Math.max(1, Math.round(route.duration / 60)) +
      ' min de viaje · Tarifa ' + period + ' según la salida. Sin esperas ni peajes.';
    total.hidden = false;
    detail.hidden = false;
  }

  form.addEventListener('input', (event) => {
    resetSearch();
    if (event.target === fields.origin || event.target === fields.destination) {
      matches.hidden = true;
      origin.disabled = destination.disabled = true;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    const from = fields.origin.value.trim();
    const to = fields.destination.value.trim();
    if (!from || !to || from.toLocaleLowerCase('es-UY') === to.toLocaleLowerCase('es-UY')) {
      status.textContent = 'Ingresá dos direcciones distintas.';
      return;
    }

    clearResult();
    matches.hidden = true;
    origin.disabled = destination.disabled = true;
    linkToTrip(from, to);
    status.textContent = 'Buscando direcciones en Paysandú…';
    const request = new AbortController();
    pending = request;
    setBusy(true);
    try {
      const [starts, ends] = await Promise.all([findAddress(from, request.signal), findAddress(to, request.signal)]);
      if (request.signal.aborted) return;
      addressOptions(origin, starts);
      addressOptions(destination, ends);
      if (origin.options.length < 2 || destination.options.length < 2) {
        status.textContent = 'No encontré ambas direcciones en Paysandú. Revisalas o consultá por WhatsApp.';
        return;
      }
      matches.hidden = false;
      status.textContent = 'Elegí los puntos correctos para calcular el recorrido.';
      origin.focus();
    } catch {
      if (!request.signal.aborted) status.textContent = 'No pude buscar las direcciones. Podés abrir Google Maps o consultar por WhatsApp.';
    } finally {
      if (pending === request) {
        pending = null;
        setBusy(false);
      }
    }
  });

  routeButton.addEventListener('click', async () => {
    if (pending || !form.reportValidity()) return;
    if (origin.value === destination.value) {
      status.textContent = 'Elegí puntos distintos para la salida y el destino.';
      return;
    }
    if (performance.now() - lastRouteRequest < 1000) return;

    clearResult();
    linkToTrip(origin.selectedOptions[0].text, destination.selectedOptions[0].text);
    status.textContent = 'Calculando el recorrido…';
    const request = new AbortController();
    pending = request;
    lastRouteRequest = performance.now();
    setBusy(true);
    try {
      const url = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/' +
        origin.value + ';' + destination.value + '?overview=full&geometries=geojson';
      const { routes } = await readJson(url, request.signal);
      if (request.signal.aborted) return;
      const route = routes?.[0];
      if (!route || !Number.isFinite(route.distance) || route.distance <= 0 || !route.geometry?.coordinates?.length) {
        throw new Error('No hay un recorrido en auto');
      }
      status.textContent = 'Recorrido estimado dentro de Paysandú.';
      showPrice(route);
      showRoute(route.geometry);
    } catch {
      if (!request.signal.aborted) status.textContent = 'No pude trazar el recorrido. Podés abrir Google Maps o consultar por WhatsApp.';
    } finally {
      if (pending === request) {
        pending = null;
        setBusy(false);
      }
    }
  });
})();
