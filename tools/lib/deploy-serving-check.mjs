// One definition of "the deployed API is serving on its own domain", shared by the deploy tool and
// the gate that pins it.
//
// WHY THIS EXISTS
// ---------------
// On 2026-10-04 builds completed and the app started, yet https://api.caprotoolkit.in hung for most
// of the day while the website's temporary domain answered. Hostinger runs ONE Node process per
// website, and the runtime log showed which virtual host it belonged to: after the 12:52Z deploy the
// process bound /usr/local/lsws/extapp-sock/<temporary domain>:_.sock, and the CDN completed TLS for
// api.caprotoolkit.in and then waited for a first byte that never came. Rebuilding did not help -
// seven builds completed that day. Hostinger's documented POST .../nodejs/server/restart ("does not
// rebuild or redeploy ... recover a hung application") did: at 17:33:42Z it answered 200, the new
// process bound .../api.caprotoolkit.in:_.sock two seconds later, and the API answered within a
// minute.
//
// So a deploy that finds its own domain silent restarts the process ONCE through that endpoint and
// checks again before it calls itself failed. Once, because a restart that did not help is not
// helped by another: a loop of restarts against production hides the failure from the person who
// has to act on it.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pure apart from the injected calls, so the decision is pinned offline (tests/deploy-archive-security.mjs)
 * while the real probe and restart can only run against production.
 *
 * @param {object} input
 * @param {() => Promise<boolean>} input.probe      one bounded request to the API's own domain; true when it answered
 * @param {() => Promise<{status: number}>} input.restart  Hostinger's documented restart call
 * @param {number} [input.attempts=12]              probes before the restart, and again after it
 * @param {number} [input.delayMs=5000]             wait between probes, and after the restart is accepted
 * @param {(ms: number) => Promise<void>} [input.sleep]
 * @param {(message: string) => void} [input.log]
 * @returns {Promise<{answered: boolean, restarted: boolean, restartStatus: number | null}>}
 */
export async function confirmServing({
  probe,
  restart,
  attempts = 12,
  delayMs = 5000,
  sleep = defaultSleep,
  log = () => {},
}) {
  async function answersWithin() {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let answered = false;
      try {
        answered = (await probe()) === true;
      } catch {
        // A thrown probe is silence: a timeout and a refused connection mean the same thing here.
        answered = false;
      }
      if (answered) return true;
      if (attempt < attempts) await sleep(delayMs);
    }
    return false;
  }

  if (await answersWithin()) {
    return { answered: true, restarted: false, restartStatus: null };
  }

  log("the API's own domain did not answer; restarting the Node process once (Hostinger's documented recovery)");
  let restartStatus = null;
  try {
    restartStatus = (await restart())?.status ?? null;
  } catch (error) {
    log(`the restart request failed: ${String(error)}`);
    return { answered: false, restarted: false, restartStatus: null };
  }
  if (restartStatus !== 200) {
    log(`the restart was not accepted (HTTP ${restartStatus})`);
    return { answered: false, restarted: false, restartStatus };
  }

  await sleep(delayMs);
  const answered = await answersWithin();
  log(answered ? "answering after the restart" : "still silent after the restart");
  return { answered, restarted: true, restartStatus };
}
