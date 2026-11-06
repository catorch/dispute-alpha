import { createLocalJWKSet, createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { isDevLike, type Env } from "../env";

let remote: { url: string; jwks: JWTVerifyGetKey } | undefined;

function keySet(env: Env): JWTVerifyGetKey {
  // Test and local runs supply a static JWKS; deployed environments always fetch Access's certs.
  if (env.ACCESS_JWKS && isDevLike(env)) return createLocalJWKSet(JSON.parse(env.ACCESS_JWKS));
  const url = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  if (remote?.url !== url) remote = { url, jwks: createRemoteJWKSet(new URL(url)) }; // cached per isolate
  return remote.jwks;
}

/** Verifies the Cf-Access-Jwt-Assertion header: signature, issuer, audience, expiry (R3.2). */
export async function verifyAccessJwt(env: Env, token: string) {
  const { payload } = await jwtVerify(token, keySet(env), { issuer: `https://${env.ACCESS_TEAM_DOMAIN}`, audience: env.ACCESS_AUD });
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  if (!email) throw new Error("Access token has no email");
  return { email, iat: (payload.iat ?? 0) * 1000 };
}
