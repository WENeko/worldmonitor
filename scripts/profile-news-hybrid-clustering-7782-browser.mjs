#!/usr/bin/env node
/**
 * Browser/CPU-throttled twin of scripts/profile-news-hybrid-clustering-7782.mjs.
 * Bundles the shared clustering core with production minify, then times the
 * synchronous Jaccard stage and a blob-worker round trip in Chromium.
 *
 * Usage:
 *   node scripts/profile-news-hybrid-clustering-7782-browser.mjs <minimized-fixture.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAME_BUDGET_MS = 16.7;
const LONG_TASK_MS = 50;
const SAMPLES = 9;
const CPU_RATES = [1, 4, 6];

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    median: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sum / Math.max(sorted.length, 1)),
  };
}

function bundleCore() {
  mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
  const outfile = resolve(ROOT, 'tmp/news-clustering-core.min.js');
  const result = spawnSync(
    resolve(ROOT, 'node_modules/.bin/esbuild'),
    [
      resolve(ROOT, 'shared/news-clustering-core.js'),
      '--bundle',
      '--minify',
      '--format=iife',
      '--global-name=NewsClustering',
      `--outfile=${outfile}`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'esbuild failed');
  }
  return readFileSync(outfile, 'utf8');
}

function makeHighDiversity(count) {
  return Array.from({ length: count }, (_, i) => ({
    source: `Outlet${String(i % 47).padStart(2, '0')}`,
    title: `UniqueTopic${i} DistinctEvent${i} Country${i % 173} Marker${i}`,
    link: `https://fixture.test/high-diversity/${i}`,
    publishedAt: Date.UTC(2026, 8, 6, 12, 0, 0) - i * 60_000,
    isAlert: i % 17 === 0,
  }));
}

async function measurePage(page, items, samples) {
  return page.evaluate(async ({ items: fixtureItems, samples: sampleCount, longTaskMs }) => {
    const news = fixtureItems.map((item) => ({
      source: item.source,
      title: item.title,
      link: item.link,
      pubDate: new Date(item.publishedAt),
      isAlert: Boolean(item.isAlert),
      ...(item.threat ? { threat: item.threat } : {}),
      ...(Number.isFinite(item.credibilityScore) ? { credibilityScore: item.credibilityScore } : {}),
      ...(item.lat != null && item.lon != null ? { lat: item.lat, lon: item.lon } : {}),
    }));

    const longtasks = [];
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longtasks.push({ duration: entry.duration, startTime: entry.startTime });
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      /* longtask unsupported */
    }

    const clusteringApi = globalThis.NewsClustering;
    if (typeof clusteringApi?.clusterNewsCore !== 'function') {
      throw new Error('NewsClustering bundle did not export clusterNewsCore');
    }

    const yieldTick = () => new Promise((resolve) => setTimeout(resolve, 0));
    await yieldTick();
    const clusteringLongTasksBefore = longtasks.length;
    const syncTimings = [];
    let clusterCount = 0;
    clusteringApi.clusterNewsCore(news, () => 4);
    await yieldTick();
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      const clusters = clusteringApi.clusterNewsCore(news, () => 4);
      syncTimings.push(performance.now() - start);
      clusterCount = clusters.length;
      await yieldTick();
    }
    const clusteringLongTasks = longtasks.slice(clusteringLongTasksBefore);

    const serializeTimings = [];
    let itemBytes = 0;
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      const json = JSON.stringify(news);
      JSON.parse(json);
      serializeTimings.push(performance.now() - start);
      itemBytes = new Blob([json]).size;
      await yieldTick();
    }

    const cloneTimings = [];
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      structuredClone(news);
      cloneTimings.push(performance.now() - start);
      await yieldTick();
    }

    const workerSource = `${document.getElementById('clustering-bundle').textContent}
self.onmessage = (event) => {
  const items = event.data.items.map((item) => ({
    ...item,
    pubDate: new Date(item.pubDate),
  }));
  const clusters = NewsClustering.clusterNewsCore(items, () => 4);
  self.postMessage({ clusters });
};
self.postMessage({ type: 'ready' });`;

    function spawnWorker() {
      const blob = new Blob([workerSource], { type: 'text/javascript' });
      return new Worker(URL.createObjectURL(blob));
    }

    function requestCluster(worker, payload) {
      return new Promise((resolve, reject) => {
        const onMessage = (event) => {
          if (event.data?.type === 'ready') return;
          worker.removeEventListener('message', onMessage);
          resolve(hydrateWorkerClusters(event.data));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', reject, { once: true });
        worker.postMessage({ items: payload });
      });
    }

    function hydrateWorkerClusters(message) {
      const clusters = Array.isArray(message?.clusters) ? message.clusters : [];
      return clusters.map((cluster) => ({
        ...cluster,
        firstSeen: new Date(cluster.firstSeen),
        lastUpdated: new Date(cluster.lastUpdated),
        allItems: (cluster.allItems ?? []).map((item) => ({
          ...item,
          pubDate: new Date(item.pubDate),
        })),
      }));
    }

    const payload = news.map((item) => ({
      ...item,
      pubDate: item.pubDate.toISOString(),
    }));

    const coldStarted = performance.now();
    const coldWorker = spawnWorker();
    await new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.data?.type === 'ready') {
          coldWorker.removeEventListener('message', onMessage);
          resolve();
        }
      };
      coldWorker.addEventListener('message', onMessage);
      coldWorker.addEventListener('error', reject, { once: true });
    });
    const coldReadyMs = performance.now() - coldStarted;
    const coldRequestStarted = performance.now();
    await requestCluster(coldWorker, payload);
    const coldRoundTripMs = performance.now() - coldRequestStarted;
    coldWorker.terminate();

    const warmWorker = spawnWorker();
    await new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.data?.type === 'ready') {
          warmWorker.removeEventListener('message', onMessage);
          resolve();
        }
      };
      warmWorker.addEventListener('message', onMessage);
      warmWorker.addEventListener('error', reject, { once: true });
    });
    await requestCluster(warmWorker, payload);
    const warmTimings = [];
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      await requestCluster(warmWorker, payload);
      warmTimings.push(performance.now() - start);
    }
    warmWorker.terminate();

    return {
      clusterCount,
      itemCount: news.length,
      syncTimings,
      serializeTimings,
      cloneTimings,
      itemBytes,
      coldReadyMs,
      coldRoundTripMs,
      warmTimings,
      longtasks: clusteringLongTasks.filter((entry) => entry.duration >= longTaskMs),
      allLongtasks: longtasks.filter((entry) => entry.duration >= longTaskMs),
    };
  }, { items, samples, longTaskMs: LONG_TASK_MS });
}

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('usage: node scripts/profile-news-hybrid-clustering-7782-browser.mjs <minimized-fixture.json>');
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const bundle = bundleCore();
  const cases = {
    representative: fixture.items,
    highDiversity1500: makeHighDiversity(1500),
  };

  const browser = await chromium.launch({ headless: true });
  const reports = [];
  try {
    for (const cpu of CPU_RATES) {
      for (const [name, items] of Object.entries(cases)) {
        const page = await browser.newPage();
        await page.setContent(
          `<!doctype html><html><head></head><body>
<script id="clustering-bundle">${bundle}</script>
<script>${bundle}</script>
</body></html>`,
        );
        const session = await page.context().newCDPSession(page);
        await session.send('Emulation.setCPUThrottlingRate', { rate: cpu });
        const raw = await measurePage(page, items, SAMPLES);
        await page.close();
        const sync = summarize(raw.syncTimings);
        reports.push({
          name,
          cpuThrottleRate: cpu,
          browser: 'chromium',
          productionMinify: true,
          itemCount: raw.itemCount,
          clusterCount: raw.clusterCount,
          syncMainThreadMs: sync,
          serializationMs: summarize(raw.serializeTimings),
          structuredCloneMs: summarize(raw.cloneTimings),
          serializationBytes: { items: raw.itemBytes },
          workerColdReadyMs: round(raw.coldReadyMs),
          workerColdRoundTripMs: round(raw.coldRoundTripMs),
          workerWarmRoundTripMs: summarize(raw.warmTimings),
          clusteringLongTaskCount: raw.longtasks.length,
          clusteringLongTaskDurationsMs: raw.longtasks.map((entry) => round(entry.duration)),
          pageLongTaskCount: raw.allLongtasks.length,
          pageLongTaskDurationsMs: raw.allLongtasks.map((entry) => round(entry.duration)),
          exceedsFrameBudget: sync.median >= FRAME_BUDGET_MS,
          exceedsLongTask: sync.median >= LONG_TASK_MS || raw.longtasks.length > 0,
        });
      }
    }
  } finally {
    await browser.close();
  }

  const justified = reports
    .filter((row) => row.name === 'representative' || row.name === 'highDiversity1500')
    .some((row) => row.exceedsLongTask || row.exceedsFrameBudget);

  const report = {
    issue: 7782,
    budgets: { frameMs: FRAME_BUDGET_MS, longTaskMs: LONG_TASK_MS },
    samplesPerCase: SAMPLES,
    fixture: {
      path: fixturePath,
      capturedAt: fixture.capturedAt ?? null,
      generatedAt: fixture.generatedAt ?? null,
      source: fixture.source ?? null,
    },
    cases: reports,
    gate: {
      syncStageCausesRepeatableBudgetMiss: justified,
      recommendation: justified ? 'implementation-justified' : 'stop-without-moving-work',
    },
  };
  writeFileSync(resolve(ROOT, 'tmp/news-hybrid-clustering-7782-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
