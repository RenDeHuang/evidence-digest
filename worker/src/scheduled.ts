/*
 * Cron entry point — runs hourly (see wrangler.toml [triggers]).
 *
 * Claims at most BATCH_SIZE due subscribers, sends to them, and marks them
 * sent; the next tick picks up the rest. Selection is topic-aware (see
 * src/due.ts selectTick): it also stops once the tick's distinct topic
 * files would exceed MAX_TOPIC_FILES_PER_TICK, since JSON.parse-ing topic
 * files — not subscriber count — is the dominant per-tick CPU cost. A
 * subscriber whose own topic list alone can't fit gets "starvation relief"
 * after going unselected for too long: a dedicated tick, cap bypassed, just
 * for them (logged so an operator can see it happening).
 *
 * The manifest and every topic file a tick needs are fetched exactly once
 * and reused across every subscriber in the batch (module-scope cache in
 * digest.ts, keyed by the manifest's generatedAt) — never per subscriber.
 */
import type { Manifest, PublicTaxonomy } from '../../shared/types';
import type { Env } from './env';
import { batchSize, maxTopicFilesPerTick } from './env';
import { fetchDueCandidates, selectTick } from './due';
import { fetchManifest, loadTopicFiles, selectDigest, isDigestEmpty } from './digest';
import { getTaxonomy } from './taxonomy';
import { getTopicsForSubscribers, recordCheckedNoContent, recordSendSuccess, recordSendFailure, setMeta, insertToken } from './db';
import { newRawToken, hashToken } from './tokens';
import { getEmailProvider, EmailProviderError } from './email';
import { digestEmail } from './templates/digest';

const BOUNCE_THRESHOLD = 5;

