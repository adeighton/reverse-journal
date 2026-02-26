import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { generate, generateStructured, MODELS } from "./ai.js";

// ── Rate limit resilience ──────────────────────────────────────────────────

function isRateLimitError(err) {
  // AI SDK APICallError uses .statusCode
  // AI SDK RetryError wraps the real error in .lastError
  const direct = err?.statusCode || err?.status;
  const nested = err?.lastError?.statusCode || err?.lastError?.status;
  const status = direct || nested;
  if (status === 429 || status === 529) return true;
  // Also catch by error message for wrapped errors
  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("overloaded") || msg.includes("concurrent")) {
    return true;
  }
  // AI SDK marks retryable errors (on APICallError or its RetryError wrapper)
  if (err?.isRetryable === true || err?.lastError?.isRetryable === true) return true;
  return false;
}

async function retryWithJitter(fn, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimitError(err) && attempt < maxRetries) {
        const base = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s, 16s, 32s
        const jitter = Math.random() * base * 0.5;
        await new Promise((r) => setTimeout(r, base + jitter));
        continue;
      }
      throw err;
    }
  }
}

// ── Stage 1: Compress events ────────────────────────────────────────────────

function compressEvents(events, userEmails = []) {
  const selfEmails = new Set(userEmails.map((e) => e.toLowerCase()));

  return events
    .filter((e) => e.status !== "cancelled")
    .map((e) => {
      const start = e.start?.dateTime || e.start?.date;
      const end = e.end?.dateTime || e.end?.date;
      let durationMin = null;
      if (e.start?.dateTime && e.end?.dateTime) {
        durationMin = Math.round(
          (new Date(end) - new Date(start)) / 60000,
        );
      }
      const attendeeNames = (e.attendees || [])
        .filter((a) => !a.self && !a.resource)
        .map((a) => a.displayName || a.email?.split("@")[0])
        .filter(Boolean);

      const organizerEmail = e.organizer?.email?.toLowerCase() || "";
      const isSelfOrganized =
        e.organizer?.self === true ||
        selfEmails.has(organizerEmail);

      const organizer = isSelfOrganized
        ? null
        : e.organizer?.displayName || e.organizer?.email?.split("@")[0] || null;

      const desc = e.description
        ? e.description.replace(/<[^>]*>/g, "").slice(0, 200)
        : null;

      const compressed = {
        title: e.summary || "(no title)",
        date: start?.slice(0, 10),
        allDay: !e.start?.dateTime,
      };
      if (e.start?.dateTime) compressed.time = start.slice(11, 16);
      if (durationMin) compressed.durationMin = durationMin;
      if (attendeeNames.length) compressed.attendees = attendeeNames;
      if (organizer) compressed.organizer = organizer;
      if (e.location) compressed.location = e.location;
      if (desc) compressed.description = desc;
      if (isSelfOrganized) compressed.isSelfOrganized = true;

      return compressed;
    });
}

// ── Stage 2: Pre-compute analytics + weekly baseline ────────────────────────

