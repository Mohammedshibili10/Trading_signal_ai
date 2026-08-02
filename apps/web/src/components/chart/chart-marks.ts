import type { ChartSegment, ChartZone } from '@/components/chart/chart-primitives';
import type { ChartMarker, ChartPriceLine } from '@/components/chart/price-chart';
import type {
  CandlestickPattern,
  ChartPattern,
  PriceActionAnalysis,
  SmcAnalysis,
  TradeSignal,
} from '@/types';

/**
 * Turns analysis output into chart annotations.
 *
 * Kept out of the chart component and out of the page: the chart should not
 * know what a fair value gap is, and the page should not know how to colour
 * one. Everything here is pure, so what lands on the canvas is testable and
 * changing a colour doesn't mean touching a rendering effect.
 *
 * The recurring judgement in this file is *how much* to draw. The engine finds
 * far more than is worth showing — every order block, every gap, every pattern
 * at any confidence. A chart carrying all of it communicates less than one
 * carrying the four things that matter, so each builder caps and ranks.
 */

const BULL = '#22c55e';
const BEAR = '#ef4444';
const NEUTRAL = '#f59e0b';
const ACCENT = '#6366f1';

/* ── Signal: entry, stop, targets ─────────────────────────────── */

/**
 * The trade plan as price lines.
 *
 * This is the one annotation set that is always worth the space — a signal you
 * can't see against the price is a number in a table, not a plan.
 */
export function signalPriceLines(signal: TradeSignal | null | undefined): ChartPriceLine[] {
  if (!signal || signal.action === 'WAIT' || signal.action === 'HOLD') return [];

  const lines: ChartPriceLine[] = [
    { id: 'entry', price: signal.entry, colour: ACCENT, title: 'Entry', style: 'solid', width: 2 },
    { id: 'stop', price: signal.stopLoss, colour: BEAR, title: 'Stop', style: 'dashed', width: 2 },
  ];

  for (const target of signal.targets ?? []) {
    lines.push({
      id: `t${target.level}`,
      price: target.price,
      colour: BULL,
      // The R multiple belongs on the axis label: "T2" alone doesn't say
      // whether reaching it is worth the risk of the stop above.
      title: `T${target.level} · ${target.rr.toFixed(1)}R`,
      style: 'dotted',
      width: 1,
    });
  }

  return lines;
}

/** The entry zone as a band, so "enter around here" doesn't read as a single tick. */
export function signalZones(signal: TradeSignal | null | undefined, firstBarTime: number): ChartZone[] {
  if (!signal || signal.action === 'WAIT' || signal.action === 'HOLD') return [];
  if (!signal.entryZone) return [];

  const bullish = signal.action === 'BUY';

  return [
    {
      id: 'entry-zone',
      from: firstBarTime,
      top: signal.entryZone.high,
      bottom: signal.entryZone.low,
      fill: bullish ? 'rgba(99,102,241,0.10)' : 'rgba(99,102,241,0.10)',
      border: 'rgba(99,102,241,0.35)',
      label: 'Entry zone',
    },
    // Risk and reward as regions. Seeing the red band dwarf the green one is a
    // faster read of a bad R:R than the ratio printed in a cell.
    {
      id: 'risk-zone',
      from: firstBarTime,
      top: bullish ? signal.entry : signal.stopLoss,
      bottom: bullish ? signal.stopLoss : signal.entry,
      fill: 'rgba(239,68,68,0.07)',
    },
    ...(signal.targets?.[0]
      ? [
          {
            id: 'reward-zone',
            from: firstBarTime,
            top: bullish ? signal.targets[0].price : signal.entry,
            bottom: bullish ? signal.entry : signal.targets[0].price,
            fill: 'rgba(34,197,94,0.07)',
          } satisfies ChartZone,
        ]
      : []),
  ];
}

/* ── Smart money concepts ─────────────────────────────────────── */

/**
 * Order blocks and fair value gaps.
 *
 * Unmitigated zones extend to the right edge and are drawn solid; mitigated and
 * filled ones stop at their bar and go dashed. That distinction is the entire
 * point of the concept — a filled gap is history, an open one is a magnet.
 */
