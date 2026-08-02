'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import { useTheme } from 'next-themes';

import {
  SegmentPrimitive,
  ZonePrimitive,
  type ChartSegment,
  type ChartZone,
} from '@/components/chart/chart-primitives';
import type { Candle, Level, Timeframe } from '@/types';

export interface ChartOverlay {
  key: string;
  label: string;
  colour: string;
  data: Array<{ time: number; value: number }>;
}

export interface ChartMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  colour: string;
  text: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
}

export interface ChartPriceLine {
  id: string;
  price: number;
  colour: string;
  title: string;
  style?: 'solid' | 'dashed' | 'dotted';
  width?: 1 | 2 | 3;
}

interface PriceChartProps {
  candles: Candle[];
  type?: 'candlestick' | 'line' | 'area' | 'bar';
  overlays?: ChartOverlay[];
  levels?: Level[];
  markers?: ChartMarker[];
  /** Signal and pattern levels — entry, stop, targets, necklines. */
  priceLines?: ChartPriceLine[];
  /** Filled regions: order blocks, fair value gaps, entry/risk/reward bands. */
  zones?: ChartZone[];
  /** Trendlines and pattern outlines. */
  segments?: ChartSegment[];
  showVolume?: boolean;
  height?: number;
  timeframe?: Timeframe;
  logScale?: boolean;
  /**
   * Live mode keeps the user's viewport instead of refitting on every update.
   * Refitting on a five-second quote tick would yank the chart out from under
   * anyone who has zoomed in.
   */
  live?: boolean;
}

const LINE_STYLE = {
  solid: LineStyle.Solid,
  dashed: LineStyle.Dashed,
  dotted: LineStyle.Dotted,
} as const;

/**
 * TradingView Lightweight Charts wrapper.
 *
 * The library is imperative and owns its own DOM, so this component keeps the
 * chart instance in refs and reconciles data in effects rather than re-creating
 * it on every render — recreating loses the user's zoom and pan, which is the
 * single most irritating thing a chart can do.
 *
 * Annotations arrive as plain data and are reconciled the same way. The
 * component knows how to draw a zone; it deliberately knows nothing about what
 * an order block *is*.
 */
