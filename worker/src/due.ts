import type { Frequency } from '../../shared/types';
import type { SubscriberRow } from './db';

/** Who is due for a digest check this tick, and how the cron paginates
 * through them a batch at a time — topic-aware, so the tick's CPU cost
 * (dominated by JSON.parse-ing topic files, see digest.ts) stays bounded
 * even when subscriber interests are diverse.
 *
 * Cadences: daily -> ~20h since last check, weekly -> ~6.5d, monthly -> ~29d
 * (short of the round number so a slightly-early cron tick, or an hour of
 * clock drift, never pushes a subscriber's send a full extra day/week/month
 * late). Never-checked actives (`last_sent_at IS NULL`) are always due.
 *
 * `send_hour`/`timezone` narrow further: when a subscriber set a preferred
 * local hour, only ticks where their current local hour matches it are
 * eligible. Subscribers who miss their hour this tick stay at the front of
 * the queue (their `last_sent_at` is untouched) and are re-offered next
 * tick, so they are never skipped for good — just delayed within the hour.
 */

const HOURS = 60 * 60 * 1000;
const DAY = 24 * HOURS;
const DAILY_CUTOFF_MS = 20 * HOURS;
const WEEKLY_CUTOFF_MS = 6.5 * 24 * HOURS;
const MONTHLY_CUTOFF_MS = 29 * 24 * HOURS;

/** How many extra candidates to pull past `batchSize` so that (a) subscribers
 * waiting on a specific local send_hour, and (b) subscribers whose topic set
 * doesn't fit this tick's MAX_TOPIC_FILES_PER_TICK budget, don't starve the
 * ones who do fit. Kept small deliberately: each candidate with a send_hour
 * set costs one Intl.DateTimeFormat construction, and CPU is the scarce
 * resource here. */
const OVERFETCH_FACTOR = 3;
const OVERFETCH_CAP = 150;

export async function fetchDueCandidates(db: D1Database, now: Date, batchSizeN: number): Promise<SubscriberRow[]> {
  const dailyCutoff = new Date(now.getTime() - DAILY_CUTOFF_MS).toISOString();
  const weeklyCutoff = new Date(now.getTime() - WEEKLY_CUTOFF_MS).toISOString();
  const monthlyCutoff = new Date(now.getTime() - MONTHLY_CUTOFF_MS).toISOString();
  const limit = Math.min(batchSizeN * OVERFETCH_FACTOR, OVERFETCH_CAP);

  const { results } = await db
    .prepare(
      `SELECT * FROM subscribers
       WHERE status = 'active'
         AND (
           (frequency = 'daily'   AND (last_sent_at IS NULL OR last_sent_at <= ?1))
           OR (frequency = 'weekly'  AND (last_sent_at IS NULL OR last_sent_at <= ?2))
           OR (frequency = 'monthly' AND (last_sent_at IS NULL OR last_sent_at <= ?3))
         )
       ORDER BY (last_sent_at IS NOT NULL), last_sent_at ASC
       LIMIT ?4`,
    )
    .bind(dailyCutoff, weeklyCutoff, monthlyCutoff, limit)
    .all<SubscriberRow>();
  return results ?? [];
}

/** Whether `now` falls in the subscriber's preferred local hour. No
 * preference (send_hour or timezone unset) always matches. An invalid stored
 * timezone also always matches — we'd rather send on schedule than block a
 * subscriber on bad data we already validated at write time. */
export function isDueThisHour(subscriber: SubscriberRow, now: Date): boolean {
  if (subscriber.send_hour == null || !subscriber.timezone) return true;
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: subscriber.timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now);
    const localHour = parseInt(hourStr, 10) % 24;
    return localHour === subscriber.send_hour;
  } catch {
    return true;
  }
}

function frequencyIntervalMs(frequency: Frequency): number {
  switch (frequency) {
    case 'daily':
      return DAY;
    case 'weekly':
      return 7 * DAY;
    case 'monthly':
      return 30 * DAY;
  }
}

/** No row-level counter is kept for "ticks skipped by the greedy selector" —
 * that would need a schema change. Instead this infers the same thing from
 * data already on the row: a subscriber is starved once they've gone
 * meaningfully past their normal due point (1.25x their frequency interval,
 * measured from last_sent_at, or created_at if never sent) without being
 * selected. For a daily subscriber that's ~30h — they become "due" at ~20h,
 * so ~30h means roughly 6+ hourly ticks have now passed where they were
 * eligible but not chosen. */
const STARVATION_FACTOR = 1.25;

export function isStarved(subscriber: SubscriberRow, now: Date): boolean {
  const reference = subscriber.last_sent_at ?? subscriber.created_at;
  const age = now.getTime() - new Date(reference).getTime();
  return age > STARVATION_FACTOR * frequencyIntervalMs(subscriber.frequency);
}

export interface TickSelection {
  selected: SubscriberRow[];
  /** Union of topic slugs the selected subscribers need this tick — exactly
   * what the caller should pass to loadTopicFiles. */
  topicSlugs: Set<string>;
  /** True when this tick was diverted to starvation relief: one or more
   * subscribers had gone unselected for too long, so they were processed
   * regardless of MAX_TOPIC_FILES_PER_TICK, and the normal topic-capped
   * batch was skipped for everyone else this tick (they simply remain due
   * and are reconsidered next tick, same as any other skipped candidate). */
  starvationRelief: boolean;
}

/**
 * Topic-aware batch selection for one cron tick.
 *
 * Candidates must already be ordered oldest-`last_sent_at`-first (that's
 * what fetchDueCandidates returns). Starting from an empty topic-file
 * budget, subscribers are considered in that order and admitted if the
 * *new* topic slugs they'd add keep the running union at or below
 * `maxTopicFiles` — stopping once `batchSizeN` subscribers are admitted.
 * Candidates that don't fit are skipped, not stopped on: a later candidate
 * needing zero new topic files (because everything they follow is already
 * covered by who's already in) is still picked up, even after an earlier,
 * pricier candidate was passed over. Because the input is age-ordered, this
 * also means that when two candidates are equally cheap and only one still
 * fits, the older one — evaluated first — wins.
 *
 * Before any of that: if any eligible candidate has been starved (see
 * isStarved) for too long, this tick is diverted entirely to processing the
 * starved candidate(s) — bypassing the topic-file cap for them — so a
 * reader with a large, diverse topic list is still guaranteed a digest
 * eventually, just in a dedicated tick.
 */
export function selectTick(
  candidates: SubscriberRow[],
  topicsBySubscriber: Map<number, string[]>,
  now: Date,
  batchSizeN: number,
  maxTopicFiles: number,
): TickSelection {
  const eligible = candidates.filter((c) => isDueThisHour(c, now));

  const starved = eligible.filter((c) => isStarved(c, now));
  if (starved.length > 0) {
    const selected = starved.slice(0, batchSizeN);
    const topicSlugs = new Set<string>();
    for (const s of selected) for (const t of topicsBySubscriber.get(s.id) ?? []) topicSlugs.add(t);
    return { selected, topicSlugs, starvationRelief: true };
  }

  const selected: SubscriberRow[] = [];
  const topicSlugs = new Set<string>();
  for (const candidate of eligible) {
    if (selected.length >= batchSizeN) break;
    const topics = topicsBySubscriber.get(candidate.id) ?? [];
    const newTopics = topics.filter((t) => !topicSlugs.has(t));
    if (topicSlugs.size + newTopics.length > maxTopicFiles) continue;
    selected.push(candidate);
    for (const t of newTopics) topicSlugs.add(t);
  }
  return { selected, topicSlugs, starvationRelief: false };
}
