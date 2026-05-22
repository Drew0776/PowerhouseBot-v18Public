import crypto from "crypto";
import { type Request, type Response, type NextFunction, type Express } from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";

const MemoryStore = createMemoryStore(session);

// ── Operator password ────────────────────────────────────────────────────────
// Set OPERATOR_PASSWORD in the environment.  If absent, a random password is
// generated at startup and printed once to stdout so you can still log in.
const configuredPassword = process.env.OPERATOR_PASSWORD;
export const OPERATOR_PASSWORD: string = configuredPassword ?? (() => {
  const generated = crypto.randomBytes(16).toString("hex");
  console.log("⚠️  OPERATOR_PASSWORD not set. Generated ephemeral password for this session:");
  console.log(`    ${generated}`);
  console.log("    Set OPERATOR_PASSWORD in your environment for a stable password.");
  return generated;
})();

// ── Session secret ───────────────────────────────────────────────────────────
const SESSION_SECRET: string = process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString("hex");

// ── Passport strategy ────────────────────────────────────────────────────────
passport.use(
  new LocalStrategy({ usernameField: "password", passwordField: "password" }, (password, _ignored, done) => {
    if (crypto.timingSafeEqual(Buffer.from(password), Buffer.from(OPERATOR_PASSWORD))) {
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
  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: new MemoryStore({ checkPeriod: 86_400_000 }),
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );
  app.use(passport.initialize());
  app.use(passport.session());
}

// ── Auth middleware ──────────────────────────────────────────────────────────
// Task #67: auth gate intentionally bypassed — dashboard is open.
// The passport strategy, /api/auth/login, /api/auth/logout routes, the
// OPERATOR_PASSWORD env var, and the client/src/pages/login.tsx page are
// all left in place. To re-enable, restore the isAuthenticated() check
// below and flip the `isAuthenticated = true` short-circuit in
// client/src/App.tsx.
export function requireAuth(_req: Request, _res: Response, next: NextFunction): void {
  return next();
}

export { passport };
