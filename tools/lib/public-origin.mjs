// The origin a hosted domain's files are served from - https://<domain>, always, in real use.
//
// CAPRO_DEPLOY_PUBLIC_ORIGIN exists for one reason: so tests/deploy-archive-security.mjs can drive the
// real deploy tool against a loopback stand-in for both the Hostinger API and the public site, and
// watch what it does to the archive path on every way out. Because this origin is where the exposure
// proof LOOKS, an override pointed anywhere else during a real deploy would make the proof examine the
// wrong site and pass. So it is honoured only when the Hostinger API base is loopback as well - a run
// that is entirely against fakes - and refused otherwise.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopback(value) {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * @param {string} domain   the hosted domain, e.g. api.caprotoolkit.in
 * @param {object} [env]    process.env, injectable for the gate
 * @returns {string}        an origin with no trailing slash
 */
export function publicOrigin(domain, env = process.env) {
  const override = env.CAPRO_DEPLOY_PUBLIC_ORIGIN;
  if (!override) return `https://${domain}`;
  if (!isLoopback(override) || !isLoopback(env.HOSTINGER_API_BASE || "")) {
    throw new Error(
      "CAPRO_DEPLOY_PUBLIC_ORIGIN is for loopback tests only: it and HOSTINGER_API_BASE must both be loopback - refusing to look for the archive anywhere but the real site",
    );
  }
  return override.replace(/\/+$/, "");
}