export function smcZones(smc: SmcAnalysis | null | undefined, limit = 4): ChartZone[] {
  if (!smc) return [];

  const zones: ChartZone[] = [];

  const blocks = [...(smc.orderBlocks ?? [])]
    // Live zones first, then by strength — a mitigated block only earns space
    // if nothing live is competing for it.
    .sort((a, b) => Number(a.mitigated) - Number(b.mitigated) || b.strength - a.strength)
    .slice(0, limit);

  for (const [index, block] of blocks.entries()) {
    const bullish = block.kind === 'BULLISH';
    zones.push({
      id: `ob-${index}`,
      from: block.time,
      to: block.mitigated ? undefined : undefined,
      top: block.top,
      bottom: block.bottom,
      fill: bullish
        ? `rgba(34,197,94,${block.mitigated ? 0.05 : 0.12})`
        : `rgba(239,68,68,${block.mitigated ? 0.05 : 0.12})`,
      border: bullish
        ? `rgba(34,197,94,${block.mitigated ? 0.25 : 0.5})`
        : `rgba(239,68,68,${block.mitigated ? 0.25 : 0.5})`,
      dashed: block.mitigated,
      label: `OB${block.mitigated ? ' (mitigated)' : ''}`,
    });
  }

  const gaps = [...(smc.fairValueGaps ?? [])]
    .sort((a, b) => Number(a.filled) - Number(b.filled) || b.sizePercent - a.sizePercent)
    .slice(0, limit);

  for (const [index, gap] of gaps.entries()) {
    const bullish = gap.kind === 'BULLISH';
    zones.push({
      id: `fvg-${index}`,
      from: gap.time,
      top: gap.top,
      bottom: gap.bottom,
      fill: bullish
        ? `rgba(34,211,238,${gap.filled ? 0.04 : 0.1})`
        : `rgba(244,114,182,${gap.filled ? 0.04 : 0.1})`,
      border: bullish
        ? `rgba(34,211,238,${gap.filled ? 0.2 : 0.45})`
        : `rgba(244,114,182,${gap.filled ? 0.2 : 0.45})`,
      dashed: gap.filled,
      label: `FVG${gap.filled ? ' (filled)' : ''}`,
    });
  }

  return zones;
}

/** Break of structure and change of character, marked on the bar they printed. */
export function smcMarkers(smc: SmcAnalysis | null | undefined, limit = 6): ChartMarker[] {
  if (!smc?.structure) return [];

  return smc.structure.slice(-limit).map((event) => {
    const bullish = event.direction === 'BULLISH';
    return {
      time: event.time,
      position: bullish ? 'belowBar' : 'aboveBar',
      colour: bullish ? BULL : BEAR,
      shape: 'circle',
      text: event.type,
    } satisfies ChartMarker;
  });
}

/** Swept and resting liquidity as thin horizontal bands. */
export function liquidityZones(smc: SmcAnalysis | null | undefined, limit = 3): ChartZone[] {
  if (!smc?.liquidity) return [];

  return smc.liquidity
    .filter((pool) => !pool.swept)
    .slice(0, limit)
    .map((pool, index) => {
      // A liquidity pool is a price, not a range. Give it a hairline band so it
      // is visible without pretending to a width it doesn't have.
      const halfWidth = pool.price * 0.0006;
      return {
        id: `liq-${index}`,
        from: pool.time,
        top: pool.price + halfWidth,
        bottom: pool.price - halfWidth,
        fill: pool.kind === 'BUY_SIDE' ? 'rgba(250,204,21,0.16)' : 'rgba(168,85,247,0.16)',
        border: pool.kind === 'BUY_SIDE' ? 'rgba(250,204,21,0.45)' : 'rgba(168,85,247,0.45)',
        label: pool.label,
      } satisfies ChartZone;
    });
}

/* ── Price action ─────────────────────────────────────────────── */

/** Trendlines, drawn dashed once broken. */
export function trendlineSegments(
  priceAction: PriceActionAnalysis | null | undefined,
): ChartSegment[] {
  if (!priceAction?.trendlines) return [];

  return priceAction.trendlines.slice(0, 3).map((line, index) => ({
    id: `tl-${index}`,
    points: [line.from, line.to],
    colour: line.kind === 'SUPPORT' ? 'rgba(34,197,94,0.75)' : 'rgba(239,68,68,0.75)',
    width: line.intact ? 1.5 : 1,
    dashed: !line.intact,
    label: `${line.touches} touches${line.intact ? '' : ' · broken'}`,
  }));
}