function computeAnalytics(compressed, startDate, endDate, userEmails = []) {
  const totalDays = Math.max(
    1,
    Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000),
  );
  const totalWeeks = Math.max(1, totalDays / 7);

  // Self names to exclude from people counts
  const selfNames = new Set(
    userEmails.map((e) => e.split("@")[0].toLowerCase()),
  );

  // Top people (excluding self)
  const peopleCounts = new Map();
  for (const e of compressed) {
    const names = [...(e.attendees || [])];
    if (e.organizer) names.push(e.organizer);
    for (const name of names) {
      if (selfNames.has(name.toLowerCase())) continue;
      peopleCounts.set(name, (peopleCounts.get(name) || 0) + 1);
    }
  }
  const topPeople = [...peopleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({
      name,
      count,
      perWeek: +(count / totalWeeks).toFixed(1),
    }));

  // Recurring events
  const titleGroups = new Map();
  for (const e of compressed) {
    const key = e.title.toLowerCase().trim();
    if (!titleGroups.has(key)) titleGroups.set(key, []);
    titleGroups.get(key).push(e);
  }
  const recurring = [...titleGroups.entries()]
    .filter(([, events]) => events.length >= 3)
    .map(([, events]) => {
      const durations = events
        .map((e) => e.durationMin)
        .filter(Boolean);
      return {
        title: events[0].title,
        count: events.length,
        frequency: `${(events.length / totalWeeks).toFixed(1)}/week`,
        avgDurationMin: durations.length
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : null,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Time allocation
  const categories = {
    groupMeetings: { count: 0, totalMin: 0 },
    oneOnOnes: { count: 0, totalMin: 0 },
    focusTime: { count: 0, totalMin: 0 },
    ooo: { count: 0, totalMin: 0 },
    allDay: { count: 0, totalMin: 0 },
    solo: { count: 0, totalMin: 0 },
  };

  for (const e of compressed) {
    const dur = e.durationMin || 0;
    const titleLower = e.title.toLowerCase();
    const isOOO =
      titleLower.includes("ooo") ||
      titleLower.includes("out of office") ||
      titleLower.includes("vacation") ||
      titleLower.includes("pto");

    if (e.allDay) {
      if (isOOO) {
        categories.ooo.count++;
      } else {
        categories.allDay.count++;
      }
    } else if (isOOO) {
      categories.ooo.count++;
      categories.ooo.totalMin += dur;
    } else if (
      titleLower.includes("focus") ||
      titleLower.includes("block") ||
      titleLower.includes("no meetings")
    ) {
      categories.focusTime.count++;
      categories.focusTime.totalMin += dur;
    } else if ((e.attendees?.length || 0) >= 2) {
      categories.groupMeetings.count++;
      categories.groupMeetings.totalMin += dur;
    } else if ((e.attendees?.length || 0) === 1) {
      categories.oneOnOnes.count++;
      categories.oneOnOnes.totalMin += dur;
    } else {
      categories.solo.count++;
      categories.solo.totalMin += dur;
    }
  }

  const timeAllocation = Object.fromEntries(
    Object.entries(categories).map(([key, { count, totalMin }]) => [
      key,
      { count, totalHours: +(totalMin / 60).toFixed(1) },
    ]),
  );

  // Day stats
  const dayMap = new Map();
  for (const e of compressed) {
    if (e.date) {
      dayMap.set(e.date, (dayMap.get(e.date) || 0) + 1);
    }
  }
  const dayCounts = [...dayMap.entries()].sort((a, b) => b[1] - a[1]);
  const busiestDay = dayCounts[0] || null;
  const quietestDay = dayCounts[dayCounts.length - 1] || null;

  // Weekly baseline from recurring events
  const baseline = computeBaseline(recurring, compressed);

  return {
    topPeople,
    recurring,
    timeAllocation,
    dayStats: {
      busiestDay: busiestDay
        ? { date: busiestDay[0], events: busiestDay[1] }
        : null,
      quietestDay: quietestDay
        ? { date: quietestDay[0], events: quietestDay[1] }
        : null,
      avgEventsPerDay: +(compressed.length / totalDays).toFixed(1),
    },
    baseline,
  };
}

function computeBaseline(recurring, compressed) {
  const weekday = [];
  const weekend = [];

  for (const r of recurring) {
    // Figure out if this event typically falls on weekday or weekend
    const matchingEvents = compressed.filter(
      (e) => e.title.toLowerCase().trim() === r.title.toLowerCase().trim(),
    );
    const weekdayCount = matchingEvents.filter((e) => {
      const day = new Date(e.date).getDay();
      return day >= 1 && day <= 5;
    }).length;
    const weekendCount = matchingEvents.length - weekdayCount;

    let freq;
    const perWeek = parseFloat(r.frequency);
    if (perWeek >= 4) freq = "daily";
    else if (perWeek >= 1.5) freq = "multiple times/week";
    else if (perWeek >= 0.8) freq = "weekly";
    else freq = "periodic";

    const entry = { title: r.title, frequency: freq, count: r.count };

    if (weekendCount > weekdayCount) {
      weekend.push(entry);
    } else {
      weekday.push(entry);
    }
  }

  return { weekday, weekend };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return d.toISOString().slice(0, 10);
}

function getMonthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getQuarterKey(date) {
  const d = new Date(date);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

function formatWeekOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function shortDateLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function shortMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-");
  const d = new Date(parseInt(year), parseInt(month) - 1);
  return d.toLocaleDateString("en-US", { month: "long" });
}

function formatMonthLabel(key) {
  const [year, month] = key.split("-");
  const d = new Date(parseInt(year), parseInt(month) - 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatQuarterLabel(key) {
  const [year, q] = key.split("-Q");
  return `Q${q} ${year}`;
}

function splitWeekdayWeekend(events) {
  const weekday = [];
  const weekend = [];
  for (const e of events) {
    const day = new Date(e.date).getDay();
    if (day === 0 || day === 6) {
      weekend.push(e);
    } else {
      weekday.push(e);
    }
  }
  return { weekday, weekend };
}

function groupByWeek(events) {
  const weeks = new Map();
  for (const e of events) {
    const key = getWeekStart(e.date);
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(e);
  }
  return new Map([...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function groupByMonth(weekSummaries) {
  const months = new Map();
  for (const ws of weekSummaries) {
    const key = getMonthKey(ws.weekOf);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(ws);
  }
  return new Map([...months.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function groupByQuarter(monthSummaries) {
  const quarters = new Map();
  for (const ms of monthSummaries) {
    const key = getQuarterKey(ms.monthOf + "-01");
    if (!quarters.has(key)) quarters.set(key, []);
    quarters.get(key).push(ms);
  }
  return new Map([...quarters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function determinePeriod(startDate, endDate) {
  const days = Math.ceil(
    (new Date(endDate) - new Date(startDate)) / 86400000,
  );
  if (days <= 10) return "week";
  if (days <= 35) return "month";
  if (days <= 100) return "quarter";
  return "year";
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const weekSummarySchema = z.object({
  weekOf: z.string().describe("Start date of the week, e.g. 2025-10-06"),
  routine: z
    .string()
    .describe("1-2 sentences noting what the regular week looked like"),
  weekdays: z
    .string()
    .describe("1-2 paragraphs: the workweek journal content"),
  weekend: z
    .string()
    .nullable()
    .describe("0-1 paragraphs: weekend (null if no weekend events)"),
  keyMoments: z
    .array(z.string())
    .describe("2-5 short bullet points of notable moments"),
  notablePeople: z
    .array(z.string())
    .describe("People beyond the usual recurring cast"),
  travel: z
    .string()
    .nullable()
    .describe("Trip summary if any travel this week, otherwise null"),
});

const monthSummarySchema = z.object({
  monthOf: z.string().describe("Month key, e.g. 2025-10"),
  summary: z
    .string()
    .describe("2-3 paragraphs: overall shape of the month"),
  keyMoments: z
    .array(z.string())
    .describe("3-7 key milestones or notable events"),
  shifts: z
    .string()
    .nullable()
    .describe("What changed compared to the usual patterns, or null"),
});

const quarterSummarySchema = z.object({
  quarterOf: z.string().describe("Quarter key, e.g. 2025-Q4"),
  summary: z
    .string()
    .describe("2-3 paragraphs: the big themes and arcs of the quarter"),
  keyMoments: z
    .array(z.string())
    .describe("5-10 defining moments of the quarter"),
  shifts: z
    .string()
    .nullable()
    .describe("Major shifts or turning points, or null"),
});

// ── Prompts ─────────────────────────────────────────────────────────────────

const JOURNAL_TONE = `Write in first person past tense throughout ("Had a packed Monday.", "Got Grace to her lesson.").
Be specific and factual — names, places, durations.
Don't dramatize. "Heavy day" is fine. "A crucible of impossible demands" is not.
Never be congratulatory or impressed. Everyone has busy calendars — a full schedule is normal, not remarkable. Don't praise, marvel at, or highlight how much was going on. No "juggling", "balancing act", "wore many hats", "managed to", or similar language that frames ordinary scheduling as an achievement.
Routine can be mentioned briefly ("the usual 1:1 cadence continued") then move on.
Give notable events proportional attention — a conference talk gets a full sentence, a routine standup gets nothing.
Brevity is a virtue. A quiet week can be 2 sentences. Not everything needs equal airtime.
OK to note patterns ("third trip in three weeks", "Qin meetings becoming more frequent") but don't moralize.
Connect related events when insightful ("the Gartner prep calls all week paid off at the conference").
Vary your language — don't lean on any single word or phrase repeatedly across entries.`;

function weekSystemPrompt(baseline) {
  const weekdayBaseline = baseline.weekday
    .slice(0, 10)
    .map((b) => `${b.title} (${b.frequency})`)
    .join(", ");
  const weekendBaseline = baseline.weekend
    .slice(0, 5)
    .map((b) => `${b.title} (${b.frequency})`)
    .join(", ");

  return `You are writing a brief journal entry for one week of someone's life, based on their calendar events.

WEEKLY BASELINE (the recurring stuff — don't dwell on it):
Weekday regulars: ${weekdayBaseline || "none identified"}
Weekend regulars: ${weekendBaseline || "none identified"}

Acknowledge the regular cadence briefly (one sentence max), then spend your words on what was different or notable.
Weekdays and weekends typically have different character. Reflect this naturally — don't force equal coverage, but note the shift in pace or focus when it's meaningful.

${JOURNAL_TONE}`;
}

const MONTH_SYSTEM_PROMPT = `You are combining weekly journal entries into a monthly summary.

Focus on:
- What was the overall shape and feel of the month?
- Key milestones, trips, or events
- Any changes in the "cast of characters" or work patterns
- What shifted compared to previous weeks?

${JOURNAL_TONE}`;

const QUARTER_SYSTEM_PROMPT = `You are combining monthly summaries into a quarterly overview.

Focus on the big arcs:
- What were the dominant themes of this quarter?
- What shifted or changed over the 3 months?
- Key milestones and turning points
- Changes in people, projects, or priorities

${JOURNAL_TONE}`;

// ── Stage 3: Week-level summaries ───────────────────────────────────────────

function buildWeekPrompt(weekOf, events, baseline) {
  const { weekday, weekend } = splitWeekdayWeekend(events);

  let prompt = `Journal entry for the week of ${formatWeekOf(weekOf)}:\n\n`;

  if (weekday.length > 0) {
    prompt += `WEEKDAY EVENTS (Mon-Fri):\n${JSON.stringify(weekday, null, 2)}\n\n`;
  } else {
    prompt += `WEEKDAY EVENTS (Mon-Fri):\nNo weekday events.\n\n`;
  }

  if (weekend.length > 0) {
    prompt += `WEEKEND EVENTS (Sat-Sun):\n${JSON.stringify(weekend, null, 2)}\n\n`;
  } else {
    prompt += `WEEKEND EVENTS (Sat-Sun):\nNo weekend events.\n\n`;
  }

  prompt += `Write a brief journal entry for this week. Set weekOf to "${weekOf}".`;

  return prompt;
}

async function summarizeWeek(weekOf, events, baseline, mapModel, onEvent) {
  onEvent?.({ type: "week:start", key: weekOf });
  const prompt = buildWeekPrompt(weekOf, events, baseline);
  const result = await retryWithJitter(() =>
    generateStructured(prompt, weekSummarySchema, {
      system: weekSystemPrompt(baseline),
      maxTokens: 2048,
      model: mapModel,
    }),
  );
  onEvent?.({ type: "week:done", key: weekOf });
  return result;
}

async function summarizeWeeksParallel(weekMap, baseline, mapModel, onEvent) {
  const entries = [...weekMap.entries()];

  onEvent?.({
    type: "weeks:init",
    weeks: entries.map(([key]) => ({ key, label: shortDateLabel(key) })),
  });

  const results = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(([weekOf, events]) =>
        summarizeWeek(weekOf, events, baseline, mapModel, onEvent),
      ),
    );
    results.push(...batchResults);
    // Brief pause between batches to avoid hitting concurrent connection limits
    if (i + BATCH_SIZE < entries.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return results;
}

// ── Stage 4: Month-level summaries ──────────────────────────────────────────

function buildMonthPrompt(monthKey, weekSummaries) {
  const weekEntries = weekSummaries
    .map((ws) => {
      let entry = `### Week of ${formatWeekOf(ws.weekOf)}\n`;
      entry += `Routine: ${ws.routine}\n`;
      entry += `Weekdays: ${ws.weekdays}\n`;
      if (ws.weekend) entry += `Weekend: ${ws.weekend}\n`;
      entry += `Key moments: ${ws.keyMoments.join("; ")}\n`;
      if (ws.travel) entry += `Travel: ${ws.travel}\n`;
      if (ws.notablePeople.length) entry += `Notable people: ${ws.notablePeople.join(", ")}\n`;
      return entry;
    })
    .join("\n");

  return `Weekly journal entries for ${formatMonthLabel(monthKey)}:\n\n${weekEntries}\n\nCombine these weekly entries into a monthly journal summary. Set monthOf to "${monthKey}".`;
}

async function summarizeMonth(monthKey, weekSummaries, mapModel, onEvent) {
  onEvent?.({ type: "month:start", key: monthKey });
  const prompt = buildMonthPrompt(monthKey, weekSummaries);
  const result = await retryWithJitter(() =>
    generateStructured(prompt, monthSummarySchema, {
      system: MONTH_SYSTEM_PROMPT,
      maxTokens: 2048,
      model: mapModel,
    }),
  );
  onEvent?.({ type: "month:done", key: monthKey });
  return result;
}

// ── Stage 5: Quarter-level summaries ────────────────────────────────────────

function buildQuarterPrompt(quarterKey, monthSummaries) {
  const monthEntries = monthSummaries
    .map((ms) => {
      let entry = `## ${formatMonthLabel(ms.monthOf)}\n`;
      entry += `${ms.summary}\n`;
      entry += `Key moments: ${ms.keyMoments.join("; ")}\n`;
      if (ms.shifts) entry += `Shifts: ${ms.shifts}\n`;
      return entry;
    })
    .join("\n");

  return `Monthly summaries for ${formatQuarterLabel(quarterKey)}:\n\n${monthEntries}\n\nCombine these into a quarterly overview. Set quarterOf to "${quarterKey}".`;
}

async function summarizeQuarter(quarterKey, monthSummaries, mapModel, onEvent) {
  onEvent?.({ type: "quarter:start", key: quarterKey });
  const prompt = buildQuarterPrompt(quarterKey, monthSummaries);
  const result = await retryWithJitter(() =>
    generateStructured(prompt, quarterSummarySchema, {
      system: QUARTER_SYSTEM_PROMPT,
      maxTokens: 2048,
      model: mapModel,
    }),
  );
  onEvent?.({ type: "quarter:done", key: quarterKey });
  return result;
}

// ── Stage 6: Final narrative (streamed) ─────────────────────────────────────

function buildFinalPrompt(period, data) {
  if (period === "week") {
    return buildWeekFinalPrompt(data);
  } else if (period === "month") {
    return buildMonthFinalPrompt(data);
  } else if (period === "quarter") {
    return buildQuarterFinalPrompt(data);
  } else {
    return buildYearFinalPrompt(data);
  }
}

function buildWeekFinalPrompt({ weekSummaries, analytics }) {
  const ws = weekSummaries[0];
  const system = `You are writing a journal entry for one week. Output structured markdown.

${JOURNAL_TONE}`;

  const prompt = `Week summary:
Routine: ${ws.routine}
Weekdays: ${ws.weekdays}
Weekend: ${ws.weekend || "No weekend events."}
Key moments: ${ws.keyMoments.join("; ")}
Notable people: ${ws.notablePeople.join(", ") || "none"}
Travel: ${ws.travel || "none"}

${formatAnalyticsBlock(analytics)}

Write a journal entry for this week as structured markdown with a heading "# Week of ${formatWeekOf(ws.weekOf)}". Include the weekday narrative and weekend narrative naturally. Weave in relevant analytics where they add insight.`;

  return { system, prompt };
}

function buildMonthFinalPrompt({ weekSummaries, monthSummaries, analytics }) {
  const ms = monthSummaries[0];
  const system = `You are writing a structured monthly journal. Output markdown with a month-level overview followed by individual week entries.

${JOURNAL_TONE}`;

  const weekEntries = weekSummaries
    .map((ws) => {
      let entry = `Week of ${formatWeekOf(ws.weekOf)}:\n`;
      entry += `Routine: ${ws.routine}\n`;
      entry += `Weekdays: ${ws.weekdays}\n`;
      if (ws.weekend) entry += `Weekend: ${ws.weekend}\n`;
      entry += `Key moments: ${ws.keyMoments.join("; ")}`;
      if (ws.travel) entry += `\nTravel: ${ws.travel}`;
      return entry;
    })
    .join("\n\n");

  const prompt = `Monthly overview: ${ms.summary}
Key moments: ${ms.keyMoments.join("; ")}
Shifts: ${ms.shifts || "none"}

Week-level details:
${weekEntries}

${formatAnalyticsBlock(analytics)}

Write a structured journal for ${formatMonthLabel(ms.monthOf)}.

Format:
# ${formatMonthLabel(ms.monthOf)}
[1-2 paragraph monthly overview — the big themes and takeaways]

## Week of [date]
[Week-level journal entry for each week]

Weave analytics naturally into the overview where they add insight.`;

  return { system, prompt };
}

function buildQuarterFinalPrompt({ weekSummaries, monthSummaries, quarterSummaries, analytics }) {
  const qs = quarterSummaries[0];
  const system = `You are writing a structured quarterly journal. Output markdown with a quarter overview, monthly sections, and week entries within each month.

${JOURNAL_TONE}`;

  // Group weeks by month for structured output
  const monthMap = groupByMonth(weekSummaries);

  let monthSections = "";
  for (const ms of monthSummaries) {
    const weeks = monthMap.get(ms.monthOf) || [];
    monthSections += `\n### ${formatMonthLabel(ms.monthOf)}\nMonthly summary: ${ms.summary}\nShifts: ${ms.shifts || "none"}\n`;
    for (const ws of weeks) {
      monthSections += `\nWeek of ${formatWeekOf(ws.weekOf)}: ${ws.routine} ${ws.weekdays}`;
      if (ws.weekend) monthSections += ` ${ws.weekend}`;
      monthSections += `\nKey moments: ${ws.keyMoments.join("; ")}`;
      if (ws.travel) monthSections += `\nTravel: ${ws.travel}`;
      monthSections += "\n";
    }
  }

  const prompt = `Quarterly overview: ${qs.summary}
Key moments: ${qs.keyMoments.join("; ")}
Shifts: ${qs.shifts || "none"}

Month and week details:
${monthSections}

${formatAnalyticsBlock(analytics)}

Write a structured journal for ${formatQuarterLabel(qs.quarterOf)}.

Format:
# ${formatQuarterLabel(qs.quarterOf)}
[2-3 paragraph quarterly overview — the big themes, arcs, and takeaways]

## ${formatMonthLabel(monthSummaries[0]?.monthOf || "")}
[1-2 paragraph monthly summary]

### Week of [date]
[Week-level journal entry]

(Repeat for each month and week.)

Weave analytics naturally into the overview.`;

  return { system, prompt };
}

function buildYearFinalPrompt({ weekSummaries, monthSummaries, quarterSummaries, analytics }) {
  const system = `You are writing a structured yearly journal. Output markdown with a year overview, quarterly sections, monthly subsections, and week entries.

${JOURNAL_TONE}`;

  let quarterSections = "";
  const monthMap = groupByMonth(weekSummaries);
  const qMonthMap = groupByQuarter(monthSummaries);

  for (const qs of quarterSummaries) {
    quarterSections += `\n## ${formatQuarterLabel(qs.quarterOf)}\nSummary: ${qs.summary}\n`;
    const months = qMonthMap.get(qs.quarterOf) || [];
    for (const ms of months) {
      quarterSections += `\n### ${formatMonthLabel(ms.monthOf)}\n${ms.summary}\n`;
      const weeks = monthMap.get(ms.monthOf) || [];
      for (const ws of weeks) {
        quarterSections += `Week of ${formatWeekOf(ws.weekOf)}: ${ws.weekdays}`;
        if (ws.weekend) quarterSections += ` ${ws.weekend}`;
        quarterSections += "\n";
      }
    }
  }

  const year = quarterSummaries[0]?.quarterOf?.split("-")[0] || "the year";

  const prompt = `Yearly data:
${quarterSections}

${formatAnalyticsBlock(analytics)}

Write a structured journal for ${year}.

Format:
# ${year}
[2-3 paragraph yearly overview — the defining themes and arcs]

## Q1 / Q2 / etc.
[1-2 paragraph quarterly summary]

### Month Name
[1-2 paragraph monthly summary]

#### Week of [date]
[Brief week-level entry]

Weave analytics naturally into the year overview. Be selective — a year journal should surface only the most significant moments from each week.`;

  return { system, prompt };
}

function formatAnalyticsBlock(analytics) {
  return `Analytics:
Top people by meeting frequency:
${analytics.topPeople.slice(0, 10).map((p) => `- ${p.name}: ${p.count} times (${p.perWeek}/week)`).join("\n")}

Recurring events:
${analytics.recurring.slice(0, 10).map((r) => `- ${r.title}: ${r.count} times (${r.frequency})`).join("\n")}

Time allocation:
${Object.entries(analytics.timeAllocation).map(([k, v]) => `- ${k}: ${v.count} events, ${v.totalHours} hours`).join("\n")}

Day stats:
- Busiest day: ${analytics.dayStats.busiestDay?.date} (${analytics.dayStats.busiestDay?.events} events)
- Quietest day: ${analytics.dayStats.quietestDay?.date} (${analytics.dayStats.quietestDay?.events} events)
- Average: ${analytics.dayStats.avgEventsPerDay} events/day`;
}

// ── Output saving ───────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function saveOutputs(
  outputDir,
  { narrative, analytics, weekSummaries, monthSummaries, quarterSummaries, compressedEvents },
) {
  await mkdir(outputDir, { recursive: true });
  const files = [
    writeFile(join(outputDir, "narrative.md"), narrative),
    writeFile(
      join(outputDir, "analytics.json"),
      JSON.stringify(analytics, null, 2),
    ),
    writeFile(
      join(outputDir, "week-summaries.json"),
      JSON.stringify(weekSummaries, null, 2),
    ),
    writeFile(
      join(outputDir, "compressed-events.json"),
      JSON.stringify(compressedEvents, null, 2),
    ),
  ];
  if (monthSummaries?.length) {
    files.push(
      writeFile(
        join(outputDir, "month-summaries.json"),
        JSON.stringify(monthSummaries, null, 2),
      ),
    );
  }
  if (quarterSummaries?.length) {
    files.push(
      writeFile(
        join(outputDir, "quarter-summaries.json"),
        JSON.stringify(quarterSummaries, null, 2),
      ),
    );
  }
  await Promise.all(files);
}

// ── Main export ─────────────────────────────────────────────────────────────

export async function summarize(
  events,
  { startDate, endDate, label, quality = "standard", userEmails = [], onEvent },
) {
  const mapModel =
    quality === "premium" ? MODELS.sonnet : MODELS.haiku;
  const reduceModel =
    quality === "premium" ? MODELS.opus : MODELS.sonnet;

  const period = determinePeriod(startDate, endDate);

  // Stage 1: Compress
  onEvent?.({ type: "compress:start" });
  const compressed = compressEvents(events, userEmails);
  onEvent?.({ type: "compress:done", count: compressed.length });

  // Stage 2: Analytics + baseline
  onEvent?.({ type: "analytics:start" });
  const analytics = computeAnalytics(compressed, startDate, endDate, userEmails);
  onEvent?.({ type: "analytics:done" });

  // Stage 3: Week-level summaries (always built from weeks up)
  const weekMap = groupByWeek(compressed);
  const weekSummaries = await summarizeWeeksParallel(
    weekMap,
    analytics.baseline,
    mapModel,
    onEvent,
  );

  let monthSummaries = [];
  let quarterSummaries = [];

  // Stage 4: Month-level summaries (if month+ period) — parallelized
  if (period === "month" || period === "quarter" || period === "year") {
    const monthGroups = groupByMonth(weekSummaries);
    const monthEntries = [...monthGroups.entries()];
    onEvent?.({
      type: "months:init",
      months: monthEntries.map(([key]) => ({ key, label: shortMonthLabel(key) })),
    });
    monthSummaries = await Promise.all(
      monthEntries.map(([monthKey, weeks]) =>
        summarizeMonth(monthKey, weeks, mapModel, onEvent),
      ),
    );
  }

  // Stage 5: Quarter-level summaries (if quarter+ period) — parallelized
  if (period === "quarter" || period === "year") {
    const quarterGroups = groupByQuarter(monthSummaries);
    const quarterEntries = [...quarterGroups.entries()];
    onEvent?.({
      type: "quarters:init",
      quarters: quarterEntries.map(([key]) => ({ key, label: formatQuarterLabel(key) })),
    });
    quarterSummaries = await Promise.all(
      quarterEntries.map(([quarterKey, months]) =>
        summarizeQuarter(quarterKey, months, mapModel, onEvent),
      ),
    );
  }

  // Stage 6: Final narrative
  onEvent?.({ type: "narrative:start" });
  const { system, prompt } = buildFinalPrompt(period, {
    weekSummaries,
    monthSummaries,
    quarterSummaries,
    analytics,
  });

  const narrative = await retryWithJitter(() =>
    generate(prompt, {
      system,
      maxTokens: period === "year" ? 8192 : 4096,
      model: reduceModel,
    }),
  );
  onEvent?.({ type: "narrative:done", text: narrative });

  // Save outputs
  onEvent?.({ type: "save:start" });
  const startStr = new Date(startDate).toISOString().slice(0, 10);
  const endStr = new Date(endDate).toISOString().slice(0, 10);
  const outputDir = join(
    process.cwd(),
    "output",
    `${startStr}_${endStr}_${slugify(label)}`,
  );

  await saveOutputs(outputDir, {
    narrative,
    analytics,
    weekSummaries,
    monthSummaries,
    quarterSummaries,
    compressedEvents: compressed,
  });
  onEvent?.({ type: "save:done", outputDir });

  return { narrative, analytics, weekSummaries, monthSummaries, quarterSummaries, outputDir };
}
