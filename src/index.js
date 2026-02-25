import { input, select, checkbox } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { authorizeAll, addAccount, removeAccount } from "./auth.js";
import { listCalendars, listEvents } from "./calendar.js";
import { displayEvents } from "./display.js";
import { summarize } from "./summarize.js";
import { PipelineUI } from "./ui.js";

// --- Date helpers ---

function startOfDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfDay(d) {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

function startOfWeek(d) {
  const r = new Date(d);
  r.setDate(r.getDate() - r.getDay()); // Sunday
  return startOfDay(r);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

function startOfQuarter(d) {
  const q = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), q, 1);
}

function endOfQuarter(d) {
  const q = Math.floor(d.getMonth() / 3) * 3;
  return endOfDay(new Date(d.getFullYear(), q + 3, 0));
}

// --- Date range builders ---

const DATE_RANGES = {
  // Present
  today: () => ({
    start: startOfDay(new Date()),
    end: endOfDay(new Date()),
    label: "Today",
  }),
  tomorrow: () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return { start: startOfDay(d), end: endOfDay(d), label: "Tomorrow" };
  },

  // Future
  thisWeek: () => {
    const now = new Date();
    return { start: startOfDay(now), end: endOfDay(new Date(startOfWeek(now).getTime() + 6 * 86400000)), label: "This week" };
  },
  nextWeek: () => {
    const now = new Date();
    const nextSun = new Date(startOfWeek(now));
    nextSun.setDate(nextSun.getDate() + 7);
    const nextSat = new Date(nextSun);
    nextSat.setDate(nextSat.getDate() + 6);
    return { start: startOfDay(nextSun), end: endOfDay(nextSat), label: "Next week" };
  },
  next7Days: () => {
    const end = new Date();
    end.setDate(end.getDate() + 7);
    return { start: new Date(), end, label: "Next 7 days" };
  },
  next30Days: () => {
    const end = new Date();
    end.setDate(end.getDate() + 30);
    return { start: new Date(), end, label: "Next 30 days" };
  },

  // Past presets
  lastWeek: () => {
    const now = new Date();
    const thisSun = startOfWeek(now);
    const prevSun = new Date(thisSun);
    prevSun.setDate(prevSun.getDate() - 7);
    const prevSat = new Date(prevSun);
    prevSat.setDate(prevSat.getDate() + 6);
    return { start: startOfDay(prevSun), end: endOfDay(prevSat), label: "Last week" };
  },
  lastMonth: () => {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { start: startOfMonth(prev), end: endOfMonth(prev), label: "Last month" };
  },
  lastQuarter: () => {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    return { start: startOfQuarter(prev), end: endOfQuarter(prev), label: "Last quarter" };
  },

  // Custom past
  lastNWeeks: (n) => {
    const end = endOfDay(new Date());
    const start = new Date();
    start.setDate(start.getDate() - n * 7);
    return { start: startOfDay(start), end, label: `Last ${n} week(s)` };
  },
  lastNMonths: (n) => {
    const end = endOfDay(new Date());
    const start = new Date();
    start.setMonth(start.getMonth() - n);
    return { start: startOfDay(start), end, label: `Last ${n} month(s)` };
  },
  lastNQuarters: (n) => {
    const end = endOfDay(new Date());
    const start = new Date();
    start.setMonth(start.getMonth() - n * 3);
    return { start: startOfDay(start), end, label: `Last ${n} quarter(s)` };
  },
};

async function promptDateRange() {
  const rangeKey = await select({
    message: "Select a date range:",
    choices: [
      { name: chalk.dim("── Present ──"), value: null, disabled: "" },
      { name: "Today", value: "today" },
      { name: "Tomorrow", value: "tomorrow" },

      { name: chalk.dim("── Future ──"), value: null, disabled: "" },
      { name: "This week", value: "thisWeek" },
      { name: "Next week", value: "nextWeek" },
      { name: "Next 7 days", value: "next7Days" },
      { name: "Next 30 days", value: "next30Days" },

      { name: chalk.dim("── Past ──"), value: null, disabled: "" },
      { name: "Last week", value: "lastWeek" },
      { name: "Last month", value: "lastMonth" },
      { name: "Last quarter", value: "lastQuarter" },

      { name: chalk.dim("── Custom past ──"), value: null, disabled: "" },
      { name: "Last N weeks...", value: "lastNWeeks" },
      { name: "Last N months...", value: "lastNMonths" },
      { name: "Last N quarters...", value: "lastNQuarters" },
    ],
  });

  if (rangeKey.startsWith("lastN")) {
    const unit = { lastNWeeks: "weeks", lastNMonths: "months", lastNQuarters: "quarters" }[rangeKey];
    const n = await input({
      message: `How many ${unit}?`,
      validate: (v) => {
        const num = parseInt(v, 10);
        return num > 0 ? true : "Enter a positive number";
      },
    });
    return DATE_RANGES[rangeKey](parseInt(n, 10));
  }

  return DATE_RANGES[rangeKey]();
}