export async function runScheduled(env: Env, scheduledTime?: number): Promise<void> {
  const now = scheduledTime ? new Date(scheduledTime) : new Date();
  const nowIso = now.toISOString();
  const batchSizeN = batchSize(env);
  const maxTopicFilesN = maxTopicFilesPerTick(env);

  // Heartbeat first: even a tick with nobody due, or one that fails midway,
  // should still prove the Cron Trigger fired (GET /api/health reads this).
  await setMeta(env.DB, 'last_cron_at', nowIso);

  // Pull candidates *with their topic sets* up front so selection can be
  // topic-aware — the union of topic files a tick needs to fetch+parse is
  // the dominant CPU cost, not subscriber count (see MAX_TOPIC_FILES_PER_TICK
  // in wrangler.toml and src/due.ts selectTick).
  const candidates = await fetchDueCandidates(env.DB, now, batchSizeN);
  const topicsBySubscriber = await getTopicsForSubscribers(
    env.DB,
    candidates.map((s) => s.id),
  );
  const tick = selectTick(candidates, topicsBySubscriber, now, batchSizeN, maxTopicFilesN);
  if (tick.selected.length === 0) return;

  if (tick.starvationRelief) {
    // Non-PII: subscriber ids only. An operator watching logs should be able
    // to see this happening and, if it happens often, reconsider
    // MAX_TOPIC_FILES_PER_TICK or investigate why these particular
    // subscribers keep losing the greedy selection every normal tick.
    console.log(
      `[cron] starvation relief: ${tick.selected.length} subscriber(s) processed outside the normal topic-file cap ` +
        `(ids: ${tick.selected.map((s) => s.id).join(', ')})`,
    );
  }

  const provider = getEmailProvider(env);
  if (!provider) {
    console.log('[cron] EMAIL_PROVIDER=none — skipping tick, due subscribers left untouched for retry');
    return;
  }

  let manifest: Manifest;
  try {
    manifest = await fetchManifest(env);
  } catch (err) {
    // Site-wide failure, not any individual subscriber's fault — touch
    // nothing and let the whole batch retry next tick.
    console.log(`[cron] manifest fetch failed, skipping tick: ${err instanceof Error ? err.message : 'unknown error'}`);
    return;
  }

  let taxonomy: PublicTaxonomy;
  try {
    taxonomy = (await getTaxonomy(env)).taxonomy;
  } catch (err) {
    console.log(`[cron] taxonomy fetch failed, skipping tick: ${err instanceof Error ? err.message : 'unknown error'}`);
    return;
  }

  // tick.topicSlugs is already exactly the union selectTick computed while
  // choosing who fits this tick — no need to re-derive it from
  // topicsBySubscriber (fetched above for the whole candidate pool, before
  // selection, so selectTick could see every candidate's cost).
  const topicFiles = await loadTopicFiles(env, manifest, tick.topicSlugs);

  // Diagnostic for GET /api/health: how much substantive (hasAbstract=true)
  // content this tick actually saw across the topic files it fetched, so an
  // operator can distinguish "nothing new" from "the cron/provider broke".
  const substantivePmids = new Set<string>();
  for (const topicFile of topicFiles.values()) {
    if (!topicFile) continue;
    for (const study of topicFile.studies) {
      if (study.hasAbstract) substantivePmids.add(study.pmid);
    }
  }
  await setMeta(env.DB, 'last_substantive_count', String(substantivePmids.size));

  for (const subscriber of tick.selected) {
    try {
      const topics = topicsBySubscriber.get(subscriber.id) ?? [];
      const selection = selectDigest(subscriber, topics, topicFiles, taxonomy, now);

      if (isDigestEmpty(selection)) {
        await recordCheckedNoContent(env.DB, subscriber.id, nowIso);
        continue;
      }

      const manageRaw = newRawToken();
      await insertToken(env.DB, {
        hash: await hashToken(manageRaw),
        subscriberId: subscriber.id,
        kind: 'manage',
        now: nowIso,
        expiresAt: null,
      });
      const manageUrl = `${env.SITE_URL}/manage?token=${manageRaw}`;
      const unsubscribeUrl = `${env.API_URL}/api/unsubscribe?token=${manageRaw}`;

      const rendered = digestEmail({
        groups: selection.groups,
        corrections: selection.corrections,
        frequency: subscriber.frequency,
        manageUrl,
        unsubscribeUrl,
        siteUrl: env.SITE_URL,
      });

      try {
        const result = await provider.send({
          to: subscriber.email,
          from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME },
          replyTo: env.EMAIL_REPLY_TO,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
          tags: ['digest', subscriber.frequency],
        });
        await recordSendSuccess(env.DB, {
          id: subscriber.id,
          now: nowIso,
          newestEntryDate: selection.newestEntryDate,
          studyCount: selection.totalStudies,
          providerMessageId: result.id,
        });
      } catch (sendErr) {
        // A permanent (4xx, non-429) provider error means the address is
        // bad — bounce immediately rather than burning several more ticks'
        // worth of retries on it. A transient (5xx/429) error, which the
        // adapter has already retried once internally, keeps the normal
        // consecutive-failure grace period.
        const immediateBounce = sendErr instanceof EmailProviderError && sendErr.permanent;
        await recordSendFailure(env.DB, {
          id: subscriber.id,
          now: nowIso,
          consecutiveFailures: subscriber.consecutive_failures,
          bounceThreshold: BOUNCE_THRESHOLD,
          error: sendErr instanceof Error ? sendErr.message : 'unknown send error',
          immediateBounce,
        });
      }
    } catch (err) {
      // One bad row must never poison the batch.
      console.log(`[cron] subscriber ${subscriber.id} processing failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      try {
        await recordSendFailure(env.DB, {
          id: subscriber.id,
          now: nowIso,
          consecutiveFailures: subscriber.consecutive_failures,
          bounceThreshold: BOUNCE_THRESHOLD,
          error: err instanceof Error ? err.message : 'unknown processing error',
        });
      } catch {
        // Even the failure write failed (e.g. D1 hiccup) — nothing more we
        // can safely do for this row; move on to the rest of the batch.
      }
    }
  }
}
