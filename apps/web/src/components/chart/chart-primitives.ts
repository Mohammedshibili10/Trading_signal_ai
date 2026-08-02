import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesPrimitivePaneViewZOrder,
  SeriesType,
  Time,
} from 'lightweight-charts';

/**
 * Canvas overlays for the analysis engine's output.
 *
 * Lightweight-charts draws series and horizontal price lines; it has no concept
 * of a *region* of the chart. Order blocks, fair value gaps, entry zones and
 * pattern outlines are all regions, so they are drawn here as series
 * primitives — the library's supported extension point, which means they pan,
 * zoom and rescale with the price data instead of being absolutely positioned
 * divs that drift the moment the user scrolls.
 */

/** The slice of fancy-canvas's rendering target we actually use. */
interface BitmapTarget {
  useBitmapCoordinateSpace(
    callback: (scope: {
      context: CanvasRenderingContext2D;
      bitmapSize: { width: number; height: number };
      horizontalPixelRatio: number;
      verticalPixelRatio: number;
    }) => void,
  ): void;
}

export interface ChartZone {
  id: string;
  /** Unix seconds. Snapped to the nearest bar. */
  from: number;
  /** Omit to extend to the right edge — an unmitigated zone has no end yet. */
  to?: number;
  top: number;
  bottom: number;
  fill: string;
  border?: string;
  label?: string;
  /** Mitigated / filled zones render dashed and fainter. */
  dashed?: boolean;
}

export interface ChartSegment {
  id: string;
  points: Array<{ time: number; price: number }>;
  colour: string;
  width?: number;
  dashed?: boolean;
  label?: string;
  /** Draw a dot at each vertex — used for pattern pivots. */
  showPoints?: boolean;
}

interface Attached {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  requestUpdate?: () => void;
}

/**
 * Maps a time to an x coordinate, snapping to the nearest bar.
 *
 * `timeToCoordinate` returns null for any time that isn't exactly a bar's time,
 * and analysis events carry the timestamps of the bars they occurred on — but
 * those bars may have been trimmed out of the visible series, or the series may
 * be on a different timeframe than the one the event was found on. Snapping
 * keeps a zone visible and roughly right rather than silently dropping it.
 */
function makeXResolver(chart: IChartApi, times: number[]) {
  return (time: number): number | null => {
    if (times.length === 0) return null;

    let target = time;
    if (time <= times[0]) target = times[0];
    else if (time >= times[times.length - 1]) target = times[times.length - 1];
    else {
      // Binary search for the closest bar.
      let low = 0;
      let high = times.length - 1;
      while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (times[mid] <= time) low = mid;
        else high = mid;
      }
      target = time - times[low] <= times[high] - time ? times[low] : times[high];
    }

    const x = chart.timeScale().timeToCoordinate(target as Time);
    return x === null ? null : x;
  };
}

/* ── Zones ────────────────────────────────────────────────────── */

class ZoneRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(
    private readonly zones: ChartZone[],
    private readonly xFor: (time: number) => number | null,
    private readonly yFor: (price: number) => number | null,
  ) {}

  draw(target: unknown): void {
    (target as BitmapTarget).useBitmapCoordinateSpace(
      ({ context, bitmapSize, horizontalPixelRatio: hx, verticalPixelRatio: vy }) => {
        for (const zone of this.zones) {
          const x1 = this.xFor(zone.from);
          const yTop = this.yFor(Math.max(zone.top, zone.bottom));
          const yBottom = this.yFor(Math.min(zone.top, zone.bottom));
          if (x1 === null || yTop === null || yBottom === null) continue;

          // No end time means the zone is still in play — run it to the right
          // edge so it reads as "this level is live", not "this level expired".
          const x2 = zone.to === undefined ? bitmapSize.width / hx : this.xFor(zone.to);
          if (x2 === null) continue;

          const left = Math.round(Math.min(x1, x2) * hx);
          const right = Math.round(Math.max(x1, x2) * hx);
          const top = Math.round(yTop * vy);
          const bottom = Math.round(yBottom * vy);
          // A zero-height zone would vanish; a one-pixel band still says "here".
          const height = Math.max(1, bottom - top);
          const width = Math.max(2, right - left);

          context.save();
          context.fillStyle = zone.fill;
          context.fillRect(left, top, width, height);

          if (zone.border) {
            context.strokeStyle = zone.border;
            context.lineWidth = Math.max(1, hx);
            if (zone.dashed) context.setLineDash([4 * hx, 3 * hx]);
            context.strokeRect(left, top, width, height);
          }

          if (zone.label && height > 12 * vy && width > 40 * hx) {
            context.fillStyle = zone.border ?? 'rgba(255,255,255,0.75)';
            context.font = `${Math.round(10 * vy)}px ui-sans-serif, system-ui, sans-serif`;
            context.textBaseline = 'top';
            context.fillText(zone.label, left + 4 * hx, top + 3 * vy);
          }

          context.restore();
        }
      },
    );
  }
}

