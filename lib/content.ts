import type { Bias } from "./types";

// Rule-based sentiment tagger for headlines. It is a keyword scorer, not a language model:
// swap the body of `classifySentiment` for a model call to get real NLP classification.

const HAWKISH = ["hike", "hikes", "hawkish", "sticky", "hot", "hotter", "tighten", "tightening", "restrictive", "upside risk", "higher for longer", "accelerat", "overheating", "intervention", "inflation pressure", "price pressures"];
const DOVISH = ["cut", "cuts", "dovish", "cooling", "cools", "softer", "ease", "easing", "slowing", "weaker", "disinflation", "stimulus", "below forecast", "contracts", "contraction", "recession"];

export function classifySentiment(headline: string): Bias {
  const h = headline.toLowerCase();
  const hits = (list: string[]) => list.filter((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(h)).length;
  const score = hits(HAWKISH) - hits(DOVISH);
  return score > 0 ? "Hawkish" : score < 0 ? "Dovish" : "Neutral";
}
