import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { familyColors, familyGenus } from "../lib/constants";
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
    const r  = 2.5 + (s.popularity / 5) * 2.5; // 2.5–5 px
    return { strain: s, mx, my, r };
  });
}

// ---------------------------------------------------------------------------
// Cross-family moon arc builder
// ---------------------------------------------------------------------------
interface MoonArc {
  fromMoon: MoonDatum;
  toMoon: MoonDatum;
  type: ArcType;
  label: string;
  offspring: string;     // Short outcome label (for expert-mode arc labels)
  bundleIndex?: number;  // For arc bundling: 0 = center, ±1, ±2 = offset outward
}

/**
 * Point on the moon arc at t=0.5 (its visual midpoint).
 * Mirrors the control-point math in getMoonArcPath so labels sit on the curve.
 */
function getMoonArcMidpoint(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const nx = -dy / len;
  const ny = dx / len;
  // Match getMoonArcPath bow calculation
  const bow = len < 100
    ? Math.max(12, Math.min(20, len * 0.15))
    : Math.max(8, Math.min(15, len * 0.08));
  const cx = mx + nx * bow;
  const cy = my + ny * bow;
  // Quadratic Bézier evaluated at t = 0.5
  return { x: 0.25 * x1 + 0.5 * cx + 0.25 * x2, y: 0.25 * y1 + 0.5 * cy + 0.25 * y2 };
}

function buildMoonArcs(
  familyA: string,
  moonsA: MoonDatum[],
  familyB: string,
  moonsB: MoonDatum[],
): MoonArc[] {
  // Group arcs by (type, offspring) to reduce to representatives
  interface ArcGroup {
    type: ArcType;
    offspring: string;
    strainA?: MoonDatum; // highest popularity A strain in this group
    strainB?: MoonDatum; // highest popularity B strain in this group
  }
  const groupMap = new Map<string, ArcGroup>();

  // Collect all crosses A → B
  for (const moonA of moonsA) {
    for (const cross of (moonA.strain.compatible ?? [])) {
      if (cross.with !== familyB) continue;
      const type: ArcType =
        cross.stability === "impossible"   ? "impossible" :
        cross.stability === "stabilizing"  ? "stabilizing" :
        cross.stability === "unstable"     ? "hybrid" :
        "crosses";
      const key = `${type}|${cross.offspring}`;
      if (!groupMap.has(key)) {
        const bestB = moonsB.reduce((best, m) =>
          m.strain.popularity > best.strain.popularity ? m : best
        );
        groupMap.set(key, { type, offspring: cross.offspring, strainA: moonA, strainB: bestB });
      } else {
        const group = groupMap.get(key)!;
        // Keep the most popular A strain in this group
        if (!group.strainA || moonA.strain.popularity > group.strainA.strain.popularity) {
          group.strainA = moonA;
        }
      }
    }
  }

  // Collect all crosses B → A
  for (const moonB of moonsB) {
    for (const cross of (moonB.strain.compatible ?? [])) {
      if (cross.with !== familyA) continue;
      const type: ArcType =
        cross.stability === "impossible"   ? "impossible" :
        cross.stability === "stabilizing"  ? "stabilizing" :
        cross.stability === "unstable"     ? "hybrid" :
        "crosses";
      const key = `${type}|${cross.offspring}`;
      if (!groupMap.has(key)) {
        const bestA = moonsA.reduce((best, m) =>
          m.strain.popularity > best.strain.popularity ? m : best
        );
        groupMap.set(key, { type, offspring: cross.offspring, strainA: bestA, strainB: moonB });
      } else {
        const group = groupMap.get(key)!;
        // Keep the most popular B strain in this group
        if (!group.strainB || moonB.strain.popularity > group.strainB.strain.popularity) {
          group.strainB = moonB;
        }
      }
    }
  }

  // Convert groups to arcs
  const arcs: MoonArc[] = [];
  for (const group of groupMap.values()) {
    if (group.strainA && group.strainB) {
      arcs.push({
        fromMoon: group.strainA,
        toMoon: group.strainB,
        type: group.type,
        label: `${group.strainA.strain.name} × ${familyB}: ${group.offspring}`,
        offspring: group.offspring,
      });
    }
  }
  return arcs;
}

