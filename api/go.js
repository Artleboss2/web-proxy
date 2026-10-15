/**
 * Fonction serverless Vercel : /api/go?url=https://exemple.com
 *
 * Tout est servi depuis le meme projet Vercel (frontend statique dans
 * /public + cette fonction dans /api) : pas de domaine croise, donc le
 * cookie de session est un cookie de premier parti, fiable dans tous les
 * navigateurs.
 *
 * - Sessions stockees dans Vercel KV (Redis managé), indexees par un
 *   cookie de session aleatoire `pxs` (httpOnly, secure) — jamais par IP.
 * - Rate limiting par session via KV (protection anti-abus basique).
 *
 * Variables d'environnement requises (a definir dans le dashboard Vercel) :
 *  - KV_REST_API_URL, KV_REST_API_TOKEN  (ajoutees automatiquement si tu
 *    crees une base "Vercel KV" depuis l'onglet Storage du projet)
 */

const axios = require("axios");
const cheerio = require("cheerio");
const { CookieJar } = require("tough-cookie");
const { kv } = require("@vercel/kv");
const { nanoid } = require("nanoid");
const cookie = require("cookie");

const SESSION_COOKIE = "pxs";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 jours
const RATE_LIMIT_MAX = 60; // requetes
const RATE_LIMIT_WINDOW = 60; // secondes

module.exports = async (req, res) => {
  const target = req.query.url;
  if (!target || Array.isArray(target) || !/^https?:\/\//i.test(target)) {
    res.status(400).send("Parametre url invalide (doit commencer par http(s)://)");
    return;
  }

  // --- Session ----------------------------------------------------------
  const cookies = cookie.parse(req.headers.cookie || "");
  let sessionId = cookies[SESSION_COOKIE];
  let isNewSession = false;
  if (!sessionId) {
    sessionId = nanoid(32);
    isNewSession = true;
  }

  // --- Rate limiting par session (protege le proxy et le site cible) ----
  try {
    const rlKey = `rl:${sessionId}`;
    const count = await kv.incr(rlKey);
    if (count === 1) await kv.expire(rlKey, RATE_LIMIT_WINDOW);
    if (count > RATE_LIMIT_MAX) {
      res.status(429).send("Trop de requetes, reessaie dans une minute.");
      return;
    }
  } catch (e) {
    // Si KV est indisponible, on ne bloque pas la requete mais on log.
    console.error("Rate limit KV error:", e.message);
  }

  // --- Chargement du cookie jar de la session depuis Vercel KV ----------
  const jarKey = `jar:${sessionId}`;
  let jar;
  try {
    const stored = await kv.get(jarKey);
    jar = stored ? CookieJar.deserializeSync(stored) : new CookieJar();
  } catch (e) {
    console.error("KV read error:", e.message);
    jar = new CookieJar();
  }

  try {
    const cookieHeader = await jar.getCookieString(target);

    const upstream = await axios.get(target, {
      headers: {
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
        "Accept-Language": req.headers["accept-language"] || "fr-FR,fr;q=0.9",
        Cookie: cookieHeader,
      },
      maxRedirects: 5,
      responseType: "arraybuffer",
      validateStatus: () => true,
      timeout: 15000,
    });

    // Sauvegarde les cookies du site cible dans le jar de CETTE session
    const setCookie = upstream.headers["set-cookie"];
    if (setCookie) {
      await Promise.all(
        setCookie.map((c) => jar.setCookie(c, target).catch(() => {}))
      );
    }

    try {
      await kv.set(jarKey, jar.serializeSync(), { ex: SESSION_TTL_SECONDS });
    } catch (e) {
      console.error("KV write error:", e.message);
    }

    if (isNewSession) {
      res.setHeader(
        "Set-Cookie",
        cookie.serialize(SESSION_COOKIE, sessionId, {
          httpOnly: true,
          secure: true,
          sameSite: "lax", // meme domaine (frontend + API sur Vercel) : pas besoin de "none"
          maxAge: SESSION_TTL_SECONDS,
          path: "/",
        })
      );
    }

    const contentType = upstream.headers["content-type"] || "";

    if (contentType.includes("text/html")) {
      const html = Buffer.from(upstream.data).toString("utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(upstream.status).send(rewriteHtml(html, target));
      return;
    }

    res.setHeader("Content-Type", contentType);
    res.status(upstream.status).send(Buffer.from(upstream.data));
  } catch (err) {
    console.error(err.message);
    res.status(502).send("Erreur en contactant le site cible: " + err.message);
  }
};

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);

  const toProxied = (raw) => {
    try {
      const abs = new URL(raw, base).toString();
      return "/api/go?url=" + encodeURIComponent(abs);
    } catch {
      return raw;
    }
  };

  $("a[href], link[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      $(el).attr("href", toProxied(href));
    }
  });

  $("img[src], script[src], source[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) $(el).attr("src", toProxied(src));
  });

  $("form[action]").each((_, el) => {
    const action = $(el).attr("action");
    if (action) $(el).attr("action", toProxied(action));
  });

  return $.html();
}
