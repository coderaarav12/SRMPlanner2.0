// ─── HTML / Cookie Utilities ─────────────────────────────────────────────────

export function convertHexToHTML(hexString: string): string {
  if (!hexString) return ""
  return hexString.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
}

export function decodeHTMLEntities(str: string): string {
  if (!str) return ""
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#[xX]([A-Fa-f0-9]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

export function extractCookies(cookieStr: string): string {
  const iamadt = getCookie(cookieStr, "_iamadt_client_10002227248")
  const iambdt = getCookie(cookieStr, "_iambdt_client_10002227248")
  return `_iamadt_client_10002227248=${iamadt}; _iambdt_client_10002227248=${iambdt};`
}

export function getCookie(cookieStr: string, name: string): string {
  const match = cookieStr.match(new RegExp(`${name}=([^;]+)`))
  return match ? match[1] : ""
}

export function parseFloat_(s: string): number {
  const f = parseFloat(s)
  return isNaN(f) ? 0 : f
}

export function parseInt_(s: string): number {
  const i = parseInt(s, 10)
  return isNaN(i) ? 0 : i
}

export function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, "")
}

// ─── CORS Headers ─────────────────────────────────────────────────────────────

export function corsHeaders(origin: string = "*"): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-access-token",
    "Access-Control-Max-Age": "86400",
  }
}

export function jsonResponse(data: unknown, status = 200, origin = "*"): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  })
}
