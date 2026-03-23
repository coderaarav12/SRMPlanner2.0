import { convertHexToHTML, decodeHTMLEntities, parseFloat_, parseInt_, extractCookies } from "./utils"

const BASE = "https://academia.srmist.edu.in/srm_university/academia-academic-services/page"
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"

// ─── Fetch + decode ───────────────────────────────────────────────────────────

async function fetchPage(path: string, cookie: string): Promise<string> {
  const resp = await fetch(`${BASE}/${path}`, {
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": UA,
      Referer: "https://academia.srmist.edu.in/",
      Cookie: cookie,
    },
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${path}`)
  const text = await resp.text()

  const parts = text.split(".sanitize('")
  if (parts.length >= 2) {
    return convertHexToHTML(parts[1].split("')")[0])
  }

  if (text.includes('zmlvalue="')) {
    const raw = text.split('zmlvalue="')[1]?.split('" > </div> </div>')[0] ?? ""
    return decodeHTMLEntities(convertHexToHTML(raw))
  }

  return text
}

// ─── HTML table parser ────────────────────────────────────────────────────────

function parseTable(html: string): string[][] {
  const rows: string[][] = []
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
  let rowMatch
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const cells: string[] = []
    let cellMatch
    const rowContent = rowMatch[1]
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const text = cellMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      cells.push(text)
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

function extractAllTables(html: string): string[] {
  const tables: string[] = []
  const tableRegex = /<table[\s\S]*?<\/table>/gi
  let m
  while ((m = tableRegex.exec(html)) !== null) {
    tables.push(m[0])
  }
  return tables
}

function extractRegNumber(html: string): string {
  return html.match(/RA2\d{12}/)?.[0] ?? ""
}

// ─── Attendance + Marks ───────────────────────────────────────────────────────
//
// Attendance columns (verified from live screenshot):
//   0: Course Code  1: Course Title  2: Category  3: Faculty Name
//   4: Slot  5: Room No  6: Hours Conducted  7: Hours Absent  8: Attn%
//
// Marks table — each cell in the test performance column contains text like:
//   "FT-II / 15.00  11.00"  or  "FT-I / 5.00  4.50"  or  "Abs"
// We parse each TD cell individually for max robustness.

export async function getAttendanceAndMarks(cookie: string) {
  const html = await fetchPage("My_Attendance", cookie)
  const regNumber = extractRegNumber(html)

  // ── Attendance ──
  const attSection = html.split(`<table style="font-size :16px;" border="1"`)?.[1] ?? ""
  const attHTML = `<table>${attSection.split("</table>")[0]}</table>`
  const attRows = parseTable(attHTML)

  const attendance: any[] = []
  for (const row of attRows) {
    if (row.length < 8) continue
    const code = row[0]
    if (!code.match(/^\d{2}[A-Z]/)) continue

    const conducted = parseFloat_(row[6])
    const absent    = parseFloat_(row[7])
    const pct       = conducted > 0 ? ((conducted - absent) / conducted) * 100 : 0

    attendance.push({
      courseCode:           code.replace(/Regular/gi, "").trim(),
      courseTitle:          row[1],
      category:             row[2],
      facultyName:          row[3],
      slot:                 row[4],
      hoursConducted:       conducted,
      hoursAbsent:          absent,
      attendancePercentage: parseFloat(pct.toFixed(2)),
    })
  }

  // ── Marks — find the marks table robustly ──
  const courseMap: Record<string, string> = {}
  for (const a of attendance) courseMap[a.courseCode] = a.courseTitle

  const marks: any[] = []

  // Strategy: find ALL tables in the marks section, pick the one that has course codes
  // The marks section is always after the attendance table
  const afterAtt = html.split(`<table style="font-size :16px;" border="1"`)?.[1] ?? html
  const allTables = extractAllTables(afterAtt)

  // Find the marks table — it has rows with course codes in column 0
  let marksRows: string[][] = []
  for (const tbl of allTables) {
    const rows = parseTable(tbl)
    // Marks table: col 0 = course code, col 1 = course type
    // Check if any row looks like a marks row
    const hasMarksRows = rows.some(r =>
      r.length >= 2 && r[0]?.match(/^\d{2}[A-Z]/) && r[1]?.match(/Theory|Practical/i)
    )
    // Also accept header + data rows
    const hasHeader = rows.some(r => r[0] === "Course Code")
    if (hasMarksRows || (hasHeader && rows.length > 1)) {
      marksRows = rows
      break
    }
  }

  // Fallback: original split method
  if (marksRows.length === 0) {
    const marksSection = html.split(`<table border="1" align="center" cellpadding="1" cellspacing="1">`)?.[1] ?? ""
    const marksHTML = `<table>${marksSection.split("</table>")[0]}</table>`
    marksRows = parseTable(marksHTML)
  }

  for (const row of marksRows) {
    if (row.length < 2) continue
    const code = row[0]?.trim()
    const type = row[1]?.trim()
    if (!code || !type) continue
    if (!code.match(/^\d{2}[A-Z]/)) continue  // skip header row

    // Parse tests from all remaining cells
    // Each test is formatted as "NAME / MAX  SCORED" or just "Abs"
    // Try multiple regex patterns to handle all SRM test name formats:
    //   FT-I, FT-II, CT-I, CT-II, Model Exam, Cycle Test 1, etc.
    const testRaw = row.slice(2).join(" ")
    const tests: any[] = []

    // Pattern 1: "TESTNAME / MAX SCORED" — handles any test name with letters/numbers/spaces/hyphens
    const testRegex1 = /([A-Za-z][A-Za-z0-9\s\-]*?)\s*\/\s*([\d.]+)\s+([\d.]+|Abs)/g
    let tm
    while ((tm = testRegex1.exec(testRaw)) !== null) {
      const testName = tm[1].trim()
      const total    = parseFloat(parseFloat_(tm[2]).toFixed(2))
      const scored   = tm[3] === "Abs" ? "Abs" : parseFloat(parseFloat_(tm[3]).toFixed(2))
      // Avoid duplicates
      if (testName && total > 0 && !tests.find(t => t.test === testName)) {
        tests.push({ test: testName, scored, total })
      }
    }

    const overall = tests.reduce(
      (acc, t) => ({
        scored: acc.scored + (t.scored === "Abs" ? 0 : t.scored),
        total:  acc.total  + t.total,
      }),
      { scored: 0, total: 0 }
    )

    marks.push({
      courseCode:      code,
      courseName:      courseMap[code] ?? "",
      courseType:      type,
      testPerformance: tests,
      overall: {
        scored: parseFloat(overall.scored.toFixed(2)),
        total:  parseFloat(overall.total.toFixed(2)),
      },
    })
  }

  return { regNumber, attendance, marks }
}

// ─── Courses ──────────────────────────────────────────────────────────────────
//
// Course columns (verified from live screenshot):
//   0: S.No  1: Course Code  2: Course Title  3: Credit
//   4: Regn Type  5: Category  6: Course Type  7: Faculty  8: Slot  9: Room  10: AY

export async function getCourses(cookie: string) {
  const html = await fetchPage("My_Time_Table_2023_24", cookie)
  const regNumber = extractRegNumber(html)

  let tableHTML = ""

  if (html.includes('class="course_tbl"')) {
    const section = html.split('class="course_tbl"')[1] ?? ""
    tableHTML = `<table>${section.split("</table>")[0]}</table>`
  } else if (html.includes("class='course_tbl'")) {
    const section = html.split("class='course_tbl'")[1] ?? ""
    tableHTML = `<table>${section.split("</table>")[0]}</table>`
  } else {
    // Scan all tables, find the one with course code patterns
    const allTables = extractAllTables(html)
    for (const tbl of allTables) {
      const rows = parseTable(tbl)
      const dataRows = rows.filter(r => r.length >= 10 && r[1]?.match(/^\d{2}[A-Z]/))
      if (dataRows.length > 0) {
        tableHTML = tbl
        break
      }
    }
  }

  const rows = parseTable(tableHTML)
  const courses: any[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.length < 10) continue
    const code = row[1]?.trim()
    if (!code || !code.match(/^\d{2}[A-Z]/)) continue

    const slot = row[8].replace(/-$/, "").trim()
    courses.push({
      code,
      title:          row[2].split(" –")[0].split(" \u2013")[0].trim(),
      credit:         parseInt_(row[3]),
      courseCategory: row[4],
      category:       row[5],
      type:           row[6] || "N/A",
      slotType:       slot.includes("P") ? "Practical" : "Theory",
      faculty:        row[7] || "N/A",
      slot,
      room:           row[9] || "N/A",
      academicYear:   row[10] || "",
    })
  }

  return { regNumber, courses }
}

// ─── User ─────────────────────────────────────────────────────────────────────

export async function getUser(cookie: string) {
  const html = await fetchPage("My_Time_Table_2023_24", cookie)
  const regNumber = extractRegNumber(html)

  const tableSection = html.split(`<table border="0" align="left" cellpadding="1"`)?.[1] ?? ""
  const rows = parseTable(`<table>${tableSection.split("</table>")[0]}</table>`)

  const user: Record<string, any> = { regNumber }
  for (const row of rows) {
    for (let i = 0; i < row.length - 1; i += 2) {
      const key = row[i].replace(":", "").trim()
      const val = row[i + 1]?.trim() ?? ""
      switch (key) {
        case "Name":    user.name    = val; break
        case "Program": user.program = val; break
        case "Semester": user.semester = parseInt_(val); break
        case "Department": {
          const parts    = val.split("-")
          user.department = parts[0].trim()
          user.section    = parts[1]?.replace(/\(.*Section\)/, "").trim() ?? ""
          break
        }
        case "Combo / Batch":
          // "1/1" → "1", "2/1" → "2"
          user.batch = (val.match(/\d/) ?? ["1"])[0]
          break
      }
    }
  }

  return user
}

// ─── Timetable ────────────────────────────────────────────────────────────────

const BATCH1_SLOTS = [
  { day: 1, slots: ["A","A","F","F","G","P6","P7","P8","P9","P10","L11","L12"] },
  { day: 2, slots: ["P11","P12","P13","P14","P15","B","B","G","G","A","L21","L22"] },
  { day: 3, slots: ["C","C","A","D","B","P26","P27","P28","P29","P30","L31","L32"] },
  { day: 4, slots: ["P31","P32","P33","P34","P35","D","D","B","E","C","L41","L42"] },
  { day: 5, slots: ["E","E","C","F","D","P46","P47","P48","P49","P50","L51","L52"] },
]

const BATCH2_SLOTS = [
  { day: 1, slots: ["P1","P2","P3","P4","P5","A","A","F","F","G","L11","L12"] },
  { day: 2, slots: ["B","B","G","G","A","P16","P17","P18","P19","P20","L21","L22"] },
  { day: 3, slots: ["P21","P22","P23","P24","P25","C","C","A","D","B","L31","L32"] },
  { day: 4, slots: ["D","D","B","E","C","P36","P37","P38","P39","P40","L41","L42"] },
  { day: 5, slots: ["P41","P42","P43","P44","P45","E","E","C","F","D","L51","L52"] },
]

const TIME_SLOTS = [
  "08:00","08:50","09:45","10:40","11:35","12:30","01:25","02:20","03:10","04:00","04:50","05:30",
]

export function buildTimetable(courses: any[], batch: number) {
  const batchSlots = batch === 2 ? BATCH2_SLOTS : BATCH1_SLOTS

  const slotMap: Record<string, any> = {}
  for (const course of courses) {
    const slots = course.slot.split("-").map((s: string) => s.trim())
    for (const slot of slots) {
      if (!slot) continue
      slotMap[slot] = {
        code:    course.code,
        name:    course.title,
        type:    course.slotType,
        room:    course.room,
        faculty: course.faculty,
        slot,
      }
    }
  }

  const schedule = batchSlots.map(({ day, slots }) => ({
    day,
    table: slots.map((slot, i) => {
      const course = slotMap[slot]
      if (!course) return null
      return { ...course, hour: i + 1, time: TIME_SLOTS[i] ?? "" }
    }),
  }))

  return { batch: String(batch), schedule }
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

export async function getCalendar(cookie: string) {
  let html = ""
  try {
    html = await fetchPage("Academic_Planner_2025_26_EVEN", `ZCNEWUIPUBLICPORTAL=true; cli_rgn=IN; ${extractCookies(cookie)}`)
  } catch {
    html = await fetchPage("Academic_Planner_2025_26_ODD", `ZCNEWUIPUBLICPORTAL=true; cli_rgn=IN; ${extractCookies(cookie)}`)
  }

  const monthHeaders: string[] = []
  const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi
  let m
  while ((m = thRegex.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, "").trim()
    if (text.includes("'2")) monthHeaders.push(text)
  }

  const calendar: any[] = monthHeaders.map(month => ({ month, days: [] }))

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  while ((m = rowRegex.exec(html)) !== null) {
    const cells: string[] = []
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
    let cm
    while ((cm = cellRegex.exec(m[1])) !== null) {
      cells.push(cm[1].replace(/<[^>]+>/g, "").trim())
    }

    for (let i = 0; i < monthHeaders.length; i++) {
      const pad      = i * 5
      const date     = cells[pad]?.trim()
      const day      = cells[pad + 1]?.trim()
      const event    = cells[pad + 2]?.trim()
      const dayOrder = cells[pad + 3]?.trim()

      if (date && dayOrder !== undefined) {
        calendar[i].days.push({ date, day, event: event || "", dayOrder: dayOrder || "-" })
      }
    }
  }

  const monthOrder = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
  calendar.sort((a, b) => {
    const ai = monthOrder.findIndex(mo => a.month.startsWith(mo))
    const bi = monthOrder.findIndex(mo => b.month.startsWith(mo))
    return ai - bi
  })

  const now        = new Date()
  const curMonth   = monthOrder[now.getMonth()]
  const monthEntry = calendar.find(c => c.month.includes(curMonth))
  const todayDay   = now.getDate()

  const today    = monthEntry?.days?.find((d: any) => parseInt_(d.date) === todayDay)     ?? null
  const tomorrow = monthEntry?.days?.find((d: any) => parseInt_(d.date) === todayDay + 1) ?? null

  return { today, tomorrow, calendar }
}