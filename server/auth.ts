import crypto from "crypto";
import { type Request, type Response, type NextFunction, type Express } from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";

const MemoryStore = createMemoryStore(session);

// ── Operator password ────────────────────────────────────────────────────────
// Set OPERATOR_PASSWORD in the environment. In development, if it's absent a
// random password is generated at startup and printed once to stdout so you
// can still log in. In production the server refuses to start instead:
// deployment logs are often visible to more people than the operator, so a
// password printed there isn't a secret.
const configuredPassword = process.env.OPERATOR_PASSWORD;
if (!configuredPassword && process.env.NODE_ENV === "production") {
  console.error("❌ OPERATOR_PASSWORD must be set in production (see DEPLOYMENT.md). Refusing to start.");
  process.exit(1);
}
export const OPERATOR_PASSWORD: string = configuredPassword ?? (() => {
  const generated = crypto.randomBytes(16).toString("hex");
  console.log("⚠️  OPERATOR_PASSWORD not set. Generated ephemeral password for this session:");
  console.log(`    ${generated}`);
  console.log("    Set OPERATOR_PASSWORD in your environment for a stable password.");
  return generated;
})();

// ── Session secret ───────────────────────────────────────────────────────────
// Without a fixed secret every restart signs sessions with a new key, which
// logs everyone out.
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === "production") {
  console.warn("⚠️  SESSION_SECRET not set: sessions will not survive a restart.");
}
const SESSION_SECRET: string = process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString("hex");

// ── Passport strategy ────────────────────────────────────────────────────────
passport.use(
  new LocalStrategy({ usernameField: "password", passwordField: "password" }, (password, _ignored, done) => {
    // Compare fixed-length digests: timingSafeEqual throws on unequal
    // lengths, which would turn a wrong-length guess into a 500.
    const given = crypto.createHash("sha256").update(String(password)).digest();
    const expected = crypto.createHash("sha256").update(OPERATOR_PASSWORD).digest();
    if (crypto.timingSafeEqual(given, expected)) {
      return done(null, { id: "operator" });
    }
    return done(null, false, { message: "Invalid password" });
  }),
);

passport.serializeUser((user, done) => done(null, (user as { id: string }).id));
passport.deserializeUser((id: string, done) => {
  if (id === "operator") return done(null, { id: "operator" });
  return done(null, false);
});

// ── Wire session + passport onto the Express app ────────────────────────────
export function setupAuth(app: Express): void {
  // Replit / Railway terminate TLS at a proxy; trust it so `secure: "auto"`
  // can see the original https scheme.
  app.set("trust proxy", 1);
  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: new MemoryStore({ checkPeriod: 86_400_000 }),
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: "auto",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );
  app.use(passport.initialize());
  app.use(passport.session());
}

// ── Cross-site request guard ────────────────────────────────────────────────
// Defence in depth on top of the SameSite=Lax session cookie: a state-changing
// API request whose Origin names a different host is refused. Browsers send
// Origin on every cross-origin POST, so a page on another site (or a sibling
// subdomain, which SameSite treats as same-site) can't drive the bot. Requests
// without an Origin header (curl, server-to-server) are left to the session
// check. The proxy's X-Forwarded-Host is accepted alongside Host.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export function sameOriginGuard(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get("origin");
  if (!origin) return next();
  let originHost: string;
  try { originHost = new URL(origin).host; } catch { res.status(403).json({ message: "Cross-site request refused" }); return; }
  const hosts = [req.get("host"), ...(req.get("x-forwarded-host") ?? "").split(",").map((h) => h.trim())].filter(Boolean);
  if (hosts.includes(originHost)) return next();
  res.status(403).json({ message: "Cross-site request refused" });
}

// ── Security headers ─────────────────────────────────────────────────────────
// Framing is only blocked in production: Replit's dev preview shows the app
// inside an iframe.
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  }
  next();
}

// ── Auth middleware ──────────────────────────────────────────────────────────
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: "Unauthorized" });
}

export { passport };
