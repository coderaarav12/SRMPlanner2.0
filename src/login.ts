// ─── Login ────────────────────────────────────────────────────────────────────

export interface LoginResult {
  authenticated: boolean
  cookies: string
  message: string
  captcha?: { image: string; cdigest: string }
}

function extractCookiesFromHeaders(headers: Headers, jar: Map<string, string>) {
  const setCookie = headers.getSetCookie?.() ?? []
  for (const cookie of setCookie) {
    const [pair] = cookie.split(";")
    const eqIdx = pair.indexOf("=")
    if (eqIdx > 0) {
      const key = pair.slice(0, eqIdx).trim()
      const val = pair.slice(eqIdx + 1).trim()
      if (val && val !== "delete" && val !== "null") {
        jar.set(key, val)
      }
    }
  }
}

function cookieJarToString(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
}

async function terminateSessions(body: string, jar: Map<string, string>): Promise<boolean> {
  // Look for terminate form action in response body
  const actionMatch = body.match(/action="([^"]*terminate[^"]*)"/i) ||
    body.match(/action="([^"]+)"[^>]*>[\s\S]*?terminate/i)
  if (!actionMatch) return false

  let action = actionMatch[1]
  if (!action.startsWith("http")) action = "https://academia.srmist.edu.in" + action

  // Extract hidden inputs
  const inputs: Record<string, string> = {}
  const inputRegex = /<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi
  let m
  while ((m = inputRegex.exec(body)) !== null) {
    inputs[m[1]] = m[2]
  }

  const form = new URLSearchParams(inputs)
  const resp = await fetch(action, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieJarToString(jar),
    },
    body: form.toString(),
    redirect: "manual",
  })
  extractCookiesFromHeaders(resp.headers, jar)
  return resp.status === 200 || resp.status === 302
}

export async function login(
  username: string,
  password: string,
  cdigest?: string,
  captcha?: string,
  retryCount = 0,
  jar: Map<string, string> = new Map()
): Promise<LoginResult> {
  if (retryCount > 2) {
    return { authenticated: false, cookies: "", message: "Too many retries" }
  }

  if (!username.includes("@")) username += "@srmist.edu.in"

  const body = new URLSearchParams({
    username,
    password,
    client_portal: "true",
    portal: "10002227248",
    servicename: "ZohoCreator",
    serviceurl: "https://academia.srmist.edu.in/",
    is_ajax: "true",
    grant_type: "password",
    service_language: "en",
  })
  if (cdigest) body.set("cdigest", cdigest)
  if (captcha) body.set("captcha", captcha)

  const resp = await fetch("https://academia.srmist.edu.in/accounts/signin.ac", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Origin": "https://academia.srmist.edu.in",
      "Referer": "https://academia.srmist.edu.in/",
    },
    body: body.toString(),
    redirect: "manual",
  })

  extractCookiesFromHeaders(resp.headers, jar)
  const text = await resp.text()

  // Check for concurrent session
  if (text.toLowerCase().includes("concurrent") || text.toLowerCase().includes("terminate")) {
    const terminated = await terminateSessions(text, jar)
    if (terminated) {
      return login(username, password, cdigest, captcha, retryCount + 1, jar)
    }
  }

  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    return { authenticated: false, cookies: "", message: "Unexpected server response" }
  }

  // Error object
  if (data?.error?.msg) {
    return { authenticated: false, cookies: "", message: data.error.msg }
  }

  // Captcha required
  if (data?.status === "fail" && (data?.code === "HIP_REQUIRED" || data?.code === "HIP_FAILED")) {
    const cdig = data?.cdigest ?? ""
    return {
      authenticated: false,
      cookies: "",
      message: data?.message ?? "Captcha required",
      captcha: {
        cdigest: cdig,
        image: `https://academia.srmist.edu.in/accounts/p/40-10002227248/webclient/v1/captcha/${cdig}?darkmode=false`,
      },
    }
  }

  // Get tokens
  const inner = data?.data
  if (!inner) {
    return { authenticated: false, cookies: "", message: data?.message ?? "Invalid credentials" }
  }

  const accessToken = inner.access_token ?? ""
  const redirectURL = inner.oauthorize_uri ?? ""
  if (!accessToken || !redirectURL) {
    return { authenticated: false, cookies: "", message: "Missing tokens in response" }
  }

  // Follow redirect to establish JSESSIONID
  const finalURL = `${redirectURL}&access_token=${accessToken}`
  const authResp = await fetch(finalURL, {
    method: "GET",
    headers: { Cookie: cookieJarToString(jar) },
    redirect: "follow",
  })
  extractCookiesFromHeaders(authResp.headers, jar)

  const cookieStr = cookieJarToString(jar)
  if (!cookieStr.includes("JSESSIONID")) {
    return { authenticated: false, cookies: "", message: "Session failed: JSESSIONID not set" }
  }

  return { authenticated: true, cookies: cookieStr, message: "Success" }
}