interface Props {
  visibleStrains: Strain[];
  onSelect: (id: string) => void;
  /** Show cross-breeding outcome labels on the orbit arcs */
  showBreedingArcs?: boolean;
}

export function FamilyOrbitExplorer({ visibleStrains, onSelect, showBreedingArcs }: Props) {
  // ---------------------------------------------------------------------------
  // Dual-slot state: moonA = first active family, moonB = second active family.
  // Planet highlight and moon rendering are driven exclusively by these two slots.
  // There is no separate activeFamily/activeFamilies state — moonA/moonB IS
  // the source of truth for "which planets are active".
  // ---------------------------------------------------------------------------
  const [moonA, setMoonA] = useState<string | null>(null);
  const [moonB, setMoonB] = useState<string | null>(null);

  // Rail tracks the most recently activated slot (drives the StrainRail panel).
  const [railFamily, setRailFamily] = useState<string | null>(null);
  const [railOpen, setRailOpen]     = useState(false);
  const [hovered, setHovered]       = useState<string | null>(null);
  const [sunHovered, setSunHovered] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [mobileLabel, setMobileLabel]     = useState<string | null>(null);
  const isMobile = useIsMobile();

  // Mobile gets a tighter viewBox so the orbit system renders ~7% larger;
  // the cropped outer starfield zone carries no information on small screens.
  const vbSize = isMobile ? 600 : VB;

  // Shape-true keyboard focus rings. Chromium applies :focus-visible to SVG
  // elements with tabindex even for pointer taps, so the default rectangular
  // outline is suppressed in CSS and we draw a circular ring ourselves —
  // but only when focus did NOT originate from a recent pointer interaction.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const lastPointerTs = useRef(0);
  useEffect(() => {
    const onPointer = () => { lastPointerTs.current = Date.now(); };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, []);
  const keyboardFocus = useCallback(
    (key: string) => () => {
      if (Date.now() - lastPointerTs.current > 300) setFocusKey(key);
    },
    [],
  );
  const clearFocusKey = useCallback(() => setFocusKey(null), []);

  // Derived helpers
  const activeFamilies = useMemo(() => {
    const s = new Set<string>();
    if (moonA) s.add(moonA);
    if (moonB) s.add(moonB);
    return s;
  }, [moonA, moonB]);

  // activeFamily alias for HUD / rail (most recent slot)
  const activeFamily = railFamily;

  const families = useMemo(() => {
    const grouped = new Map<string, Strain[]>();
    for (const s of visibleStrains) {
      if (!grouped.has(s.family)) grouped.set(s.family, []);
      grouped.get(s.family)!.push(s);
    }
    const neoGroup  = NEO_ORDER.filter((f) => grouped.has(f));
    const cariGroup = CARIDINA_ORDER.filter((f) => grouped.has(f));
    return FAMILY_ORDER.filter((f) => grouped.has(f)).map((f) => {
      const isC    = CARIDINA_SET.has(f);
      const group  = isC ? cariGroup : neoGroup;
      const idx    = group.indexOf(f);
      const total  = group.length;
      const orbitR = FAMILY_ORBIT_RADIUS[f] ?? 185;
      const angle  = total > 0 ? (idx / total) * 2 * Math.PI - Math.PI / 2 : 0;
      const nx     = Math.cos(angle) * orbitR;
      const ny     = Math.sin(angle) * orbitR;
      return {
        family: f, strains: grouped.get(f)!,
        color: familyColors[f] ?? "#888",
        glow:  FAMILY_GLOW[f]  ?? "rgba(255,255,255,0.3)",
        textColor: FAMILY_TEXT[f] ?? "#fff",
        nodeR: nodeRadius(grouped.get(f)!.length),
        orbitR, angle, nx, ny,
        isCaridina: isC,
      };
    });
  }, [visibleStrains]);

  const activeStrains = railFamily
    ? families.find((f) => f.family === railFamily)?.strains ?? []
    : [];

  // Mobile peek button visibility — the arc legend hides while this is shown
  // (both occupy the bottom edge and would otherwise overlap).
  const peekVisible = Boolean(isMobile && railFamily && !railOpen && activeStrains.length > 0);

  // Stale-selection cleanup: if a selected family is filtered out of the visible
  // set, clear that slot so no ghost highlight / empty rail lingers.
  useEffect(() => {
    const valid = new Set(families.map((f) => f.family));
    if (moonA && !valid.has(moonA)) setMoonA(null);
    if (moonB && !valid.has(moonB)) setMoonB(null);
    if (railFamily && !valid.has(railFamily)) {
      setRailFamily(null);
      setRailOpen(false);
    }
  }, [families, moonA, moonB, railFamily]);

  // Clear every active selection in one action (visible Clear button + reset).
  const clearSelection = useCallback(() => {
    setMoonA(null);
    setMoonB(null);
    setRailFamily(null);
    setRailOpen(false);
    setMobileLabel(null);
  }, []);

  // ---------------------------------------------------------------------------
  // handleFamilyClick — slot-based dual-active logic (no Shift required)
  //
  // Rules:
  //   • Node is moonA       → clear moonA (toggle off); if railFamily was moonA,
  //                           move rail to moonB (if set)
  //   • Node is moonB       → clear moonB (toggle off); rail stays on moonA
  //   • moonA is empty      → set moonA = node; open rail for node
  //   • moonA set, moonB empty → set moonB = node; open rail for node
  //   • Both slots filled   → replace moonA with node (oldest slot recycled);
  //                           moonB stays; open rail for node
  // ---------------------------------------------------------------------------
  const handleFamilyClick = useCallback(
    (family: string) => {
      setHasInteracted(true);

      // Toggle off moonA
      if (moonA === family) {
        setMoonA(moonB);   // moonB slides up to slot A
        setMoonB(null);
        const nextRail = moonB ?? null;
        setRailFamily(nextRail);
        if (!nextRail) {
          setRailOpen(false);
          setMobileLabel(null);
        }
        return;
      }

      // Toggle off moonB
      if (moonB === family) {
        setMoonB(null);
        // Rail stays on moonA
        return;
      }

      // Activate into first free slot
      if (moonA === null) {
        setMoonA(family);
      } else if (moonB === null) {
        setMoonB(family);
      } else {
        // Both slots full — recycle slot A (oldest), keep slot B
        setMoonA(family);
      }

      // Update rail to the newly activated family
      setRailFamily(family);
      if (isMobile) {
        // Don't auto-open rail — show transient label then let user swipe up manually
        setMobileLabel(family);
        setTimeout(() => setMobileLabel(null), 800);
      } else {
        setRailOpen(false);
      }
    },
    [moonA, moonB, isMobile],
  );

  // Precompute moons for every active family
  const moonsByFamily = useMemo(() => {
    const map = new Map<string, MoonDatum[]>();
    for (const item of families) {
      if (!activeFamilies.has(item.family)) continue;
      map.set(item.family, buildMoons(item.strains, item.nx, item.ny, item.nodeR));
    }
    return map;
  }, [families, activeFamilies]);

  // Precompute moon-to-moon arcs when exactly 2 families are active
  const moonArcs = useMemo((): MoonArc[] => {
    if (!moonA || !moonB) return [];
    const moonsA = moonsByFamily.get(moonA);
    const moonsB = moonsByFamily.get(moonB);
    if (!moonsA || !moonsB) return [];
    return buildMoonArcs(moonA, moonsA, moonB, moonsB);
  }, [moonA, moonB, moonsByFamily]);

  // Expert-mode arc labels: show each distinct outcome once to avoid stacking
  // identical text when many strains share the same cross result.
  const labelledArcIndices = useMemo(() => {
    const seen = new Set<string>();
    const indices = new Set<number>();
    moonArcs.forEach((arc, i) => {
      if (!arc.offspring || arc.offspring === "—") return;
      if (seen.has(arc.offspring)) return;
      seen.add(arc.offspring);
      indices.add(i);
    });
    return indices;
  }, [moonArcs]);

  // Generate family-level arcs from strain data (data-driven, not hardcoded)
  const familyArcs = useMemo(() => generateFamilyArcs(visibleStrains), [visibleStrains]);

  const neoCount      = visibleStrains.filter((s) => !CARIDINA_SET.has(s.family)).length;
  const caridineCount = visibleStrains.filter((s) =>  CARIDINA_SET.has(s.family)).length;
  const totalCount    = visibleStrains.length;
  const firstFamily   = families[0];

  if (families.length === 0) {
    return (
      <div className="orbit-explorer orbit-explorer--empty">
        <div className="orbit-empty-state">
          <ShrimpLogoMark size={52} accentColor="var(--text-faint)" />
          <p className="orbit-empty-title">No strains match</p>
          <p className="orbit-empty-hint">Try adjusting or clearing a filter</p>
        </div>
      </div>
    );
  }

  const railAnimation = isMobile
    ? { initial: { opacity: 0, y: 24 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 20 } }
    : { initial: { width: 0, opacity: 0 }, animate: { width: 260, opacity: 1 }, exit: { width: 0, opacity: 0 } };

  return (
    <div className="orbit-layout">
      <div className="orbit-explorer" style={activeFamily && isMobile && railOpen ? { paddingBottom: "138px" } : undefined}>

        {/* Single-line HUD: stats in overview, active-label/compare-badge while
            selecting — they share the same top-centre slot instead of stacking. */}
        <AnimatePresence>
          {activeFamilies.size === 0 && (
            <motion.div
              key="orbit-stats"
              className="orbit-stats"
              aria-label="Visible strain statistics"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <p className="orbit-stats-sentence">
                <span className="orbit-stats-neo">{neoCount}</span>
                {" Neocaridina · "}
                <span className="orbit-stats-cari">{caridineCount}</span>
                {" Caridina"}
                {totalCount < neoCount + caridineCount && (
                  <span className="orbit-stats-filtered"> · {totalCount} filtered</span>
                )}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Standalone clear button — single-family mode only.
            In compare mode the clear button lives inside the compare badge. */}
        <AnimatePresence>
          {activeFamilies.size > 0 && !(moonA && moonB) && (
            <motion.button
              key="clear-selection"
              type="button"
              className="orbit-clear-btn"
              onClick={clearSelection}
              aria-label="Clear selection"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
              Clear
            </motion.button>
          )}
        </AnimatePresence>

        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {activeFamilies.size > 0
            ? [...activeFamilies].map((f) => {
                const fc = families.find((x) => x.family === f);
                return fc ? `${f}: ${fc.strains.length} varieties` : "";
              }).join(", ")
            : ""}
        </div>

        {/* Active family HUD — shows primary (rail) family; yields to the
            compare badge when two families are active (one HUD line at a time) */}
        <AnimatePresence>
          {activeFamily && !(moonA && moonB) && (
            <motion.div
              key={activeFamily}
              className="orbit-active-label"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              style={{ color: familyColors[activeFamily] }}
            >
              {activeFamily}
              {familyGenus[activeFamily] && (
                <span className="orbit-active-genus">{familyGenus[activeFamily]}</span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Comparison badge when two families are active — visible on all devices */}
        <AnimatePresence>
          {moonA && moonB && (() => {
            // Break the comparison down by cross type so the badge shows the
            // actual breeding quality at a glance, not just a raw viable count.
            const counts = {
              crosses:     moonArcs.filter((a) => a.type === "crosses").length,
              hybrid:      moonArcs.filter((a) => a.type === "hybrid").length,
              stabilizing: moonArcs.filter((a) => a.type === "stabilizing").length,
              impossible:  moonArcs.filter((a) => a.type === "impossible").length,
            };
            const viable = counts.crosses + counts.hybrid + counts.stabilizing;
            // Genus mismatch: one Neo, one Caridina — biologically impossible to cross
            const crossGenus = CARIDINA_SET.has(moonA) !== CARIDINA_SET.has(moonB);
            // Build per-type segments (only present types), coloured to match arcs.
            const segments: { text: string; color: string }[] = [];
            if (counts.crosses)     segments.push({ text: `${counts.crosses} stable`,      color: "rgba(47,196,181,0.9)" });
            if (counts.hybrid)      segments.push({ text: `${counts.hybrid} hybrid`,       color: "rgba(255,196,80,0.9)" });
            if (counts.stabilizing) segments.push({ text: `${counts.stabilizing} stabilizing`, color: "rgba(180,130,255,0.9)" });
            let summary: { text: string; color: string };
            if (viable > 0) {
              summary = {
                text: counts.impossible > 0 ? " · rest incompatible" : "",
                color: "rgba(221,216,204,0.5)",
              };
            } else if (counts.impossible > 0 || crossGenus) {
              summary = { text: "cannot crossbreed", color: "rgba(220,80,80,0.85)" };
            } else {
              summary = { text: "no direct crosses", color: "rgba(221,216,204,0.4)" };
            }
            return (
              <motion.div
                key="compare-badge"
                className="orbit-compare-badge"
                initial={{ opacity: 0, y: -8, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.92 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              >
                <span className="orbit-compare-text">
                  <span style={{ color: familyColors[moonA] }}>{moonA}</span>
                  <span style={{ opacity: 0.4, margin: "0 6px" }}>×</span>
                  <span style={{ color: familyColors[moonB] }}>{moonB}</span>
                  <span style={{ marginLeft: 8, fontSize: "0.8em" }}>
                    {segments.map((seg, idx) => (
                      <span key={seg.text} style={{ color: seg.color }}>
                        {idx > 0 ? " · " : ""}{seg.text}
                      </span>
                    ))}
                    {summary.text && (
                      <span style={{ color: summary.color }}>{summary.text}</span>
                    )}
                  </span>
                </span>
                <button
                  className="orbit-compare-clear"
                  onClick={clearSelection}
                  aria-label="Clear selection"
                >
                  <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M3 3l10 10M13 3L3 13" />
                  </svg>
                </button>
              </motion.div>
            );
          })()}
        </AnimatePresence>

        <AnimatePresence>
          {mobileLabel && (
            <motion.div
              key="mobile-label"
              className="orbit-mobile-tap-label"
              initial={{ opacity: 0, scale: 0.88, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: -6 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              style={{ color: familyColors[mobileLabel] ?? "var(--accent)" }}
            >
              {mobileLabel}
            </motion.div>
          )}
        </AnimatePresence>

        <svg
          className="orbit-svg"
          viewBox={`${-vbSize / 2} ${-vbSize / 2} ${vbSize} ${vbSize}`}
          width="100%"
          height="100%"
          aria-label="Shrimpverse — freshwater shrimp species atlas"
        >
          <defs>
            <radialGradient id="sun-grad" cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor="rgba(255,245,200,0.42)" />
              <stop offset="30%"  stopColor="rgba(255,210,70,0.26)" />
              <stop offset="62%"  stopColor="rgba(255,160,20,0.10)" />
              <stop offset="100%" stopColor="rgba(255,140,0,0)" />
            </radialGradient>
            {/* Sun core — white-hot centre fading through gold to orange */}
            <radialGradient id="sun-core" cx="38%" cy="34%" r="68%">
              <stop offset="0%"   stopColor="#fffaf0" />
              <stop offset="42%"  stopColor="#ffe87a" />
              <stop offset="100%" stopColor="#f7b733" />
            </radialGradient>
            {/* Colour-independent planet shading — reused by every family node.
                #planet-shade adds a top-left specular highlight; #planet-depth
                darkens the lower-right edge for a spherical, lit-from-above look. */}
            <radialGradient id="planet-shade" cx="32%" cy="28%" r="62%">
              <stop offset="0%"   stopColor="rgba(255,255,255,0.42)" />
              <stop offset="45%"  stopColor="rgba(255,255,255,0.10)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </radialGradient>
            <radialGradient id="planet-depth" cx="40%" cy="36%" r="72%">
              <stop offset="0%"   stopColor="rgba(0,0,0,0)" />
              <stop offset="58%"  stopColor="rgba(0,0,0,0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.38)" />
            </radialGradient>
            {/* Faint scene vignette/glow so the planets read as floating in depth */}
            <radialGradient id="scene-depth" cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor="rgba(40,60,90,0.18)" />
              <stop offset="55%"  stopColor="rgba(20,30,48,0.07)" />
              <stop offset="100%" stopColor="rgba(8,12,16,0)" />
            </radialGradient>
            <radialGradient id="neo-water" cx="0" cy="0" r="208" gradientUnits="userSpaceOnUse">
              <stop offset="30%" stopColor="transparent" />
              <stop offset="70%" stopColor="rgba(180,140,60,0.06)" />
              <stop offset="100%" stopColor="rgba(180,140,60,0.0)" />
            </radialGradient>
            <radialGradient id="cari-water" cx="0" cy="0" r="276" gradientUnits="userSpaceOnUse">
              <stop offset="55%" stopColor="transparent" />
              <stop offset="85%" stopColor="rgba(47,130,196,0.06)" />
              <stop offset="100%" stopColor="rgba(47,130,196,0.0)" />
            </radialGradient>
            <filter id="node-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="7" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="sun-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="moon-glow" x="-120%" y="-120%" width="340%" height="340%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* Soft central depth glow — sits behind everything for a floating feel */}
          <circle cx="0" cy="0" r={vbSize / 2} fill="url(#scene-depth)" aria-hidden="true" />

          <circle cx="0" cy="0" r="208" fill="url(#neo-water)"  aria-hidden="true" />
          <circle cx="0" cy="0" r="276" fill="url(#cari-water)" aria-hidden="true" />

          <g aria-hidden="true">
            {STARS.map((s, i) => (
              <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#ddd8cc" opacity={s.op} />
            ))}
          </g>

          <motion.circle cx="0" cy="0" r={190}
            fill="none" stroke="rgba(47,196,181,0.14)" strokeWidth="0.6" strokeDasharray="4 6"
            animate={{ rotate: 360 }}
            transition={{ duration: 80, repeat: Infinity, ease: "linear" }}
            style={{ transformOrigin: "0px 0px" }}
          />
          <motion.circle cx="0" cy="0" r={242}
            fill="none" stroke="rgba(100,150,255,0.11)" strokeWidth="0.6" strokeDasharray="3 9"
            animate={{ rotate: -360 }}
            transition={{ duration: 130, repeat: Infinity, ease: "linear" }}
            style={{ transformOrigin: "0px 0px" }}
          />

          {/* Family-level breeding arcs (data-driven) */}
          <g aria-hidden="true">
            {familyArcs.map((arc) => {
              const fromNode = families.find((n) => n.family === arc.from);
              const toNode   = families.find((n) => n.family === arc.to);
              if (!fromNode || !toNode) return null;

              // When exactly 2 families are active, hide family-level arcs between them.
              // Moon-to-moon arcs already show the detailed relationships.
              if (activeFamilies.size === 2 &&
                  activeFamilies.has(arc.from) &&
                  activeFamilies.has(arc.to)) {
                return null;
              }

              // Count how many of this arc's endpoints are currently active
              const endpointsActive =
                (activeFamilies.has(arc.from) ? 1 : 0) +
                (activeFamilies.has(arc.to)   ? 1 : 0);
              // With one active, show any arc touching it. With 2+ active, show arcs
              // not between the two active ones (those are covered by moon-to-moon arcs).
              const isHighlighted = endpointsActive >= 1;
              const isDimmed = activeFamilies.size > 0 && !isHighlighted;
              return (
                <g key={`arc-${arc.from}-${arc.to}`}>
                  <motion.path
                    d={getNodeArcPath(fromNode.angle, fromNode.orbitR, toNode.angle, toNode.orbitR)}
                    stroke={isHighlighted ? ARC_COLOR_ACTIVE[arc.type] : ARC_COLOR[arc.type]}
                    strokeWidth={isHighlighted ? 1.6 : 0.9}
                    fill="none" strokeLinecap="round"
                    strokeDasharray={arc.type === "impossible" ? "4 4" : undefined}
                    animate={{ opacity: isDimmed ? 0.2 : isHighlighted ? 1 : 0.7 }}
                    transition={{ duration: 0.25 }}
                    whileHover={{ strokeWidth: 2.2, opacity: 1 }}
                  />
                  <title>{arc.label}</title>
                </g>
              );
            })}
          </g>

          {/* Moon-to-moon cross-family arcs (only when 2 families active) — desktop + mobile */}
          <g aria-hidden="true">
            {moonArcs.map((arc, i) => {
              const pathStr = getMoonArcPath(arc.fromMoon.mx, arc.fromMoon.my, arc.toMoon.mx, arc.toMoon.my);
              const isImpossible = arc.type === "impossible";
              // Not a button: arcs are informational (tooltip via <title>), they
              // have no click action — focusable role="button" here was a trap.
              return (
                <g key={`moon-arc-${i}`}
                  style={{ cursor: isMobile ? "pointer" : "default" }}>
                  {/* Invisible wider hitbox for mobile tap target (≥44px) */}
                  {isMobile && (
                    <motion.path
                      d={pathStr}
                      stroke="transparent"
                      strokeWidth={12}
                      fill="none"
                      pointerEvents="auto"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 0 }}
                    />
                  )}
                  {/* Visible arc — impossible arcs use opacity-only animation because
                      framer-motion's pathLength animation internally sets stroke-dasharray,
                      which would override the explicit dashed style we need. */}
                  <motion.path
                    d={pathStr}
                    stroke={ARC_COLOR_ACTIVE[arc.type]}
                    strokeWidth={1.2}
                    fill="none"
                    strokeLinecap="round"
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
                        fontSize="5.5" fontWeight="600"
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
                {isPrimary && swatchColors.length >= 3 && (
                  <>
                    {swatchColors.slice(0, 3).map((col, ci) => {
                      const segAngle   = (2 * Math.PI) / 3;
                      const startAngle = ci * segAngle - Math.PI / 2;
                      const endAngle   = startAngle + segAngle - 0.12;
                      const r2 = nr - 5;
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
                )}
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
                    fontSize={isCaridina ? "5.2" : "5.5"}
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
                  RESET
                </motion.text>
              )}
            </AnimatePresence>
          </motion.g>
        </svg>

        {/* Onboarding hint — HTML overlay, readable at every viewport size */}
        <AnimatePresence>
          {!hasInteracted && firstFamily && (
            <motion.div
              key="orbit-onboarding"
              className="orbit-onboarding"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.4 } }}
              transition={{ delay: 1.4, duration: 0.7 }}
            >
              <span>{isMobile ? "Tap any planet to explore" : "Click any planet to explore"}</span>
              {/* Shape key — desktop already shows .orbit-legend, mobile hides it */}
              {isMobile && (
                <span className="orbit-onboarding-shapes">
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <circle cx="5" cy="5" r="4.5" fill="rgba(47,196,181,0.6)" />
                  </svg>
                  Neocaridina
                  <svg width="11" height="10" viewBox="0 0 11 10" aria-hidden="true">
                    <polygon points={hexPoints(5.5, 5, 4.5)} fill="rgba(100,150,255,0.6)" />
                  </svg>
                  Caridina
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mobile peek button — appears after planet tap, lets user open rail manually */}
        <AnimatePresence>
          {peekVisible && railFamily && (
            <motion.button
              key="rail-peek"
              type="button"
              className="orbit-rail-peek"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onClick={() => setRailOpen(true)}
              aria-label={`Show ${railFamily} strains`}
            >
              <span
                className="orbit-rail-peek-dot"
                style={{ background: familyColors[railFamily] ?? "var(--accent)" }}
              />
              {railFamily} · {activeStrains.length} strain{activeStrains.length !== 1 ? "s" : ""} ↑
            </motion.button>
          )}
        </AnimatePresence>

        {/* Arc legend — hidden while the mobile peek button occupies the bottom edge */}
        {!peekVisible && (
        <div className="orbit-arc-legend" aria-hidden="true">
          <span className="orbit-arc-legend-item orbit-arc-legend-item--crosses">
            <svg width="14" height="4" viewBox="0 0 14 4">
              <line x1="0" y1="2" x2="14" y2="2" stroke="rgba(47,196,181,0.75)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            crossable
          </span>
          <span className="orbit-arc-legend-item orbit-arc-legend-item--hybrid">
            <svg width="14" height="4" viewBox="0 0 14 4">
              <line x1="0" y1="2" x2="14" y2="2" stroke="rgba(255,196,80,0.75)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            hybrid
          </span>
          <span className="orbit-arc-legend-item orbit-arc-legend-item--stabilizing">
            <svg width="14" height="4" viewBox="0 0 14 4">
              <line x1="0" y1="2" x2="14" y2="2" stroke="rgba(180,130,255,0.75)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            stabilizing
          </span>
          <span className="orbit-arc-legend-item orbit-arc-legend-item--impossible">
            <svg width="14" height="4" viewBox="0 0 14 4">
              <line x1="0" y1="2" x2="14" y2="2" stroke="rgba(200,70,70,0.75)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 3" />
            </svg>
            incompatible
          </span>
        </div>
        )}

        {/* Shape legend */}
        <div className="orbit-legend" aria-hidden="true">
          <span className="orbit-legend-item">
            <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4.5" fill="rgba(47,196,181,0.6)" /></svg>
            Neocaridina
          </span>
          <span className="orbit-legend-sep">·</span>
          <span className="orbit-legend-item">
            <svg width="11" height="10" viewBox="0 0 11 10">
              <polygon points={Array.from({length:6},(_,k)=>{const a=(k/6)*Math.PI*2-Math.PI/6;return`${5.5+4.5*Math.cos(a)},${5+4.5*Math.sin(a)}`}).join(" ")} fill="rgba(100,150,255,0.6)" />
            </svg>
            Caridina / Exotics
          </span>
        </div>
      </div>

      {/* Strain detail rail */}
      <AnimatePresence>
        {railFamily && activeStrains.length > 0 && (!isMobile || railOpen) && (
          <motion.div
            className="orbit-rail-wrapper"
            {...railAnimation}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            style={!isMobile ? { overflow: "hidden", flexShrink: 0 } : undefined}
          >
            <StrainRail
              family={railFamily}
              strains={activeStrains}
              onSelect={onSelect}
              onClose={isMobile ? () => setRailOpen(false) : () => {
                setMoonA(null);
                setMoonB(null);
                setRailFamily(null);
              }}
              orientation={isMobile ? "horizontal" : "vertical"}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