export function PriceChart({
  candles,
  type = 'candlestick',
  overlays = [],
  levels = [],
  markers = [],
  priceLines = [],
  zones = [],
  segments = [],
  showVolume = true,
  height = 420,
  timeframe = '1D',
  logScale = false,
  live = false,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const zonePrimitiveRef = useRef<ZonePrimitive | null>(null);
  const segmentPrimitiveRef = useRef<SegmentPrimitive | null>(null);
  /** Fit once per symbol/timeframe load, then leave the viewport alone. */
  const hasFittedRef = useRef(false);

  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const barTimes = useMemo(() => candles.map((candle) => candle.time), [candles]);

  // ── Create / destroy ─────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: isDark ? '#9aa0aa' : '#6b7280',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' },
        horzLines: { color: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { labelBackgroundColor: isDark ? '#2a2e37' : '#374151' },
        horzLine: { labelBackgroundColor: isDark ? '#2a2e37' : '#374151' },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.1, bottom: showVolume ? 0.28 : 0.08 },
        mode: logScale ? 1 : 0,
      },
      timeScale: {
        borderVisible: false,
        // Intraday timeframes need the time, daily and above do not.
        timeVisible: ['1m', '5m', '15m', '30m', '1h', '4h'].includes(timeframe),
        secondsVisible: false,
        rightOffset: 4,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });

    chartRef.current = chart;
    hasFittedRef.current = false;

    const bull = '#22c55e';
    const bear = '#ef4444';

    if (type === 'candlestick') {
      priceSeriesRef.current = chart.addCandlestickSeries({
        upColor: bull,
        downColor: bear,
        borderUpColor: bull,
        borderDownColor: bear,
        wickUpColor: bull,
        wickDownColor: bear,
      });
    } else if (type === 'bar') {
      priceSeriesRef.current = chart.addBarSeries({ upColor: bull, downColor: bear });
    } else if (type === 'area') {
      priceSeriesRef.current = chart.addAreaSeries({
        lineColor: '#6366f1',
        topColor: 'rgba(99,102,241,0.28)',
        bottomColor: 'rgba(99,102,241,0.02)',
        lineWidth: 2,
      });
    } else {
      priceSeriesRef.current = chart.addLineSeries({ color: '#6366f1', lineWidth: 2 });
    }

    // Annotation layers. Attached once and fed data separately, so toggling an
    // overlay never rebuilds the chart.
    const zonePrimitive = new ZonePrimitive();
    const segmentPrimitive = new SegmentPrimitive();
    priceSeriesRef.current.attachPrimitive(zonePrimitive as never);
    priceSeriesRef.current.attachPrimitive(segmentPrimitive as never);
    zonePrimitiveRef.current = zonePrimitive;
    segmentPrimitiveRef.current = segmentPrimitive;

    if (showVolume) {
      volumeSeriesRef.current = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        // Empty priceScaleId puts the histogram in its own overlay scale, which
        // is what keeps it pinned to the bottom instead of squashing price.
        priceScaleId: '',
      });
      volumeSeriesRef.current.priceScale().applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      });
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
      overlaySeriesRef.current.clear();
      priceLinesRef.current = [];
      zonePrimitiveRef.current = null;
      segmentPrimitiveRef.current = null;
    };
  }, [type, showVolume, height, isDark, timeframe, logScale]);

  // ── Price + volume data ──────────────────────────────────────
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series || candles.length === 0) return;

    if (type === 'candlestick' || type === 'bar') {
      series.setData(
        candles.map((candle) => ({
          time: candle.time as Time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
      );
    } else {
      series.setData(
        candles.map((candle) => ({ time: candle.time as Time, value: candle.close })),
      );
    }

    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.setData(
        candles.map((candle) => ({
          time: candle.time as Time,
          value: candle.volume,
          color:
            candle.close >= candle.open ? 'rgba(34,197,94,0.32)' : 'rgba(239,68,68,0.32)',
        })),
      );
    }

    // Fit on the first load of a series. In live mode later updates leave the
    // viewport where the user put it.
    if (!hasFittedRef.current || !live) {
      chartRef.current?.timeScale().fitContent();
      hasFittedRef.current = true;
    }
  }, [candles, type, live]);

  // ── Overlays ─────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const active = new Set(overlays.map((overlay) => overlay.key));

    // Remove overlays the user has switched off.
    for (const [key, series] of overlaySeriesRef.current.entries()) {
      if (!active.has(key)) {
        chart.removeSeries(series);
        overlaySeriesRef.current.delete(key);
      }
    }

    for (const overlay of overlays) {
      let series = overlaySeriesRef.current.get(overlay.key);
      if (!series) {
        series = chart.addLineSeries({
          color: overlay.colour,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        overlaySeriesRef.current.set(overlay.key, series);
      }
      series.setData(
        overlay.data
          .filter((point) => Number.isFinite(point.value))
          .map((point) => ({ time: point.time as Time, value: point.value })),
      );
    }
  }, [overlays]);

  // ── Horizontal levels: S/R plus signal and pattern lines ─────
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series) return;

    for (const line of priceLinesRef.current) {
      series.removePriceLine(line);
    }
    priceLinesRef.current = [];

    // Only the strongest few — a chart with twelve horizontal lines conveys
    // less than one with three.
    for (const level of levels.filter((item) => item.strength >= 45).slice(0, 5)) {
      priceLinesRef.current.push(
        series.createPriceLine({
          price: level.price,
          color: level.kind === 'SUPPORT' ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: level.kind === 'SUPPORT' ? 'S' : 'R',
        }),
      );
    }

    // Signal levels come after so they sit on top of the S/R noise.
    for (const line of priceLines) {
      if (!Number.isFinite(line.price)) continue;
      priceLinesRef.current.push(
        series.createPriceLine({
          price: line.price,
          color: line.colour,
          lineWidth: line.width ?? 1,
          lineStyle: LINE_STYLE[line.style ?? 'solid'],
          axisLabelVisible: true,
          title: line.title,
        }),
      );
    }
  }, [levels, priceLines]);

  // ── Markers ──────────────────────────────────────────────────
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series) return;

    series.setMarkers(
      markers.map((marker) => ({
        time: marker.time as Time,
        position: marker.position,
        color: marker.colour,
        shape: marker.shape,
        text: marker.text,
      })),
    );
  }, [markers]);

  // ── Zones & segments ─────────────────────────────────────────
  useEffect(() => {
    zonePrimitiveRef.current?.setData(zones, barTimes);
    // A primitive redraw is only scheduled by the library on the next chart
    // update, so nudge the time scale to force one immediately.
    chartRef.current?.timeScale().applyOptions({});
  }, [zones, barTimes]);

  useEffect(() => {
    segmentPrimitiveRef.current?.setData(segments, barTimes);
    chartRef.current?.timeScale().applyOptions({});
  }, [segments, barTimes]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