class ZonePaneView implements ISeriesPrimitivePaneView {
  constructor(private readonly primitive: ZonePrimitive) {}

  /** Behind the candles — a zone that covers the price data hides the thing it describes. */
  zOrder(): SeriesPrimitivePaneViewZOrder {
    return 'bottom';
  }

  renderer(): ISeriesPrimitivePaneRenderer | null {
    const attached = this.primitive.attachment;
    if (!attached || this.primitive.zones.length === 0) return null;

    return new ZoneRenderer(
      this.primitive.zones,
      makeXResolver(attached.chart, this.primitive.times),
      (price: number) => attached.series.priceToCoordinate(price),
    );
  }
}

export class ZonePrimitive {
  zones: ChartZone[] = [];
  times: number[] = [];
  attachment: Attached | null = null;

  private readonly views = [new ZonePaneView(this)];

  attached(param: Attached): void {
    this.attachment = param;
  }

  detached(): void {
    this.attachment = null;
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this.views;
  }

  updateAllViews(): void {
    /* Views read straight off this object; nothing to cache. */
  }

  setData(zones: ChartZone[], times: number[]): void {
    this.zones = zones;
    this.times = times;
    this.attachment?.requestUpdate?.();
  }
}

/* ── Segments (trendlines, pattern outlines) ──────────────────── */

class SegmentRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(
    private readonly segments: ChartSegment[],
    private readonly xFor: (time: number) => number | null,
    private readonly yFor: (price: number) => number | null,
  ) {}

  draw(target: unknown): void {
    (target as BitmapTarget).useBitmapCoordinateSpace(
      ({ context, horizontalPixelRatio: hx, verticalPixelRatio: vy }) => {
        for (const segment of this.segments) {
          const points = segment.points
            .map((point) => {
              const x = this.xFor(point.time);
              const y = this.yFor(point.price);
              return x === null || y === null ? null : { x: x * hx, y: y * vy };
            })
            .filter((point): point is { x: number; y: number } => point !== null);

          if (points.length < 2) continue;

          context.save();
          context.strokeStyle = segment.colour;
          context.lineWidth = (segment.width ?? 1.5) * hx;
          context.lineJoin = 'round';
          if (segment.dashed) context.setLineDash([5 * hx, 4 * hx]);

          context.beginPath();
          context.moveTo(points[0].x, points[0].y);
          for (const point of points.slice(1)) context.lineTo(point.x, point.y);
          context.stroke();

          if (segment.showPoints) {
            context.setLineDash([]);
            context.fillStyle = segment.colour;
            for (const point of points) {
              context.beginPath();
              context.arc(point.x, point.y, 3 * hx, 0, Math.PI * 2);
              context.fill();
            }
          }

          if (segment.label) {
            const anchor = points[points.length - 1];
            context.fillStyle = segment.colour;
            context.font = `${Math.round(10 * vy)}px ui-sans-serif, system-ui, sans-serif`;
            context.textBaseline = 'bottom';
            context.textAlign = 'right';
            context.fillText(segment.label, anchor.x - 4 * hx, anchor.y - 4 * vy);
          }

          context.restore();
        }
      },
    );
  }
}

class SegmentPaneView implements ISeriesPrimitivePaneView {
  constructor(private readonly primitive: SegmentPrimitive) {}

  /** Above the candles — a trendline is an annotation *on* the price. */
  zOrder(): SeriesPrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): ISeriesPrimitivePaneRenderer | null {
    const attached = this.primitive.attachment;
    if (!attached || this.primitive.segments.length === 0) return null;

    return new SegmentRenderer(
      this.primitive.segments,
      makeXResolver(attached.chart, this.primitive.times),
      (price: number) => attached.series.priceToCoordinate(price),
    );
  }
}

export class SegmentPrimitive {
  segments: ChartSegment[] = [];
  times: number[] = [];
  attachment: Attached | null = null;

  private readonly views = [new SegmentPaneView(this)];

  attached(param: Attached): void {
    this.attachment = param;
  }

  detached(): void {
    this.attachment = null;
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this.views;
  }

  updateAllViews(): void {
    /* Views read straight off this object; nothing to cache. */
  }

  setData(segments: ChartSegment[], times: number[]): void {
    this.segments = segments;
    this.times = times;
    this.attachment?.requestUpdate?.();
  }
}