/** Breakouts, retests and pullbacks on the bars they happened. */
export function priceActionMarkers(
  priceAction: PriceActionAnalysis | null | undefined,
  limit = 6,
): ChartMarker[] {
  if (!priceAction?.events) return [];

  return priceAction.events
    .filter((event) => event.confidence >= 50)
    .slice(-limit)
    .map((event) => {
      const bullish = event.stance === 'BULLISH';
      const bearish = event.stance === 'BEARISH';
      return {
        time: event.time,
        position: bullish ? 'belowBar' : 'aboveBar',
        colour: bullish ? BULL : bearish ? BEAR : NEUTRAL,
        shape: bullish ? 'arrowUp' : bearish ? 'arrowDown' : 'circle',
        text: event.type.replace('_', ' ').toLowerCase(),
      } satisfies ChartMarker;
    });
}

/* ── Patterns ─────────────────────────────────────────────────── */

/** Chart patterns as their pivot outline, plus neckline and target levels. */
export function patternSegments(patterns: ChartPattern[] | null | undefined): ChartSegment[] {
  if (!patterns) return [];

  return patterns
    .filter((pattern) => pattern.status !== 'FAILED' && pattern.points.length >= 2)
    .slice(0, 2)
    .map((pattern, index) => ({
      id: `pat-${index}`,
      points: pattern.points.map((point) => ({ time: point.time, price: point.price })),
      colour:
        pattern.stance === 'BULLISH' ? BULL : pattern.stance === 'BEARISH' ? BEAR : NEUTRAL,
      width: 1.5,
      dashed: pattern.status === 'FORMING',
      showPoints: true,
      label: `${pattern.name}${pattern.status === 'FORMING' ? ' (forming)' : ''}`,
    }));
}

export function patternPriceLines(patterns: ChartPattern[] | null | undefined): ChartPriceLine[] {
  if (!patterns) return [];

  const lines: ChartPriceLine[] = [];
  for (const [index, pattern] of patterns.filter((p) => p.status !== 'FAILED').slice(0, 2).entries()) {
    if (pattern.neckline) {
      lines.push({
        id: `neck-${index}`,
        price: pattern.neckline,
        colour: 'rgba(148,163,184,0.7)',
        title: 'Neckline',
        style: 'dashed',
        width: 1,
      });
    }
    if (pattern.target) {
      lines.push({
        id: `ptarget-${index}`,
        price: pattern.target,
        colour: pattern.stance === 'BEARISH' ? 'rgba(239,68,68,0.55)' : 'rgba(34,197,94,0.55)',
        title: `${pattern.name} target`,
        style: 'dotted',
        width: 1,
      });
    }
  }
  return lines;
}

/**
 * Candlestick patterns.
 *
 * Filtered by context-adjusted reliability, not by name. The engine's own
 * position is that most single-candle patterns resolve near a coin flip, so
 * marking every doji it finds would be marking noise.
 */
export function candlestickMarkers(
  patterns: CandlestickPattern[] | null | undefined,
  minReliability = 55,
  limit = 8,
): ChartMarker[] {
  if (!patterns) return [];

  return patterns
    .filter((pattern) => pattern.reliability >= minReliability)
    .slice(-limit)
    .map((pattern) => {
      const bullish = pattern.stance === 'BULLISH';
      const bearish = pattern.stance === 'BEARISH';
      return {
        time: pattern.time,
        position: bullish ? 'belowBar' : 'aboveBar',
        colour: bullish ? BULL : bearish ? BEAR : NEUTRAL,
        shape: bullish ? 'arrowUp' : bearish ? 'arrowDown' : 'circle',
        text: `${pattern.name} ${pattern.reliability.toFixed(0)}%`,
      } satisfies ChartMarker;
    });
}

/* ── Deduplication ────────────────────────────────────────────── */

/**
 * Markers stack visually when several land on the same bar and side, which
 * turns a readable chart into an unreadable one. One per bar-and-side wins.
 */
export function dedupeMarkers(markers: ChartMarker[]): ChartMarker[] {
  const seen = new Map<string, ChartMarker>();
  for (const marker of markers) {
    const key = `${marker.time}:${marker.position}`;
    if (!seen.has(key)) seen.set(key, marker);
  }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}