async function main() {
  console.log(chalk.bold.blue("\n  📅  Calendar Summarizer\n"));

  // --- Authenticate all saved accounts ---
  const spinner = ora("Loading saved accounts...").start();
  let accounts = await authorizeAll();

  if (accounts.length > 0) {
    spinner.succeed(
      `Signed in to ${accounts.length} account(s): ${accounts.map((a) => a.email).join(", ")}`,
    );
  } else {
    spinner.info("No accounts configured yet");
  }

  // --- Account management loop ---
  let done = false;
  while (!done) {
    const accountChoices = [
      { name: chalk.green("+ Add a Google account"), value: "add" },
    ];

    if (accounts.length > 0) {
      accountChoices.unshift({
        name: `Continue with ${accounts.length} account(s)`,
        value: "continue",
      });
      accountChoices.push({
        name: chalk.red("- Remove an account"),
        value: "remove",
      });
    }

    const action = accounts.length === 0
      ? "add"
      : await select({ message: "Account setup:", choices: accountChoices });

    if (action === "continue") {
      done = true;
    } else if (action === "add") {
      const email = await input({
        message: "Google account email:",
        validate: (v) => (v.includes("@") ? true : "Enter a valid email address"),
      });
      spinner.start(`Opening browser to sign in as ${email}...`);
      try {
        const newAccount = await addAccount(email);
        accounts.push(newAccount);
        spinner.succeed(`Added ${newAccount.email}`);
      } catch (err) {
        spinner.fail(`Authentication failed: ${err.message}`);
      }
    } else if (action === "remove") {
      const emailToRemove = await select({
        message: "Which account to remove?",
        choices: accounts.map((a) => ({ name: a.email, value: a.email })),
      });
      await removeAccount(emailToRemove);
      accounts = accounts.filter((a) => a.email !== emailToRemove);
      console.log(chalk.yellow(`  Removed ${emailToRemove}`));
    }
  }

  // --- Fetch calendars from all accounts ---
  spinner.start("Fetching calendars from all accounts...");
  const allCalendars = [];
  for (const { client, email } of accounts) {
    const cals = await listCalendars(client, email);
    allCalendars.push(...cals);
  }
  spinner.succeed(`Found ${allCalendars.length} calendar(s) across ${accounts.length} account(s)`);

  // --- Select calendars (grouped by account) ---
  const choices = [];
  const accountEmails = [...new Set(allCalendars.map((c) => c._accountEmail))];

  for (const email of accountEmails) {
    if (accountEmails.length > 1) {
      choices.push({ name: chalk.dim.bold(`── ${email} ──`), value: null, disabled: "" });
    }
    const cals = allCalendars.filter((c) => c._accountEmail === email);
    for (const cal of cals) {
      choices.push({
        name: `${cal.summary}${cal.primary ? chalk.dim(" (primary)") : ""}`,
        value: cal.id + "||" + email,
        checked: cal.primary || false,
      });
    }
  }

  const selected = await checkbox({
    message: "Which calendars do you want to query?",
    choices: choices.filter((c) => c.value !== null),
  });

  if (selected.length === 0) {
    console.log(chalk.yellow("\n  No calendars selected. Exiting.\n"));
    process.exit(0);
  }

  // Build a lookup: calendarId -> auth client
  const calAuthMap = new Map();
  for (const cal of allCalendars) {
    calAuthMap.set(cal.id + "||" + cal._accountEmail, cal._auth);
  }

  // --- Select date range ---
  const range = await promptDateRange();

  // --- Fetch events ---
  spinner.start(`Fetching events for ${range.label}...`);
  const allEvents = [];

  for (const key of selected) {
    const calendarId = key.split("||")[0];
    const auth = calAuthMap.get(key);
    const events = await listEvents(auth, {
      calendarId,
      timeMin: range.start,
      timeMax: range.end,
    });
    allEvents.push(...events);
  }

  // Sort all events chronologically
  allEvents.sort((a, b) => {
    const aTime = new Date(a.start.dateTime || a.start.date);
    const bTime = new Date(b.start.dateTime || b.start.date);
    return aTime - bTime;
  });

  spinner.succeed(`Fetched ${allEvents.length} event(s)`);

  // --- Filter events ---
  const filterMode = await select({
    message: "Filter events?",
    choices: [
      { name: "No filter", value: "none" },
      { name: "Include only matching", value: "include" },
      { name: "Exclude matching", value: "exclude" },
    ],
  });

  let filtered = allEvents;
  if (filterMode !== "none") {
    const pattern = await input({
      message: `Filter pattern (regex):`,
      validate: (v) => {
        if (!v.trim()) return "Enter a pattern";
        try { new RegExp(v, "i"); return true; } catch { return "Invalid regex"; }
      },
    });
    const re = new RegExp(pattern, "i");
    const matches = (event) => {
      const title = event.summary || "";
      const desc = event.description || "";
      return re.test(title) || re.test(desc);
    };

    if (filterMode === "include") {
      filtered = allEvents.filter(matches);
    } else {
      filtered = allEvents.filter((e) => !matches(e));
    }

    console.log(chalk.dim(`  Filtered: ${allEvents.length} → ${filtered.length} event(s)`));
  }

  // --- Display ---
  displayEvents(filtered);

  // --- Reverse Journal ---
  const wantSummary = await select({
    message: "Generate a reverse journal summary?",
    choices: [
      { name: "Yes", value: true },
      { name: "No", value: false },
    ],
  });

  if (wantSummary) {
    const envQuality = process.env.SUMMARY_QUALITY === "premium" ? "premium" : "standard";
    const quality = await select({
      message: "Quality tier:",
      default: envQuality,
      choices: [
        { name: "Standard (Haiku + Sonnet)", value: "standard" },
        { name: "Premium (Sonnet + Opus)", value: "premium" },
      ],
    });

    spinner.stop();
    const userEmails = accounts.map((a) => a.email);
    const ui = new PipelineUI();
    ui.start();

    try {
      const result = await summarize(filtered, {
        startDate: range.start,
        endDate: range.end,
        label: range.label,
        quality,
        userEmails,
        onEvent: (event) => ui.handleEvent(event),
      });

      console.log("\n");
      spinner.succeed(`Saved to ${result.outputDir}`);
    } finally {
      ui.stop();
    }
  }
}

main().catch((err) => {
  console.error(chalk.red(`\n  Error: ${err.message}\n`));
  process.exit(1);
});
