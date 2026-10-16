export const BEHAVIOR_TIPS: string[] = [
  "Smile while you greet — first impressions stick.",
  "Address customers by name when you can — it makes them feel important.",
  "Offer a drink as customers place their order — it boosts the basket.",
  "Recommend the daily special — guests love trying something new.",
  "Repeat the order back before sending — fewer remakes, happier guests.",
  "Ask if there's a special occasion — surprise them if it's a birthday.",
  "Check on the table after the first bite — small touch, big impact.",
  "Sharelebrate every win — small or large. 🎉",
  "Today is someone's first time at SharEat. Make it memorable.",
  "We're not just serving food — we're making sharelebrations.",
  "A little extra warmth at checkout = a returning sharelebrator.",
  "Thank guests by name as they leave — they will remember it.",
  "When the kitchen is busy, set expectations early. Guests appreciate honesty.",
  "Notice the regulars. A simple 'welcome back' goes a long way.",
  "Stay tidy at the counter — guests notice a clean station.",
  "Offer water to seated guests right away — hospitality 101.",
  "Kids at the table? Suggest something kid-friendly. Win the parents.",
  "Encourage the Sharelebrator card at checkout — points add up fast.",
  "Bring sauces and condiments before they're asked. Anticipate.",
  "Keep your energy up — your mood sets the table's mood.",
];

export type Milestone = 0 | 25 | 50 | 75 | 100 | 110;

const MILESTONE_TIPS: Record<Exclude<Milestone, 0>, string> = {
  25: "🎉 25% of today's target hit. Strong start!",
  50: "🚀 Halfway to today's target. Keep the energy up!",
  75: "🔥 75%! Three quarters of the way there.",
  100: "⭐ Target reached. Every peso from here beats the goal.",
  110: "🌟 110% of target — sharelebration mode unlocked.",
};

/**
 * Highest milestone level reached, given current percent (0–100+).
 * Returns 0 if below 25%.
 */
export function currentMilestone(percent: number): Milestone {
  if (percent >= 110) return 110;
  if (percent >= 100) return 100;
  if (percent >= 75) return 75;
  if (percent >= 50) return 50;
  if (percent >= 25) return 25;
  return 0;
}

export type PickTipResult = { message: string; milestone: Milestone | null };

/**
 * Return the next tip to show.
 * - If the current percent has crossed a milestone we haven't already
 *   celebrated this session, return the milestone tip (and the new milestone).
 * - Otherwise pick a random behavior tip that is NOT in `recentlyShown`
 *   (last 3) so the rotation feels varied.
 */
export function pickTip(args: {
  percent: number;
  lastMilestone: Milestone;
  recentlyShown: string[];
}): PickTipResult {
  const { percent, lastMilestone, recentlyShown } = args;

  const cur = currentMilestone(percent);
  if (cur > lastMilestone && cur !== 0) {
    return { message: MILESTONE_TIPS[cur], milestone: cur };
  }

  const recent = new Set(recentlyShown);
  const candidates = BEHAVIOR_TIPS.filter((t) => !recent.has(t));
  const pool = candidates.length > 0 ? candidates : BEHAVIOR_TIPS;
  const message = pool[Math.floor(Math.random() * pool.length)];
  return { message, milestone: null };
}
