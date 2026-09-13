import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import type { StationSummary } from '@ocpp/contracts';
import { useTheme } from '@ocpp/ui';

/**
 * The fleet map.
 *
 * ## Why MapLibre and raster OSM tiles
 *
 * No API key, no account, no per-view billing — it works the moment you clone
 * the repo, which matters for a learning project. The trade-off is raster
 * tiles: they cannot be restyled the way vector tiles can, so dark mode is done
 * with MapLibre's raster paint properties rather than a real dark basemap.
 * It looks good enough and costs nothing.
 *
 * ## Why markers are drawn, not rendered as React
 *
 * A React component per marker means React reconciles 500 absolutely-positioned
 * divs on every pan frame. MapLibre's own marker layer is GPU-drawn and stays
 * smooth. The rule generalises: let the map library own anything that moves
 * with the map.
 */

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

export interface FleetMapProps {
  stations: StationSummary[];
  selectedId?: string | null;
  onSelect?: (station: StationSummary) => void;
  className?: string;
}

function toneFor(s: StationSummary) {
  if (s.status !== 'online') return { color: 'var(--color-ink-3)', label: 'offline' };
  if (s.faultedConnectorCount > 0) return { color: 'var(--color-c4)', label: 'faulted' };
  if (s.chargingConnectorCount > 0) return { color: 'var(--color-c2)', label: 'charging' };
  if (s.availableConnectorCount > 0) return { color: 'var(--color-c1)', label: 'available' };
  return { color: 'var(--color-ink-3)', label: 'busy' };
}

export function FleetMap({ stations, selectedId, onSelect, className }: FleetMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef(new Map<string, maplibregl.Marker>());
  const [tilesFailed, setTilesFailed] = useState(false);
  const { resolved } = useTheme();

  const withCoords = useMemo(
    () => stations.filter((s): s is StationSummary & { coordinates: NonNullable<StationSummary['coordinates']> } => s.coordinates !== null),
    [stations],
  );

  // --- create once ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [4.9, 52.2],
      zoom: 7,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left');

    // Tiles come from the public OSM servers, which are unreachable offline or
    // behind a strict proxy. Say so rather than showing an empty grey box.
    map.on('error', (e: { error?: { message?: string } }) => {
      if (String(e.error?.message ?? '').toLowerCase().includes('tile')) setTilesFailed(true);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // --- theme the raster layer ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getLayer('osm')) return;
      if (resolved === 'dark') {
        // Invert-ish: darken and desaturate so the basemap recedes and the
        // markers are the brightest thing on screen.
        map.setPaintProperty('osm', 'raster-brightness-min', 0.05);
        map.setPaintProperty('osm', 'raster-brightness-max', 0.42);
        map.setPaintProperty('osm', 'raster-saturation', -0.7);
        map.setPaintProperty('osm', 'raster-contrast', 0.12);
      } else {
        map.setPaintProperty('osm', 'raster-brightness-min', 0.1);
        map.setPaintProperty('osm', 'raster-brightness-max', 1);
        map.setPaintProperty('osm', 'raster-saturation', -0.35);
        map.setPaintProperty('osm', 'raster-contrast', 0);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [resolved]);

  // --- sync markers ---
  const select = useCallback(
    (station: StationSummary) => onSelect?.(station),
    [onSelect],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set<string>();

    for (const station of withCoords) {
      seen.add(station.id);
      const tone = toneFor(station);
      let marker = markersRef.current.get(station.id);

      if (!marker) {
        const el = document.createElement('button');
        el.type = 'button';
        el.setAttribute('aria-label', `${station.identity}, ${tone.label}`);
        el.className = 'grid place-items-center cursor-pointer';
        el.style.cssText = 'width:22px;height:22px;background:none;border:0;padding:0;';
        el.innerHTML = `<span style="display:block;width:13px;height:13px;border-radius:50%;border:2px solid var(--color-surface-1);box-shadow:var(--shadow-1);"></span>`;
        el.addEventListener('click', () => select(station));

        marker = new maplibregl.Marker({ element: el }).setLngLat([
          station.coordinates.longitude,
          station.coordinates.latitude,
        ]);
        marker.addTo(map);
        markersRef.current.set(station.id, marker);
      }

      const dot = marker.getElement().firstElementChild as HTMLElement | null;
      if (dot) {
        dot.style.background = tone.color;
        const isSelected = station.id === selectedId;
        dot.style.transform = isSelected ? 'scale(1.45)' : 'scale(1)';
        dot.style.outline = isSelected ? '2px solid var(--color-accent)' : 'none';
        dot.style.outlineOffset = '2px';
        dot.style.transition = 'transform 140ms ease';
      }
    }

    // Remove markers for stations that fell out of the filter.
    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }
  }, [withCoords, selectedId, select]);

  // --- fit to the current set, once it is known ---
  const fittedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || withCoords.length === 0 || fittedRef.current) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const s of withCoords) {
      bounds.extend([s.coordinates.longitude, s.coordinates.latitude]);
    }
    map.fitBounds(bounds, { padding: 64, maxZoom: 12, duration: 0 });
    fittedRef.current = true;
  }, [withCoords]);

  return (
    <div className={className} style={{ position: 'relative' }}>
      <div ref={containerRef} className="size-full rounded-lg" />
      {tilesFailed && (
        <div className="pointer-events-none absolute inset-x-3 top-3 rounded-sm border border-warn bg-warn-soft px-3 py-2 text-[11.5px] text-warn">
          Map tiles could not be loaded — no network access to openstreetmap.org. Markers and
          positions still work.
        </div>
      )}
    </div>
  );
}
