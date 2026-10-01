// Docker healthcheck for the Postiz container (mounted read-only, run by
// Postiz's own Node). Healthy only when:
//   1. the Postiz API answers, and
//   2. a worker process running in THIS container is really polling Temporal
//      for jobs right now.
// Check 2 catches a known Postiz failure where the worker silently never
// starts, hangs, or stops, and posts wait in the queue forever
// (github.com/gitroomhq/postiz-app/issues/2035, #1550). When this fails for
// ~2 minutes, the watchdog service restarts the container.
const fs = require('node:fs');
const os = require('node:os');

const TEMPORAL_HTTP = process.env.TEMPORAL_HTTP_URL || 'http://temporal:7243';
const MAX_SILENCE_MS = 150_000;

// Temporal names each poller "<pid>@<hostname>"; only count pollers that are
// live processes of this container (not ones left over from before a restart).
function isOurLiveWorker(identity) {
  const [pid, host] = String(identity).split('@');
  if (host !== os.hostname() || !/^\d+$/.test(pid)) return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('orchestrator');
  } catch {
    return false;
  }
}

async function main() {
  const api = await fetch('http://localhost:5000/api/public/v1/is-connected', { signal: AbortSignal.timeout(8000) });
  if (api.status >= 500) throw new Error(`Postiz API answered ${api.status}`);

  const res = await fetch(
    `${TEMPORAL_HTTP}/api/v1/namespaces/default/task-queues/main?taskQueueType=TASK_QUEUE_TYPE_WORKFLOW`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`Temporal answered ${res.status}`);
  const { pollers = [] } = await res.json();
  const alive = pollers.filter(
    (p) => isOurLiveWorker(p.identity) && Date.now() - (Date.parse(p.lastAccessTime) || 0) < MAX_SILENCE_MS
  );
  if (alive.length === 0) throw new Error('Postiz worker is not polling for jobs');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  }
);
