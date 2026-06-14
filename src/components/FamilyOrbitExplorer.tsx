import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { familyColors } from "../lib/constants";
import type { Strain } from "../types/strain";
import { StrainRail } from "./StrainRail";
import { ShrimpLogoMark } from "./ShrimpLogoMark";
import { useIsMobile } from "../hooks/useIsMobile";

// Family ordering around each ring — curated by colour adjacency so neighbours
// share related hues (warm reds/oranges/browns cluster, cool greens/blues cluster,
// achromatic black/white bridge the wrap). See geo validation: no overlaps.
const NEO_ORDER    = ["Red", "Orange", "Brown", "Yellow", "Green", "Blue", "Black", "White"];
const CARIDINA_ORDER = ["Sulawesi", "Tiger", "Bamboo", "Amano", "Crystal", "Taiwan Bee"];
const FAMILY_ORDER = [...NEO_ORDER, ...CARIDINA_ORDER];

const CARIDINA_SET = new Set(CARIDINA_ORDER);

const FAMILY_GLOW: Record<string, string> = {
  Red:          "rgba(216,31,47,0.45)",
  Orange:       "rgba(240,111,29,0.45)",
  Yellow:       "rgba(242,194,48,0.4)",
  Green:        "rgba(21,148,92,0.45)",
  Blue:         "rgba(52,152,219,0.45)",
  Black:        "rgba(180,180,200,0.35)",
  Brown:        "rgba(180,100,40,0.45)",
  White:        "rgba(220,220,240,0.4)",
  Natural:      "rgba(120,180,80,0.4)",
  Crystal:      "rgba(168,212,248,0.55)",
  "Taiwan Bee": "rgba(42,80,224,0.55)",
  Tiger:        "rgba(224,120,32,0.45)",
  Sulawesi:     "rgba(224,24,40,0.60)",
  Amano:        "rgba(122,170,80,0.40)",
  Bamboo:       "rgba(154,112,64,0.40)",
};

const FAMILY_TEXT: Record<string, string> = {
  Red: "#fff", Orange: "#fff", Yellow: "#1a1a1a", Green: "#fff",
  Blue: "#fff", Black: "#fff", Brown: "#fff", White: "#1a1a1a",
  Natural: "#fff", Crystal: "#1a1a1a", "Taiwan Bee": "#fff",
  Tiger: "#fff", Sulawesi: "#fff", Amano: "#fff", Bamboo: "#fff",
};

// Bounded-organic radii. Neo ring pulled inward, Caridina pushed outward so the
// angular alignments at top (Red/Sulawesi) and bottom (Green/Amano) stay clear.
// Validated: Neo moon-orbit gap 29px, Caridina 140px, inter-ring node gap 18px.
const FAMILY_ORBIT_RADIUS: Record<string, number> = {
  Red: 172, Orange: 165, Brown: 176, Yellow: 167,
  Green: 174, Blue: 167, Black: 174, White: 168,
  Natural: 0,
  Sulawesi: 252, Tiger: 236, Bamboo: 246,
  Amano: 238, Crystal: 248, "Taiwan Bee": 240,
};

const VB         = 640;
const NODE_R_BASE = 20;
const NODE_R_MAX  = 34;
// Radius of the moon orbit ring relative to the planet centre
const MOON_ORBIT_OFFSET = 20; // px beyond nodeR

function nodeRadius(count: number): number {
  return Math.max(NODE_R_BASE, Math.min(NODE_R_MAX, NODE_R_BASE + count * 2));
}

// ---------------------------------------------------------------------------
// Phase 3/4 — Breeding relationship arcs (family-level, data-driven)
// ---------------------------------------------------------------------------
type ArcType = "crosses" | "hybrid" | "stabilizing" | "impossible";

/**
 * Generate family-level arcs from strain crossing data.
 * Single source of truth: derives from strains.json compatible[] entries.
 * Groups by (family A, family B) pairs, takes the most common stability.
 */
function generateFamilyArcs(strains: Strain[]): Array<{
  from: string;
  to: string;
  type: ArcType;
  label: string;
}> {
  // Collect all cross-family crossing entries indexed by key
  const familyPairs = new Map<string, Array<{ stability: string; offspring: string }>>();

  for (const strain of strains) {
    for (const cross of strain.compatible ?? []) {
      const key = `${strain.family}→${cross.with}`;
      if (!familyPairs.has(key)) {
        familyPairs.set(key, []);
      }
      familyPairs.get(key)!.push({ stability: cross.stability, offspring: cross.offspring });
    }
  }

  const arcs: Array<{ from: string; to: string; type: ArcType; label: string }> = [];
  const seen = new Set<string>();

  for (const [key, crosses] of familyPairs) {
    const [from, to] = key.split("→");

    // Avoid duplicates by checking both directions
    const revKey = `${to}→${from}`;
    if (seen.has(key) || seen.has(revKey)) continue;
    seen.add(key);

    // Determine type: prioritize impossible > stabilizing > hybrid > crosses
    let type: ArcType = "crosses";
    if (crosses.some((c) => c.stability === "impossible")) {
      type = "impossible";
    } else if (crosses.some((c) => c.stability === "stabilizing")) {
      type = "stabilizing";
    } else if (crosses.some((c) => c.stability === "unstable")) {
      type = "hybrid";
    } else if (crosses.some((c) => c.stability === "stable")) {
      type = "crosses";
    }

    // Sample label from first offspring
    const label = `${from} × ${to} → ${crosses[0]?.offspring || "offspring"}`;

    arcs.push({ from, to, type, label });
  }

  return arcs;
}

