import chalk from "chalk";

/**
 * Format and print events grouped by day as styled markdown.
 */
export function displayEvents(events) {
  if (events.length === 0) {
    console.log(chalk.yellow("\nNo events found for the selected period.\n"));
    return;
  }

  console.log(chalk.bold(`\nFound ${events.length} event(s):\n`));

  const grouped = groupByDay(events);

  for (const [day, dayEvents] of Object.entries(grouped)) {
    console.log(chalk.cyan.bold(`## ${day}`));
    console.log();

    for (const event of dayEvents) {
      printEvent(event);
    }
  }
}

function printEvent(event) {
  const title = event.summary || "(No title)";
  const time = formatTime(event);
  const type = formatEventType(event.eventType);
  const status = formatStatus(event.status);

  // Title line
  const badges = [type, status].filter(Boolean).join(" ");
  console.log(chalk.bold(`### ${title}`) + (badges ? `  ${badges}` : ""));

  // Time
  console.log(`- **When:** ${time}`);

  // Location
  if (event.location) {
    console.log(`- **Location:** ${event.location}`);
  }

  // Organizer
  if (event.organizer && !event.organizer.self) {
    const name = event.organizer.displayName || event.organizer.email;
    console.log(`- **Organizer:** ${name}`);
  }

  // Visibility / busy status
  const meta = [];
  if (event.visibility && event.visibility !== "default") {
    meta.push(event.visibility);
  }
  if (event.transparency === "transparent") {
    meta.push("free");
  }
  if (meta.length > 0) {
    console.log(`- **Visibility:** ${meta.join(", ")}`);
  }

  // Conference / meeting link
  const meetLink = getMeetLink(event);
  if (meetLink) {
    console.log(`- **Meet:** ${meetLink}`);
  }

  // Attendees
  if (event.attendees && event.attendees.length > 0) {
    printAttendees(event.attendees);
  }

  // Description (truncated)
  if (event.description) {
    const plain = stripHtml(event.description).trim();
    if (plain) {
      const truncated = plain.length > 2000 ? plain.slice(0, 2000) + "..." : plain;
      console.log(`- **Description:** ${truncated}`);
    }
  }

  // Attachments
  if (event.attachments && event.attachments.length > 0) {
    const names = event.attachments.map((a) => a.title || a.fileUrl).join(", ");
    console.log(`- **Attachments:** ${names}`);
  }

  console.log();
}

function printAttendees(attendees) {
  // Separate people from rooms/resources
  const people = attendees.filter((a) => !a.resource);
  const rooms = attendees.filter((a) => a.resource);

  if (people.length > 0) {
    const rsvpGroups = {
      accepted: [],
      declined: [],
      tentative: [],
      needsAction: [],
    };

    for (const a of people) {
      const name = a.displayName || a.email;
      const group = rsvpGroups[a.responseStatus] || rsvpGroups.needsAction;
      group.push(name + (a.optional ? chalk.dim(" (optional)") : ""));
    }

    const parts = [];
    if (rsvpGroups.accepted.length > 0) {
      parts.push(chalk.green("Y: ") + rsvpGroups.accepted.join(", "));
    }
    if (rsvpGroups.declined.length > 0) {
      parts.push(chalk.red("N: ") + rsvpGroups.declined.join(", "));
    }
    if (rsvpGroups.tentative.length > 0) {
      parts.push(chalk.yellow("?: ") + rsvpGroups.tentative.join(", "));
    }
    if (rsvpGroups.needsAction.length > 0) {
      parts.push(chalk.dim("Pending: ") + rsvpGroups.needsAction.join(", "));
    }

    console.log(`- **Attendees** (${people.length}): ${parts.join(" | ")}`);
  }

  if (rooms.length > 0) {
    const roomNames = rooms.map((r) => r.displayName || r.email).join(", ");
    console.log(`- **Rooms:** ${roomNames}`);
  }
}

function getMeetLink(event) {
  // Prefer conferenceData entry points
  if (event.conferenceData?.entryPoints) {
    const video = event.conferenceData.entryPoints.find((e) => e.entryPointType === "video");
    if (video) return video.uri;
  }
  // Fallback to hangoutLink
  if (event.hangoutLink) return event.hangoutLink;
  return null;
}

function formatTime(event) {
  if (event.start.date) return "All day";

  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  const duration = Math.round((end - start) / 60000);

  const fmt = (d) =>
    d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

  let dur;
  if (duration >= 60) {
    const h = Math.floor(duration / 60);
    const m = duration % 60;
    dur = m > 0 ? `${h}h ${m}m` : `${h}h`;
  } else {
    dur = `${duration}m`;
  }

  return `${fmt(start)} - ${fmt(end)} (${dur})`;
}

function formatEventType(eventType) {
  if (!eventType || eventType === "default") return null;
  const labels = {
    outOfOffice: chalk.bgRed.white(" OOO "),
    focusTime: chalk.bgBlue.white(" Focus "),
    workingLocation: chalk.bgGreen.white(" WFH "),
    birthday: chalk.bgMagenta.white(" Birthday "),
    fromGmail: chalk.bgYellow.black(" Gmail "),
  };
  return labels[eventType] || null;
}

function formatStatus(status) {
  if (!status || status === "confirmed") return null;
  if (status === "tentative") return chalk.yellow("[tentative]");
  if (status === "cancelled") return chalk.red.strikethrough("[cancelled]");
  return null;
}

function groupByDay(events) {
  const groups = {};
  for (const event of events) {
    const start = event.start.dateTime || event.start.date;
    const day = new Date(start).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    if (!groups[day]) groups[day] = [];
    groups[day].push(event);
  }
  return groups;
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}
