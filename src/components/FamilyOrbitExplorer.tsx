import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { familyColors, familyGenus } from "../lib/constants";
import type { Strain } from "../types/strain";
import { StrainRail } from "./StrainRail";
import { ShrimpLogoMark } from "./ShrimpLogoMark";
import { useIsMobile } from "../hooks/useIsMobile";
