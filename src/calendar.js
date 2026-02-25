import { google } from "googleapis";

/**
 * Fetch all calendars for a single authenticated account.
 * Each calendar is tagged with the account email and auth client.
 */
export async function listCalendars(auth, accountEmail) {
  const service = google.calendar({ version: "v3", auth });
  const res = await service.calendarList.list();
  return (res.data.items || []).map((cal) => ({
    ...cal,
    _accountEmail: accountEmail,
    _auth: auth,
  }));
}

/**
 * Fetch events from a calendar with automatic pagination.
 */
export async function listEvents(auth, { calendarId, timeMin, timeMax }) {
  const service = google.calendar({ version: "v3", auth });
  const events = [];
  let pageToken;

  do {
    const res = await service.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: 2500,
      singleEvents: true,
      orderBy: "startTime",
      pageToken,
    });

    events.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return events;
}
