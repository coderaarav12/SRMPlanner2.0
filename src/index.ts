import { login } from "./login"
import { getAttendanceAndMarks, getCourses, getUser, buildTimetable, getCalendar } from "./scraper"
import { generateToken, jsonResponse, corsHeaders } from "./utils"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  SESSIONS: KVNamespace
}

interface SessionData {
  cookies: string
  user: any
  attendance: any[]
  marks: any[]
  courses: any[]
  timetable: any
  calendar: any
  scrapedAt: number
}

const CACHE_TTL_MINUTES = 30
const SESSION_TTL_SECONDS = 60 * 60 // 1 hour in KV

// ─── Session helpers ──────────────────────────────────────────────────────────

async function getSession(kv: KVNamespace, token: string): Promise<SessionData | null> {
  const raw = await kv.get(token)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function saveSession(kv: KVNamespace, token: string, data: SessionData): Promise<void> {
  await kv.put(token, JSON.stringify(data), { expirationTtl: SESSION_TTL_SECONDS })
}

function isFresh(session: SessionData): boolean {
  const ageMin = (Date.now() - session.scrapedAt) / 60000
  return ageMin < CACHE_TTL_MINUTES
}

// ─── Scrape all data ──────────────────────────────────────────────────────────

async function scrapeAll(cookies: string): Promise<Omit<SessionData, "cookies" | "scrapedAt">> {
  // Fetch in parallel where possible
  const [attMarks, courseData, calendarData] = await Promise.all([
    getAttendanceAndMarks(cookies),
    getCourses(cookies),
    getCalendar(cookies).catch(() => ({ today: null, tomorrow: null, calendar: [] })),
  ])

  const user = await getUser(cookies)
  const batch = parseInt(user.batch ?? "1", 10) || 1
  const timetable = buildTimetable(courseData.courses, batch)

  return {
    user: { ...user, batch: String(batch) },
    attendance: attMarks.attendance,
    marks: attMarks.marks,
    courses: courseData.courses,
    timetable,
    calendar: calendarData,
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const origin = request.headers.get("Origin") ?? "*"

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    // ── Health check ──
    if (path === "/" || path === "/ping") {
      return jsonResponse({ status: "SRM Worker is running 🚀" }, 200, origin)
    }

    // ── Login ──
    if (path === "/api/login" && request.method === "POST") {
      let body: any
      try { body = await request.json() } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400, origin)
      }

      const { username, password, cdigest, captcha } = body as any
      if (!username || !password) {
        return jsonResponse({ error: "Username and password required" }, 400, origin)
      }

      // Check if we have a fresh cached session for this user
      const userKey = `user:${username.toLowerCase().replace("@srmist.edu.in", "")}`
      const cachedToken = await env.SESSIONS.get(userKey)
      if (cachedToken) {
        const session = await getSession(env.SESSIONS, cachedToken)
        if (session && isFresh(session)) {
          return jsonResponse({ authenticated: true, token: cachedToken, cached: true }, 200, origin)
        }
      }

      // Full login + scrape
      const loginResult = await login(username, password, cdigest, captcha)
      if (!loginResult.authenticated) {
        if (loginResult.captcha) {
          return jsonResponse({ authenticated: false, captcha: loginResult.captcha }, 401, origin)
        }
        return jsonResponse({ authenticated: false, error: loginResult.message }, 401, origin)
      }

      try {
        const data = await scrapeAll(loginResult.cookies)
        const token = generateToken()
        const session: SessionData = { ...data, cookies: loginResult.cookies, scrapedAt: Date.now() }

        await saveSession(env.SESSIONS, token, session)
        // Map username → token for cache lookup
        await env.SESSIONS.put(userKey, token, { expirationTtl: SESSION_TTL_SECONDS })

        return jsonResponse({ authenticated: true, token, cached: false }, 200, origin)
      } catch (e: any) {
        return jsonResponse({ authenticated: false, error: e.message }, 500, origin)
      }
    }

    // ── All other endpoints require token ──
    const token = request.headers.get("x-access-token")
    if (!token) return jsonResponse({ error: "Missing token" }, 401, origin)

    const session = await getSession(env.SESSIONS, token)
    if (!session) return jsonResponse({ error: "Invalid or expired token" }, 401, origin)

    // ── Sync (re-scrape) ──
    if (path === "/api/sync" && request.method === "POST") {
      try {
        const data = await scrapeAll(session.cookies)
        const updated: SessionData = { ...data, cookies: session.cookies, scrapedAt: Date.now() }
        await saveSession(env.SESSIONS, token, updated)
        return jsonResponse({ success: true, message: "Data synced" }, 200, origin)
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500, origin)
      }
    }

    // ── Data endpoints ──
    switch (path) {
      case "/api/user":
        return jsonResponse({ user: session.user }, 200, origin)

      case "/api/attendance":
        return jsonResponse({ attendance: session.attendance }, 200, origin)

      case "/api/marks":
        return jsonResponse({ marks: session.marks }, 200, origin)

      case "/api/courses":
        return jsonResponse({ courses: session.courses }, 200, origin)

      case "/api/timetable":
        return jsonResponse({
          timetable: session.timetable,
          user: session.user,
          calendar: session.calendar,
        }, 200, origin)

      case "/api/calendar":
        return jsonResponse({ calendar: session.calendar }, 200, origin)

      default:
        return jsonResponse({ error: "Not found" }, 404, origin)
    }
  },
}