const ARC_COLOR: Record<ArcType, string> = {
  crosses:     "rgba(47,196,181,0.42)",    // teal — stable
  hybrid:      "rgba(255,196,80,0.35)",   // amber — unstable
  stabilizing: "rgba(160,100,240,0.32)",  // violet — stabilizing
  impossible:  "rgba(180,60,60,0.32)",    // dark red — impossible
};

const ARC_COLOR_ACTIVE: Record<ArcType, string> = {
  crosses:     "rgba(47,196,181,0.70)",   // teal — stable
  hybrid:      "rgba(255,196,80,0.65)",   // amber — unstable
  stabilizing: "rgba(180,130,255,0.65)",  // bright violet — stabilizing
  impossible:  "rgba(220,80,80,0.65)",    // bright red — impossible
};

/**
 * Arc between two nodes that sit at *different* orbit radii (e.g. a Neocaridina
 * node at r≈170 and a Caridina node at r≈245). A single fixed-radius arc would
 * dangle in empty space because neither endpoint lands on a node centre. This
 * anchors each endpoint to its own node and bows the control point outward along
 * the angular bisector, so the curve always connects cleanly planet-to-planet.
 */
function getNodeArcPath(
  fromAngle: number,
  fromR: number,
  toAngle: number,
  toR: number,
  curvature = 0.30,
): string {
  const x1 = fromR * Math.cos(fromAngle);
  const y1 = fromR * Math.sin(fromAngle);
  const x2 = toR * Math.cos(toAngle);
  const y2 = toR * Math.sin(toAngle);
  const delta = ((toAngle - fromAngle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const effectiveMid = fromAngle + delta / 2;
  const midR = ((fromR + toR) / 2) * (1 + curvature);
  const mx = midR * Math.cos(effectiveMid);
  const my = midR * Math.sin(effectiveMid);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} Q ${mx.toFixed(2)} ${my.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/**
 * Quadratic Bézier arc between two absolute SVG points.
 * Control point perpendicular to the chord, scaled by chord length.
 * Ensures consistent, readable curves regardless of planet positions.
 * Used for moon-to-moon cross-family connections.
 *
 * @param x1, y1 — start point
 * @param x2, y2 — end point
 * @param bundleOffset — optional perpendicular offset for arc bundling (default 0)
 * @returns SVG path string (M ... Q ...)
 */
function getMoonArcPath(x1: number, y1: number, x2: number, y2: number, bundleOffset = 0): string {
  // Chord vector and midpoint
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chordLen = Math.sqrt(dx * dx + dy * dy);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  // Normal vector perpendicular to chord (rotated 90° CCW)
  const nx = -dy / chordLen;
  const ny = dx / chordLen;

  // Bow depth: more conservative scaling
  // Short arcs get more prominent curves (12-20px), long arcs stay subtle (8-15px)
  const bow = chordLen < 100
    ? Math.max(12, Math.min(20, chordLen * 0.15))
    : Math.max(8, Math.min(15, chordLen * 0.08));

  // Control point: midpoint + normal × (bow + bundleOffset)
  const cx = mx + nx * (bow + bundleOffset);
  const cy = my + ny * (bow + bundleOffset);

  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Starfield (deterministic)
// ---------------------------------------------------------------------------
const STARS: { x: number; y: number; r: number; op: number }[] = (() => {
  const stars: { x: number; y: number; r: number; op: number }[] = [];
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };
  for (let i = 0; i < 110; i++) {
    const angle = rand() * Math.PI * 2;
    const dist  = 278 + rand() * 38;
    stars.push({
      x: Math.round(Math.cos(angle) * dist * 10) / 10,
      y: Math.round(Math.sin(angle) * dist * 10) / 10,
      r: rand() < 0.2 ? 1.4 : rand() < 0.5 ? 1.0 : 0.7,
      op: 0.15 + rand() * 0.48,
    });
  }
  for (let i = 0; i < 20; i++) {
    const angle = rand() * Math.PI * 2;
    const dist  = 212 + rand() * 16;
    stars.push({
      x: Math.round(Math.cos(angle) * dist * 10) / 10,
      y: Math.round(Math.sin(angle) * dist * 10) / 10,
      r: 0.5,
      op: 0.08 + rand() * 0.12,
    });
  }
  return stars;
})();

function hexPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, k) => {
    const a = (k / 6) * Math.PI * 2 - Math.PI / 6;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(" ");
}

// ---------------------------------------------------------------------------
// Moon position helpers
// ---------------------------------------------------------------------------
interface MoonDatum {
  strain: Strain;
  mx: number; // absolute SVG x
  my: number; // absolute SVG y
  r: number;  // moon radius
}

function buildMoons(
  strains: Strain[],
  planetNx: number,
  planetNy: number,
  nodeR: number,
): MoonDatum[] {
  const moonOrbitR = nodeR + MOON_ORBIT_OFFSET;
  return strains.map((s, i) => {
    const angle = (i / strains.length) * 2 * Math.PI - Math.PI / 2;
    const mx = planetNx + moonOrbitR * Math.cos(angle);
    const my = planetNy + moonOrbitR * Math.sin(angle);
    const r = Math.max(2.5, Math.min(5, 2.5 + (s.popularity ?? 0) * 0.5));
    return { strain: s, mx, my, r };
  });
}

/**
 * Midpoint of a quadratic Bézier arc at t=0.5, given start/end points and the
 * same bow logic used in getMoonArcPath. Keeps the offspring label centred on
 * the visible arc rather than on the chord midpoint.
 */
function getMoonArcMidpoint(
  x1: number, y1: number,
  x2: number, y2: number,
  bundleOffset = 0,
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chordLen = Math.sqrt(dx * dx + dy * dy);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const nx = -dy / chordLen;
  const ny =  dx / chordLen;
  const bow = chordLen < 100
    ? Math.max(12, Math.min(20, chordLen * 0.15))
    : Math.max(8,  Math.min(15, chordLen * 0.08));
  const cx = mx + nx * (bow + bundleOffset);
  const cy = my + ny * (bow + bundleOffset);
  // B(0.5) = 0.25*P0 + 0.5*Ctrl + 0.25*P1
  return {
    x: 0.25 * x1 + 0.5 * cx + 0.25 * x2,
    y: 0.25 * y1 + 0.5 * cy + 0.25 * y2,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FamilyItem {
  family: string;
  strains: Strain[];
  color: string;
  textColor: string;
  glow: string;
  angle: number;
  orbitR: number;
  nx: number;
  ny: number;
  nodeR: number;
  isCaridina: boolean;
}

interface Props {
  visibleStrains: Strain[];
  onSelect: React.Dispatch<React.SetStateAction<string | null>>;
  showBreedingArcs: boolean;
}

export function FamilyOrbitExplorer({ visibleStrains, onSelect, showBreedingArcs }: Props) {
  const isMobile = useIsMobile();

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [moonA,      setMoonA]      = useState<string | null>(null); // family slug
  const [moonB,      setMoonB]      = useState<string | null>(null);
  const [hovered,    setHovered]    = useState<string | null>(null);
  const [sunHovered, setSunHovered] = useState(false);
  const [railFamily, setRailFamily] = useState<string | null>(null);
  const [railOpen,   setRailOpen]   = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [mobileLabel, setMobileLabel] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const keyboardFocus = (key: string) => () => setFocusKey(key);
  const clearFocusKey = () => setFocusKey(null);

  // -------------------------------------------------------------------------
  // Derived geometry — families, planets, moons
  // -------------------------------------------------------------------------
  const families = useMemo<FamilyItem[]>(() => {
    const grouped = new Map<string, Strain[]>();
    for (const s of visibleStrains) {
      if (!grouped.has(s.family)) grouped.set(s.family, []);
      grouped.get(s.family)!.push(s);
    }
    const present = FAMILY_ORDER.filter((f) => grouped.has(f));

    // Two separate rings: Neo (inner) and Caridina (outer)
    const neoFamilies      = present.filter((f) => !CARIDINA_SET.has(f));
    const caridinaFamilies = present.filter((f) =>  CARIDINA_SET.has(f));

    const items: FamilyItem[] = [];

    const placeRing = (fams: string[], ringOffset: number) => {
      const count = fams.length;
      fams.forEach((family, i) => {
        const angle  = (i / count) * 2 * Math.PI - Math.PI / 2 + ringOffset;
        const orbitR = FAMILY_ORBIT_RADIUS[family] ?? 180;
        const nx     = Math.cos(angle) * orbitR;
        const ny     = Math.sin(angle) * orbitR;
        const ss     = grouped.get(family) ?? [];
        items.push({
          family,
          strains: ss,
          color:     familyColors[family] ?? "#888",
          textColor: FAMILY_TEXT[family]  ?? "#fff",
          glow:      FAMILY_GLOW[family]  ?? "rgba(255,255,255,0.3)",
          angle,
          orbitR,
          nx,
          ny,
          nodeR: nodeRadius(ss.length),
          isCaridina: CARIDINA_SET.has(family),
        });
      });
    };

    placeRing(neoFamilies, 0);
    placeRing(caridinaFamilies, 0);
    return items;
  }, [visibleStrains]);

  const moonsByFamily = useMemo(() => {
    const map = new Map<string, MoonDatum[]>();
    for (const item of families) {
      map.set(item.family, buildMoons(item.strains, item.nx, item.ny, item.nodeR));
    }
    return map;
  }, [families]);

  const firstFamily = families[0] ?? null;

  // -------------------------------------------------------------------------
  // Breeding arcs (family-level)
  // -------------------------------------------------------------------------
  const familyArcs = useMemo(() => generateFamilyArcs(visibleStrains), [visibleStrains]);

  // -------------------------------------------------------------------------
  // Stats for the info bar
  // -------------------------------------------------------------------------
  const neoCount      = visibleStrains.filter((s) => !CARIDINA_SET.has(s.family)).length;
  const caridineCount = visibleStrains.filter((s) =>  CARIDINA_SET.has(s.family)).length;
  const totalCount    = visibleStrains.length;

  // -------------------------------------------------------------------------
  // Active families set (for dimming)
  // -------------------------------------------------------------------------
  const activeFamilies = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    if (moonA) s.add(moonA);
    if (moonB) s.add(moonB);
    return s;
  }, [moonA, moonB]);

  // -------------------------------------------------------------------------
  // Breeding arcs — moon-level connections between two active families
  // -------------------------------------------------------------------------
  const moonArcs = useMemo(() => {
    if (!moonA || !moonB) return [];
    const moonsA = moonsByFamily.get(moonA) ?? [];
    const moonsB = moonsByFamily.get(moonB) ?? [];

    const results: Array<{
      fromMoon: MoonDatum;
      toMoon:   MoonDatum;
      type:     ArcType;
      label:    string;
      offspring: string;
    }> = [];

    for (const ma of moonsA) {
      for (const mb of moonsB) {
        const crossings = ma.strain.compatible?.filter(
          (c) => c.with === moonB && mb.strain.name.startsWith(c.offspring.split(" ")[0]),
        ) ?? [];

        if (crossings.length === 0) {
          // Check family-level arc as fallback
          const familyArc = familyArcs.find(
            (a) => (a.from === moonA && a.to === moonB) || (a.from === moonB && a.to === moonA),
          );
          if (familyArc) {
            results.push({
              fromMoon: ma,
              toMoon:   mb,
              type:     familyArc.type,
              label:    familyArc.label,
              offspring: familyArc.label.split("→")[1]?.trim() ?? "",
            });
          }
        } else {
          for (const cross of crossings) {
            results.push({
              fromMoon: ma,
              toMoon:   mb,
              type:     cross.stability === "stable" ? "crosses"
                       : cross.stability === "unstable" ? "hybrid"
                       : cross.stability === "stabilizing" ? "stabilizing"
                       : "impossible",
              label:    `${ma.strain.name} × ${mb.strain.name} → ${cross.offspring}`,
              offspring: cross.offspring,
            });
          }
        }
      }
    }
    return results;
  }, [moonA, moonB, moonsByFamily, familyArcs]);

  // For the labelled arcs subset — one label per unique offspring type
  const labelledArcIndices = useMemo(() => {
    const seen = new Set<string>();
    const indices = new Set<number>();
    moonArcs.forEach((arc, i) => {
      if (!seen.has(arc.offspring)) {
        seen.add(arc.offspring);
        indices.add(i);
      }
    });
    return indices;
  }, [moonArcs]);

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------
  const handleFamilyClick = useCallback((family: string) => {
    setHasInteracted(true);
    setMobileLabel(null);

    if (isMobile) {
      // On mobile, first tap shows label; second tap selects the family
      if (mobileLabel !== family) {
        setMobileLabel(family);
        return;
      }
    }

    // Fill moonA first, then moonB; clicking the same family twice deselects it
    if (moonA === family) {
      setMoonA(moonB);
      setMoonB(null);
      setRailFamily(moonB);
      setRailOpen(!!moonB);
      return;
    }
    if (moonB === family) {
      setMoonB(null);
      return;
    }
    if (!moonA) {
      setMoonA(family);
      setRailFamily(family);
      setRailOpen(true);
    } else {
      setMoonB(family);
    }
  }, [isMobile, mobileLabel, moonA, moonB]);

  // -------------------------------------------------------------------------
  // Resize observer — keeps SVG viewBox centred
  // -------------------------------------------------------------------------
  const svgRef = useRef<SVGSVGElement>(null);

  // -------------------------------------------------------------------------
  // SVG viewBox
  // -------------------------------------------------------------------------
  const half = VB / 2;
  const vb   = `-${half} -${half} ${VB} ${VB}`;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="orbit-root">

      {/* Mobile planet name label overlay */}
      <AnimatePresence>
        {isMobile && mobileLabel && (() => {
          const item = families.find((f) => f.family === mobileLabel);
          if (!item) return null;
          return (
            <motion.div
              key={`mobile-label-${mobileLabel}`}
              className="mobile-planet-label"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              style={{ color: item.color }}
            >
              {mobileLabel}
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Onboarding hint overlay (HTML, always legible) */}
      <AnimatePresence>
        {!hasInteracted && (
          <motion.div
            key="orbit-onboarding"
            className="orbit-onboarding"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.4 } }}
            transition={{ delay: 1.8, duration: 0.7 }}
            aria-hidden="true"
          >
            <span className="orbit-onboarding__arrow">↓</span>
            <span className="orbit-onboarding__text">tap a planet</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Info bar */}
      <div className="orbit-info-bar" aria-live="polite">
        <span className="orbit-info-bar__count">
          {totalCount} strain{totalCount !== 1 ? "s" : ""}
        </span>
        <span className="orbit-info-bar__sep">·</span>
        <span className="orbit-info-bar__neo">{neoCount} Neo</span>
        <span className="orbit-info-bar__sep">·</span>
        <span className="orbit-info-bar__caridina">{caridineCount} Caridina</span>
      </div>

      <svg
        ref={svgRef}
        className="orbit-svg"
        viewBox={vb}
        aria-label="Shrimp family orbit explorer"
        role="img"
      >
        <defs>
          {/* Radial glow filter for active/hovered nodes */}
          <filter id="node-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          {/* Softer glow for moons */}
          <filter id="moon-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          {/* Sun corona glow */}
          <filter id="sun-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          {/* Spherical depth gradient — dark-edge vignette for 3-D feel */}
          <radialGradient id="planet-depth" cx="65%" cy="35%" r="65%">
            <stop offset="0%"   stopColor="rgba(255,255,255,0.0)" />
            <stop offset="60%"  stopColor="rgba(0,0,0,0.0)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.32)" />
          </radialGradient>
          {/* Specular highlight — small bright kiss at top-left */}
          <radialGradient id="planet-shade" cx="28%" cy="22%" r="38%">
            <stop offset="0%"   stopColor="rgba(255,255,255,0.38)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.0)" />
          </radialGradient>
          {/* Sun gradients */}
          <radialGradient id="sun-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="rgba(255,210,60,0.18)" />
            <stop offset="60%"  stopColor="rgba(255,180,30,0.08)" />
            <stop offset="100%" stopColor="rgba(255,150,0,0.0)" />
          </radialGradient>
          <radialGradient id="sun-core" cx="40%" cy="35%" r="65%">
            <stop offset="0%"   stopColor="#ffe066" />
            <stop offset="55%"  stopColor="#ffb020" />
            <stop offset="100%" stopColor="#e07000" />
          </radialGradient>
        </defs>

        {/* ----------------------------------------------------------------
            Starfield (static, decorative)
        ---------------------------------------------------------------- */}
        <g aria-hidden="true">
          {STARS.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#ffffff" opacity={s.op} />
          ))}
        </g>

        {/* ----------------------------------------------------------------
            Orbit rings
        ---------------------------------------------------------------- */}
        <g aria-hidden="true">
          {[168, 176, 240, 252].map((r) => (
            <circle key={r} cx={0} cy={0} r={r}
              fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
          ))}
        </g>

        {/* ----------------------------------------------------------------
            Family-level breeding arcs (background layer)
        ---------------------------------------------------------------- */}
        {showBreedingArcs && (
          <g aria-label="Breeding relationship arcs" aria-hidden={!showBreedingArcs}>
            {familyArcs.map((arc, i) => {
              const fromItem = families.find((f) => f.family === arc.from);
              const toItem   = families.find((f) => f.family === arc.to);
              if (!fromItem || !toItem) return null;
              const isActive = activeFamilies.has(arc.from) || activeFamilies.has(arc.to);
              const d = getNodeArcPath(
                fromItem.angle, fromItem.orbitR,
                toItem.angle,   toItem.orbitR,
              );
              return (
                <g key={`arc-${i}`}>
                  <motion.path
                    d={d}
                    fill="none"
                    stroke={isActive ? ARC_COLOR_ACTIVE[arc.type] : ARC_COLOR[arc.type]}
                    strokeWidth={isActive ? 1.4 : 0.7}
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ duration: 0.6, delay: i * 0.03, ease: "easeOut" }}
                  />
                  <title>{arc.label}</title>
                </g>
              );
            })}
          </g>
        )}

        {/* ----------------------------------------------------------------
            Moon-level arcs (shown when two families are selected)
        ---------------------------------------------------------------- */}
        {moonA && moonB && (
          <g aria-label="Moon breeding arcs">
            {moonArcs.map((arc, i) => {
              const isImpossible = arc.type === "impossible";
              return (
                <g key={`moon-arc-${i}`}>
                  <motion.path
                    d={getMoonArcPath(
                      arc.fromMoon.mx, arc.fromMoon.my,
                      arc.toMoon.mx,   arc.toMoon.my,
                    )}
                    fill="none"
                    stroke={ARC_COLOR_ACTIVE[arc.type]}
                    strokeWidth={isImpossible ? 0.8 : 1.2}
                    strokeDasharray={isImpossible ? "3 3" : undefined}
                    initial={isImpossible ? { opacity: 0 } : { pathLength: 0, opacity: 0 }}
                    animate={isImpossible ? { opacity: 0.85 } : { pathLength: 1, opacity: 0.85 }}
                    transition={{ duration: 0.45, delay: i * 0.06, ease: "easeOut" }}
                    pointerEvents={isMobile ? "none" : "auto"}
                  />
                  {/* Breeding outcomes: permanent outcome label on the arc midpoint */}
                  {showBreedingArcs && labelledArcIndices.has(i) && (() => {
                    const mid = getMoonArcMidpoint(arc.fromMoon.mx, arc.fromMoon.my, arc.toMoon.mx, arc.toMoon.my);
                    return (
                      <motion.text
                        x={mid.x} y={mid.y}
                        textAnchor="middle" dominantBaseline="central"
                        fontSize="7.5" fontWeight="600"
                        fontFamily="'IBM Plex Mono', monospace"
                        fill={ARC_COLOR_ACTIVE[arc.type]}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.3 + i * 0.06, duration: 0.3 }}
                        style={{
                          pointerEvents: "none",
                          userSelect: "none",
                          paintOrder: "stroke",
                          stroke: "#080c10",
                          strokeWidth: 2.4,
                          strokeLinejoin: "round",
                        }}
                      >
                        {arc.offspring}
                      </motion.text>
                    );
                  })()}
                  <title>{arc.label}</title>
                </g>
              );
            })}
          </g>
        )}

        {/* Spoke lines */}
        {families.map((item, i) => {
          const isActive = activeFamilies.has(item.family);
          const isHov    = hovered === item.family;
          return (
            <motion.line
              key={`spoke-${item.family}`}
              x1={0} y1={0} x2={item.nx} y2={item.ny}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 0.55, delay: i * 0.04, ease: "easeOut" }}
              stroke={
                isActive || isHov
                  ? item.color
                  : item.isCaridina
                  ? "rgba(100,150,255,0.07)"
                  : "rgba(47,196,181,0.07)"
              }
              strokeWidth={isActive ? 0.8 : 0.35}
              style={{ transition: "all 250ms ease" }}
            />
          );
        })}

        {/* Family planet nodes — sorted so active planets paint last (SVG z-order).
            Original index preserved for animation delay staggering. */}
        {[...families]
          .sort((a, b) => {
            const aActive = (a.family === moonA || a.family === moonB) ? 1 : 0;
            const bActive = (b.family === moonA || b.family === moonB) ? 1 : 0;
            return aActive - bActive;
          })
          .map((item) => {
          const i = families.indexOf(item);
          const { nx, ny, nodeR: nr, isCaridina } = item;
          // Highlight driven purely by moonA/moonB slots — no separate activeFamily state
          const isActive  = item.family === moonA || item.family === moonB;
          const isHov     = hovered === item.family;
          const isDimmed  = activeFamilies.size > 0 && !isActive;
          const isPrimary = railFamily === item.family;

          const labelDist = item.orbitR + nr + 22;
          const lx     = Math.cos(item.angle) * labelDist;
          const ly     = Math.sin(item.angle) * labelDist;
          const anchor = Math.abs(nx) < 10 ? "middle" : nx < 0 ? "end" : "start";

          const topStrain    = [...item.strains].sort((a, b) => b.popularity - a.popularity)[0];
          const swatchColors = topStrain?.colors ?? [];

          const moons = moonsByFamily.get(item.family);

          return (
            <motion.g
              key={item.family}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{
                opacity: isDimmed ? 0.32 : 1,
                scale: isActive ? (isPrimary ? 1.15 : 1.08) : isHov ? 1.08 : 1,
              }}
              transition={{ delay: i * 0.05, type: "spring", stiffness: 380, damping: 26 }}
              onClick={() => handleFamilyClick(item.family)}
              onHoverStart={() => setHovered(item.family)}
              onHoverEnd={() => setHovered(null)}
              onFocus={keyboardFocus(`fam:${item.family}`)}
              onBlur={clearFocusKey}
              role="button"
              aria-label={`${item.family}, ${item.strains.length} variet${item.strains.length === 1 ? "y" : "ies"}${isActive ? ", active" : ""}`}
              aria-pressed={isActive}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") handleFamilyClick(item.family);
              }}
              style={{ cursor: "pointer", transformOrigin: `${nx}px ${ny}px` }}
            >
              {/* Transparent hit-area: WCAG 44px (22 SVG units radius ≈ 44px at typical scale) */}
              <circle cx={nx} cy={ny} r={Math.max(nr, 22)} fill="transparent" aria-hidden="true" />
              {/* Shape-true keyboard focus ring (replaces the suppressed rectangular outline) */}
              {focusKey === `fam:${item.family}` && (
                <circle
                  cx={nx} cy={ny} r={nr + 9}
                  fill="none" stroke="#fff" strokeWidth="1.1" strokeDasharray="3 3"
                  opacity={0.9} aria-hidden="true"
                />
              )}
              {/* Pulse animates scale, not the SVG r attribute — framer-motion
                  emits r="undefined" frames when interpolating r directly. */}
              {isPrimary && (
                <motion.circle
                  cx={nx} cy={ny} r={nr + 6}
                  fill="none" stroke={item.color} strokeWidth="0.8"
                  initial={{ scale: 0.95, opacity: 0.8 }}
                  animate={{ scale: (nr + 22) / (nr + 6), opacity: 0 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
                  style={{ transformOrigin: `${nx}px ${ny}px` }}
                />
              )}
              {/* Secondary active planet gets a steady ring instead of a pulse */}
              {isActive && !isPrimary && (
                <circle
                  cx={nx} cy={ny} r={nr + 6}
                  fill="none" stroke={item.color} strokeWidth="0.7"
                  opacity={0.55}
                />
              )}
              {(isActive || isHov) && (
                <circle
                  cx={nx} cy={ny} r={nr + 7}
                  fill={item.color}
                  opacity={isActive ? 0.18 : 0.10}
                  filter="url(#node-glow)"
                />
              )}
              {/* Moon orbit ring */}
              {isActive && (
                <circle
                  cx={nx} cy={ny}
                  r={nr + MOON_ORBIT_OFFSET}
                  fill="none"
                  stroke={item.color}
                  strokeWidth="0.4"
                  strokeDasharray="2 4"
                  opacity={0.25}
                  aria-hidden="true"
                />
              )}
              {item.family === "Sulawesi" && (
                <>
                  <ellipse cx={nx} cy={ny} rx={nr * 2.2} ry={nr * 0.42}
                    fill="none" stroke={item.color} strokeWidth="1.8"
                    opacity={isDimmed ? 0.12 : isActive ? 0.60 : 0.35}
                    transform={`rotate(-18, ${nx}, ${ny})`}
                  />
                  <ellipse cx={nx} cy={ny} rx={nr * 2.85} ry={nr * 0.55}
                    fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8"
                    opacity={isDimmed ? 0.06 : isActive ? 0.35 : 0.15}
                    transform={`rotate(-18, ${nx}, ${ny})`}
                  />
                </>
              )}
              {isCaridina ? (
                <>
                  <polygon
                    points={hexPoints(nx, ny, nr)}
                    fill={item.color}
                    stroke={isActive ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.12)"}
                    strokeWidth={isActive ? 1.2 : 0.6}
                    filter={isActive || isHov ? "url(#node-glow)" : undefined}
                  />
                  {/* Spherical shading overlays (depth + specular) — pure decoration */}
                  <polygon points={hexPoints(nx, ny, nr)} fill="url(#planet-depth)"
                    style={{ pointerEvents: "none" }} aria-hidden="true" />
                  <polygon points={hexPoints(nx, ny, nr)} fill="url(#planet-shade)"
                    style={{ pointerEvents: "none" }} aria-hidden="true" />
                </>
              ) : (
                <>
                  <circle
                    cx={nx} cy={ny} r={nr}
                    fill={item.color}
                    stroke={isActive ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.1)"}
                    strokeWidth={isActive ? 1.2 : 0.5}
                    filter={isActive || isHov ? "url(#node-glow)" : undefined}
                  />
                  {/* Spherical shading overlays (depth + specular) — pure decoration */}
                  <circle cx={nx} cy={ny} r={nr} fill="url(#planet-depth)"
                    style={{ pointerEvents: "none" }} aria-hidden="true" />
                  <circle cx={nx} cy={ny} r={nr} fill="url(#planet-shade)"
                    style={{ pointerEvents: "none" }} aria-hidden="true" />
                </>
              )}
              {/* Colour swatches — tiny arcs around the planet equator */}
              {swatchColors.length > 0 && (() => {
                const arcSpan = Math.PI * 1.5 / swatchColors.length;
                const startA  = -Math.PI * 0.75;
                const r2      = nr + 4.5;
                return (
                  <>
                    {swatchColors.map((col, ci) => {
                      const startAngle = startA + ci * arcSpan;
                      const endAngle   = startAngle + arcSpan * 0.78;
                      const x1 = nx + r2 * Math.cos(startAngle);
                      const y1 = ny + r2 * Math.sin(startAngle);
                      const x2 = nx + r2 * Math.cos(endAngle);
                      const y2 = ny + r2 * Math.sin(endAngle);
                      return (
                        <motion.path key={ci}
                          d={`M ${x1} ${y1} A ${r2} ${r2} 0 0 1 ${x2} ${y2}`}
                          fill="none" stroke={col} strokeWidth="3" strokeLinecap="round"
                          initial={{ pathLength: 0, opacity: 0 }}
                          animate={{ pathLength: 1, opacity: 0.9 }}
                          transition={{ duration: 0.35, delay: ci * 0.07, ease: "easeOut" }}
                        />
                      );
                    })}
                  </>
                );
              })()}
              <text
                x={nx} y={ny}
                textAnchor="middle" dominantBaseline="central"
                fontSize={nr > 26 ? "9" : "8"} fontWeight="700"
                fontFamily="'IBM Plex Sans', sans-serif"
                fill={item.textColor}
                opacity={isActive ? 0 : 0.95}
                style={{ pointerEvents: "none", userSelect: "none", transition: "opacity 200ms ease" }}
              >
                {item.family[0]}
              </text>
              <circle cx={nx + nr - 2} cy={ny - nr + 2} r={5.5}
                fill="#080c10" stroke={item.color} strokeWidth="0.6"
              />
              <text
                x={nx + nr - 2} y={ny - nr + 2}
                textAnchor="middle" dominantBaseline="central"
                fontSize="3.8" fontWeight="700"
                fontFamily="'IBM Plex Mono', monospace"
                fill={item.color}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {item.strains.length}
              </text>
              {!isMobile && (
                <text
                  x={lx} y={ly}
                  textAnchor={anchor} dominantBaseline="central"
                  fontSize={isCaridina ? "7.2" : "7.5"}
                  fontWeight={isActive ? "600" : "400"}
                  fontFamily="'Cormorant Garamond', serif"
                  letterSpacing="0.03em"
                  fill={isActive ? item.color : "rgba(221,216,204,0.65)"}
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {item.family}
                </text>
              )}

              {/* Strain moons — rendered for both active slots */}
              {moons && moons.map((moon) => (
                <g
                  key={`moon-${moon.strain.id}`}
                  onClick={(e) => { e.stopPropagation(); onSelect(moon.strain.id); }}
                  onFocus={keyboardFocus(`moon:${moon.strain.id}`)}
                  onBlur={clearFocusKey}
                  role="button"
                  aria-label={`Open ${moon.strain.name}`}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onSelect(moon.strain.id); }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {/* Enlarged invisible hit-area — visible moons are only 2.5–5 units,
                      far below a usable touch target on their own */}
                  <circle cx={moon.mx} cy={moon.my} r={11} fill="transparent" aria-hidden="true" />
                  {focusKey === `moon:${moon.strain.id}` && (
                    <circle
                      cx={moon.mx} cy={moon.my} r={moon.r + 3.5}
                      fill="none" stroke="#fff" strokeWidth="0.8" strokeDasharray="2 2"
                      opacity={0.9} aria-hidden="true"
                    />
                  )}
                  <motion.circle
                    cx={moon.mx} cy={moon.my} r={moon.r}
                    fill={moon.strain.colors[0]}
                    stroke="rgba(255,255,255,0.25)"
                    strokeWidth="0.5"
                    filter="url(#moon-glow)"
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 22, delay: 0.05 }}
                    whileHover={{ scale: 1.7 }}
                    style={{ transformOrigin: `${moon.mx}px ${moon.my}px` }}
                  />
                  {/* Tiny specular highlight gives each moon a lit, rounded look */}
                  <circle
                    cx={moon.mx - moon.r * 0.32} cy={moon.my - moon.r * 0.32}
                    r={Math.max(0.6, moon.r * 0.38)}
                    fill="rgba(255,255,255,0.5)"
                    style={{ pointerEvents: "none" }}
                    aria-hidden="true"
                  />
                  <title>{moon.strain.name}</title>
                </g>
              ))}
            </motion.g>
          );
        })}

        {/* Onboarding pulse around the first planet — hint text lives in an
            HTML overlay (.orbit-onboarding) where it stays readable at any size */}
        <AnimatePresence>
          {!hasInteracted && firstFamily && (
            <motion.g
              key="onboarding-hint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.5 } }}
              transition={{ delay: 1.4, duration: 0.7 }}
              aria-hidden="true"
              style={{ pointerEvents: "none" }}
            >
              <motion.circle
                cx={firstFamily.nx} cy={firstFamily.ny} r={firstFamily.nodeR + 16}
                fill="none" stroke="rgba(232,160,32,0.55)" strokeWidth="0.8" strokeDasharray="4 5"
                animate={{
                  scale: [1, (firstFamily.nodeR + 28) / (firstFamily.nodeR + 16), 1],
                  opacity: [0.55, 0.0, 0.55],
                }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                style={{ transformOrigin: `${firstFamily.nx}px ${firstFamily.ny}px` }}
              />
            </motion.g>
          )}
        </AnimatePresence>

        {/* Sun */}
        <motion.g
          onClick={() => {
            setMoonA(null);
            setMoonB(null);
            setRailFamily(null);
            setRailOpen(false);
            setMobileLabel(null);
          }}
          onHoverStart={() => setSunHovered(true)}
          onHoverEnd={() => setSunHovered(false)}
          onFocus={keyboardFocus("sun")}
          onBlur={clearFocusKey}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.97 }}
          style={{ cursor: "pointer" }}
          role="button"
          aria-label="Shrimpverse — reset to overview"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              setMoonA(null);
              setMoonB(null);
              setRailFamily(null);
              setRailOpen(false);
              setMobileLabel(null);
            }
          }}
        >
          <circle cx="0" cy="0" r="72" fill="url(#sun-grad)" />
          {focusKey === "sun" && (
            <circle
              cx="0" cy="0" r="48"
              fill="none" stroke="#fff" strokeWidth="1.1" strokeDasharray="3 3"
              opacity={0.9} aria-hidden="true"
            />
          )}
          <motion.circle
            cx="0" cy="0" r="38"
            fill="none" stroke="rgba(255,210,70,0.22)" strokeWidth="1.2"
            animate={{ scale: [1, 52 / 38, 1], opacity: [0.4, 0.0, 0.4] }}
            transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
            style={{ transformOrigin: "0px 0px" }}
          />
          {Array.from({ length: 8 }, (_, k) => {
            const a  = (k / 8) * Math.PI * 2;
            const r1 = 32, r2 = 44;
            return (
              <line key={k}
                x1={Math.cos(a) * r1} y1={Math.sin(a) * r1}
                x2={Math.cos(a) * r2} y2={Math.sin(a) * r2}
                stroke="rgba(255,215,60,0.45)" strokeWidth="1.6" strokeLinecap="round"
              />
            );
          })}
          <circle cx="0" cy="0" r="30" fill="rgba(255,190,30,0.20)" filter="url(#sun-glow)" />
          <circle cx="0" cy="0" r="24" fill="url(#sun-core)" filter="url(#sun-glow)" />
          <circle cx="0" cy="0" r="20" fill="url(#sun-core)" />
          {/* Soft specular kiss on the sun's upper-left */}
          <circle cx="-6" cy="-7" r="7" fill="rgba(255,255,255,0.45)" />
          <text
            x="0" y="-2"
            textAnchor="middle" dominantBaseline="central"
            fontSize="5.8" fontWeight="700"
            fontFamily="'Cormorant Garamond', serif"
            letterSpacing="0.04em"
            fill="rgba(80,40,0,0.75)"
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            Shrimpverse
          </text>
          <AnimatePresence>
            {sunHovered && activeFamilies.size > 0 && (
              <motion.text
                x="0" y="40"
                textAnchor="middle" fontSize="4.2"
                fontFamily="'IBM Plex Mono', monospace" letterSpacing="0.12em"
                fill="rgba(255,220,60,0.75)"
                initial={{ opacity: 0, y: 44 }}
                animate={{ opacity: 1, y: 40 }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={{ duration: 0.18 }}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                reset
              </motion.text>
            )}
          </AnimatePresence>
        </motion.g>
      </svg>

      {/* ----------------------------------------------------------------
          Strain Rail
      ---------------------------------------------------------------- */}
      <AnimatePresence>
        {railOpen && railFamily && (
          <motion.div
            key={`rail-${railFamily}`}
            className="orbit-rail-wrapper"
            initial={{ opacity: 0, x: isMobile ? 0 : 32, y: isMobile ? 32 : 0 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, x: isMobile ? 0 : 32, y: isMobile ? 32 : 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <StrainRail
              family={railFamily}
              strains={families.find((f) => f.family === railFamily)?.strains ?? []}
              onSelect={onSelect}
              onClose={() => {
                setRailOpen(false);
                setRailFamily(null);
              }}
              orientation={isMobile ? "horizontal" : "vertical"}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Logo mark — bottom-right corner */}
      <div className="orbit-logo-mark" aria-hidden="true">
        <ShrimpLogoMark size={28} accentColor="var(--text-faint)" />
      </div>
    </div>
  );
}
