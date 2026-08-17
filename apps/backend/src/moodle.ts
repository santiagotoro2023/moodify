/**
 * Moodle Web Service client (§9).
 *
 * Read-only. Every call is a POST to /webservice/rest/server.php so the token never
 * lands in a URL, an access log, or a proxy log. Moodle answers HTTP 200 even when it
 * refuses a request, so every response body is inspected for `exception`/`errorcode`
 * and converted into a MoodleError with an actionable message.
 *
 * The token is never interpolated into an error message or a log line: everything that
 * echoes text coming back from Moodle runs through redact() first.
 */

import { strict as assert } from 'node:assert';
import { REQUIRED_WS_FUNCTIONS } from '@moodify/shared';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BADGE_IMAGE_BYTES = 2 * 1024 * 1024;

export interface MoodleConnection {
  baseUrl: string;
  token: string;
}

export class MoodleError extends Error {
  readonly errorcode: string;
  readonly wsfunction: string | null;

  constructor(message: string, errorcode = 'unknown', wsfunction: string | null = null) {
    super(message);
    this.name = 'MoodleError';
    this.errorcode = errorcode;
    this.wsfunction = wsfunction;
  }
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/** Endpoint paths users habitually paste into a "base URL" field. */
const PASTED_SUFFIXES = [
  '/webservice/rest/server.php',
  '/login/token.php',
  '/webservice/pluginfile.php',
  '/pluginfile.php',
  '/admin/settings.php',
];

/**
 * Trim, drop any query/fragment, strip a pasted endpoint suffix and trailing slashes.
 * Throws a MoodleError (not a bare Error) so route handlers can report it uniformly.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') {
    throw new MoodleError('A Moodle base URL is required.', 'invalidurl');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new MoodleError(
      `"${trimmed}" is missing a scheme — enter the full address, starting with https:// or http://.`,
      'invalidurl',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new MoodleError(`"${trimmed}" is not a valid URL.`, 'invalidurl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MoodleError(
      `Only http:// and https:// Moodle URLs are supported (got "${parsed.protocol}//").`,
      'invalidurl',
    );
  }

  let path = parsed.pathname.replace(/\/+$/, '');
  const lower = path.toLowerCase();
  for (const suffix of PASTED_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      path = path.slice(0, path.length - suffix.length);
      break;
    }
  }
  path = path.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

/** Belt-and-braces: any text that came from the wire is scrubbed of the secret. */
function redact(text: string, ...secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('••••');
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Moodle runs names and descriptions through format_string(), which HTML-escapes them
 * before they ever reach the web service — so a course called "Firewalls & Sicherheit"
 * arrives as "Firewalls &amp; Sicherheit". Decode once here, at the edge, rather than
 * in every renderer: React escapes on output, so what we store must be plain text.
 */
export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function readString(source: unknown, key: string): string | null {
  const rec = asRecord(source);
  if (!rec) return null;
  const value = rec[key];
  if (typeof value === 'string') return decodeEntities(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function readNumber(source: unknown, key: string): number | null {
  const rec = asRecord(source);
  if (!rec) return null;
  const value = rec[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBool(source: unknown, key: string, fallback: boolean): boolean {
  const rec = asRecord(source);
  if (!rec) return fallback;
  const value = rec[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === '') return fallback;
    return lower !== '0' && lower !== 'false';
  }
  return fallback;
}

function readArray(source: unknown, key: string): unknown[] {
  const rec = asRecord(source);
  if (!rec) return [];
  const value = rec[key];
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

function errnoCode(err: unknown, depth = 0): string | null {
  if (depth > 5 || err === null || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return errnoCode((err as { cause?: unknown }).cause, depth + 1);
}

/** Network/DNS/TLS/timeout failures become readable MoodleErrors instead of raw fetch noise. */
function networkError(err: unknown, url: string, wsfunction: string | null): MoodleError {
  const host = hostOf(url);
  const name = err instanceof Error ? err.name : '';
  const code = errnoCode(err) ?? '';

  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return new MoodleError(
      `Could not reach ${host}: timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
      'network',
      wsfunction,
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new MoodleError(
      `Could not reach ${host}: DNS lookup failed — check the hostname is spelled correctly and resolvable from this server.`,
      'network',
      wsfunction,
    );
  }
  if (code === 'ECONNREFUSED') {
    return new MoodleError(
      `Could not reach ${host}: connection refused — nothing is listening on that host/port.`,
      'network',
      wsfunction,
    );
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return new MoodleError(
      `Could not reach ${host}: the connection was reset before Moodle replied.`,
      'network',
      wsfunction,
    );
  }
  if (code.includes('CERT') || code.includes('TLS') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new MoodleError(
      `Could not reach ${host}: the TLS certificate could not be verified (${code}).`,
      'network',
      wsfunction,
    );
  }

  const detail = err instanceof Error && err.message ? err.message : String(err);
  return new MoodleError(`Could not reach ${host}: ${detail}`, 'network', wsfunction);
}

/** Turn a Moodle errorcode into something an admin can actually act on. */
function explain(errorcode: string, message: string, wsfunction: string): string {
  const code = errorcode.toLowerCase();
  const suffix = message ? ` Moodle said: ${message}` : '';

  if (code === 'sitemaintenance') {
    return `The Moodle site is in maintenance mode, so it is refusing web service calls.${suffix}`;
  }
  if (code === 'invalidtoken' || code === 'tokennotfound' || code === 'invalidtokennouser') {
    return (
      `Moodle rejected the web service token (${errorcode}). ` +
      'Generate a fresh token under Site administration → Server → Web services → Manage tokens, ' +
      'then replace it in Moodify Settings.' +
      suffix
    );
  }
  if (code === 'accessexception' || code === 'webservice_access_exception') {
    return (
      `Moodle refused the call to "${wsfunction}" (${errorcode}). ` +
      'Either the token was rejected, or that function is not part of the External Service the token belongs to. ' +
      `Moodify needs these functions enabled: ${REQUIRED_WS_FUNCTIONS.join(', ')}.` +
      suffix
    );
  }
  if (
    code === 'accessdenied' ||
    code === 'nopermissions' ||
    code === 'requireloginerror' ||
    code === 'cannotviewprofile' ||
    code === 'notingroup'
  ) {
    return (
      `The Moodle account that owns this token is not allowed to call "${wsfunction}" (${errorcode}). ` +
      'Give that account a role with the matching capabilities (typically a site-wide role with ' +
      'moodle/course:view, moodle/user:viewdetails and report/progress:view), or authorise it on the External Service.' +
      suffix
    );
  }
  if (
    code === 'invalidrecord' ||
    code === 'invalidfunction' ||
    code === 'unknownfunction' ||
    message.includes('external_functions')
  ) {
    return (
      `Moodle does not expose the function "${wsfunction}" to this token (${errorcode}). ` +
      'Add it under Site administration → Server → Web services → External services → Functions. ' +
      `Moodify needs: ${REQUIRED_WS_FUNCTIONS.join(', ')}.` +
      suffix
    );
  }
  if (code === 'enablewsdescription' || code === 'servicenotavailable' || code === 'noservice') {
    return (
      'Web services are not enabled on this Moodle site, or the REST protocol is switched off. ' +
      'Enable them under Site administration → Advanced features → Enable web services, and tick REST ' +
      'under Server → Web services → Manage protocols.' + suffix
    );
  }
  if (code === 'invalidparameter' || code === 'invalidparametervalue') {
    return `Moodle rejected the parameters sent to "${wsfunction}" (${errorcode}).${suffix}`;
  }

  return `Moodle call "${wsfunction}" failed (${errorcode}).${suffix}`;
}

// ---------------------------------------------------------------------------
// Core transport
// ---------------------------------------------------------------------------

async function callWs<T>(
  conn: MoodleConnection,
  wsfunction: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const base = normalizeBaseUrl(conn.baseUrl);
  const endpoint = `${base}/webservice/rest/server.php`;

  const body = new URLSearchParams();
  body.set('wstoken', conn.token);
  body.set('wsfunction', wsfunction);
  body.set('moodlewsrestformat', 'json');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw networkError(err, endpoint, wsfunction);
  }

  if (!response.ok) {
    throw new MoodleError(
      `Moodle returned HTTP ${response.status} for "${wsfunction}". ` +
        `Check that ${base} is the Moodle site root and that /webservice/rest/server.php is reachable ` +
        '(a reverse proxy or WAF blocking POSTs is a common cause).',
      `http_${response.status}`,
      wsfunction,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw networkError(err, endpoint, wsfunction);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    const snippet = redact(text.slice(0, 120).replace(/\s+/g, ' ').trim(), conn.token);
    throw new MoodleError(
      `Moodle did not return JSON for "${wsfunction}" — got "${snippet}". ` +
        `Is ${base} really a Moodle site root?`,
      'invalidresponse',
      wsfunction,
    );
  }

  const record = asRecord(payload);
  if (record && ('exception' in record || 'errorcode' in record)) {
    const errorcode = readString(record, 'errorcode') ?? readString(record, 'exception') ?? 'unknown';
    const rawMessage =
      readString(record, 'message') ?? readString(record, 'error') ?? 'no further detail';
    throw new MoodleError(
      explain(errorcode, redact(rawMessage, conn.token), wsfunction),
      errorcode,
      wsfunction,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Typed API surface
// ---------------------------------------------------------------------------

export interface SiteInfo {
  sitename: string;
  username: string;
  functions: string[];
  userid: number;
  /**
   * The External Service's "Can download files" flag. Separate from the enabled
   * function list: a service can be allowed to call every function Moodify needs and
   * still refuse to serve a single file through webservice/pluginfile.php.
   */
  downloadFiles: boolean;
}

/** What the Moodle admin has to change when downloadFiles is off. */
export const ENABLE_DOWNLOAD_HELP =
  'In Moodle: Site administration → Server → Web services → External services → ' +
  'Edit your Moodify service → Show more… → tick "Can download files" → Save.';

/** core_webservice_get_site_info — the connection test (§8, §9.1). */
export async function getSiteInfo(conn: MoodleConnection): Promise<SiteInfo> {
  const raw = await callWs<unknown>(conn, 'core_webservice_get_site_info');
  const functions: string[] = [];
  for (const entry of readArray(raw, 'functions')) {
    const name = readString(entry, 'name');
    if (name !== null && name !== '') functions.push(name);
  }
  return {
    sitename: readString(raw, 'sitename') ?? '',
    username: readString(raw, 'username') ?? '',
    functions,
    userid: readNumber(raw, 'userid') ?? 0,
    downloadFiles: (readNumber(raw, 'downloadfiles') ?? 0) > 0,
  };
}

/**
 * /login/token.php — exchange username+password for a web service token (§8, wizard option B).
 * Requires the Moodle admin to have created the External Service and authorised the account.
 */
export async function fetchToken(
  baseUrl: string,
  username: string,
  password: string,
  service: string,
): Promise<string> {
  const base = normalizeBaseUrl(baseUrl);
  const query = new URLSearchParams();
  query.set('username', username);
  query.set('password', password);
  query.set('service', service);
  const url = `${base}/login/token.php?${query.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw networkError(err, url, 'login/token.php');
  }

  if (!response.ok) {
    throw new MoodleError(
      `Moodle returned HTTP ${response.status} from /login/token.php. Check that ${base} is the Moodle site root.`,
      `http_${response.status}`,
      'login/token.php',
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new MoodleError(
      `Moodle did not return JSON from /login/token.php — is ${base} the Moodle site root?`,
      'invalidresponse',
      'login/token.php',
    );
  }

  const token = readString(payload, 'token');
  if (token !== null && token !== '') return token;

  const errorcode = readString(payload, 'errorcode') ?? 'unknown';
  const rawMessage =
    readString(payload, 'error') ?? readString(payload, 'message') ?? 'no further detail';
  const message = redact(rawMessage, password);
  const code = errorcode.toLowerCase();

  if (code === 'enablewsdescription') {
    throw new MoodleError(
      'Web services are disabled on this Moodle site. Enable them under Site administration → ' +
        'Advanced features → "Enable web services", then tick REST under Server → Web services → Manage protocols.',
      errorcode,
      'login/token.php',
    );
  }
  if (code === 'enablemobilewsdescription') {
    throw new MoodleError(
      'This Moodle only issues tokens for the mobile service, which is currently disabled. ' +
        'Either enable it, or create a dedicated External Service and use its shortname here.',
      errorcode,
      'login/token.php',
    );
  }
  if (code === 'invalidlogin' || code === 'invalidaccount') {
    throw new MoodleError(
      'Moodle rejected that username or password.',
      errorcode,
      'login/token.php',
    );
  }
  if (code === 'servicenotavailable' || code === 'accessexception' || code === 'noservice') {
    throw new MoodleError(
      `Moodle has no External Service with the shortname "${service}", or this account is not authorised on it. ` +
        `Create it under Site administration → Server → Web services → External services, enable ` +
        `"Authorised users only" if desired, and add these functions: ${REQUIRED_WS_FUNCTIONS.join(', ')}.`,
      errorcode,
      'login/token.php',
    );
  }
  if (code === 'sitepolicynotagreed') {
    throw new MoodleError(
      'That Moodle account must accept the site policy by logging into Moodle once in a browser before it can be issued a token.',
      errorcode,
      'login/token.php',
    );
  }

  throw new MoodleError(
    `Moodle refused to issue a token (${errorcode}): ${message}`,
    errorcode,
    'login/token.php',
  );
}

export interface MoodleCourse {
  id: number;
  shortname: string;
  fullname: string;
  visible: boolean;
}

/**
 * core_course_get_courses. Moodle includes the site front page as a pseudo-course
 * (id 1, format 'site'); it is not a real course and is dropped here.
 */
export async function getCourses(conn: MoodleConnection): Promise<MoodleCourse[]> {
  const raw = await callWs<unknown>(conn, 'core_course_get_courses');
  const list = Array.isArray(raw) ? raw : [];
  const courses: MoodleCourse[] = [];
  for (const entry of list) {
    const id = readNumber(entry, 'id');
    if (id === null || id === 1) continue;
    if (readString(entry, 'format') === 'site') continue;
    courses.push({
      id,
      shortname: readString(entry, 'shortname') ?? `course-${id}`,
      fullname: readString(entry, 'fullname') ?? readString(entry, 'shortname') ?? `Course ${id}`,
      visible: readBool(entry, 'visible', true),
    });
  }
  return courses;
}

export interface EnrolledUser {
  id: number;
  fullname: string;
  email: string | null;
  roles: string[];
  /** pluginfile.php URL of the profile picture, or null when Moodle hides it. */
  profileImageUrl: string | null;
}

/** core_enrol_get_enrolled_users. Email is often hidden by Moodle policy → null. */
export async function getEnrolledUsers(
  conn: MoodleConnection,
  courseId: number,
): Promise<EnrolledUser[]> {
  const raw = await callWs<unknown>(conn, 'core_enrol_get_enrolled_users', { courseid: courseId });
  const list = Array.isArray(raw) ? raw : [];
  const users: EnrolledUser[] = [];
  for (const entry of list) {
    const id = readNumber(entry, 'id');
    if (id === null) continue;
    const email = readString(entry, 'email');
    const roles: string[] = [];
    for (const role of readArray(entry, 'roles')) {
      const shortname = readString(role, 'shortname');
      if (shortname !== null && shortname !== '') roles.push(shortname);
    }
    // Moodle always sends a profileimageurl; for a user who never uploaded one it points
    // at the theme's generic silhouette (theme/image.php), not pluginfile.php. Caching
    // that would replace "no picture" with a grey stranger, so only real uploads count.
    const picture = readString(entry, 'profileimageurl');
    users.push({
      id,
      fullname: readString(entry, 'fullname') ?? `User ${id}`,
      email: email !== null && email.trim() !== '' ? email : null,
      roles,
      profileImageUrl: picture !== null && picture.includes('pluginfile.php') ? picture : null,
    });
  }
  return users;
}

export interface MoodleCohort {
  id: number;
  name: string;
  idnumber: string | null;
}

/**
 * core_cohort_get_cohorts with no ids = every cohort the token's account can see.
 *
 * Site-wide cohorts, not course groups: a "1. Lehrjahr" that spans several courses is a
 * cohort, and a deadline set against it follows the class rather than being re-entered
 * per course.
 */
export async function getCohorts(conn: MoodleConnection): Promise<MoodleCohort[]> {
  const raw = await callWs<unknown>(conn, 'core_cohort_get_cohorts');
  const cohorts: MoodleCohort[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = readNumber(entry, 'id');
    if (id === null) continue;
    const idnumber = readString(entry, 'idnumber');
    cohorts.push({
      id,
      name: readString(entry, 'name') ?? `Cohort ${id}`,
      idnumber: idnumber !== null && idnumber.trim() !== '' ? idnumber : null,
    });
  }
  return cohorts;
}

/** core_cohort_get_cohort_members → [{cohortid, userids:[…]}], as a map. */
export async function getCohortMembers(
  conn: MoodleConnection,
  cohortIds: readonly number[],
): Promise<Map<number, number[]>> {
  const members = new Map<number, number[]>();
  if (cohortIds.length === 0) return members;

  const params: Record<string, number> = {};
  cohortIds.forEach((id, index) => {
    params[`cohortids[${index}]`] = id;
  });

  const raw = await callWs<unknown>(conn, 'core_cohort_get_cohort_members', params);
  for (const entry of Array.isArray(raw) ? raw : []) {
    const cohortId = readNumber(entry, 'cohortid');
    if (cohortId === null) continue;
    const userIds: number[] = [];
    for (const value of readArray(entry, 'userids')) {
      if (typeof value === 'number') userIds.push(value);
      else if (typeof value === 'string' && value.trim() !== '') userIds.push(Number(value));
    }
    members.set(cohortId, userIds.filter((id) => Number.isFinite(id)));
  }
  return members;
}

export interface CourseModule {
  cmid: number;
  name: string;
  modname: string;
  /** Section it sits in — "Grundlagen › Woche 2" when that is a subsection. */
  section: string;
  /** Position of that section in the course, so a list can follow Moodle's own order. */
  sectionOrder: number;
}

/**
 * core_course_get_contents, reduced to the activities a deadline can be set on.
 *
 * This is the only call that knows what an activity is *called* —
 * core_completion_get_activities_completion_status returns nothing but cmids, so
 * without this there is no way to pick "Aufgabe ISO/OSI" out of a list.
 *
 * Modules with completion tracking switched off are dropped: a deadline on something
 * Moodle never marks complete could never be met. A module that does not report the
 * field at all is kept — older Moodle versions omit it, and hiding a real activity is
 * worse than listing one extra.
 */
export async function getCourseContents(
  conn: MoodleConnection,
  courseId: number,
): Promise<CourseModule[]> {
  const raw = await callWs<unknown>(conn, 'core_course_get_contents', { courseid: courseId });
  const sections = Array.isArray(raw) ? raw : [];

  // Moodle 4.5 subsections are not nested in the response: a subsection comes back as its
  // own top-level section flagged `component: mod_subsection`, pointing at the
  // mod_subsection instance that hosts it. Mapping that instance id back to the section
  // it lives in is the only way to say "Grundlagen › Woche 2" instead of a bare "Woche 2"
  // that could be any of four. Older Moodle has none of this and the map stays empty.
  const parentOf = new Map<number, string>();
  for (const section of sections) {
    const sectionName = readString(section, 'name') ?? '';
    for (const entry of readArray(section, 'modules')) {
      if (readString(entry, 'modname') !== 'subsection') continue;
      const instance = readNumber(entry, 'instance');
      if (instance !== null) parentOf.set(instance, sectionName);
    }
  }

  const modules: CourseModule[] = [];
  let order = 0;
  for (const section of sections) {
    order += 1;
    const name = readString(section, 'name') ?? '';
    const itemid = readNumber(section, 'itemid');
    const parent =
      readString(section, 'component') === 'mod_subsection' && itemid !== null
        ? parentOf.get(itemid)
        : undefined;
    const label = parent !== undefined && parent !== '' ? `${parent} › ${name}` : name;

    for (const entry of readArray(section, 'modules')) {
      const cmid = readNumber(entry, 'id');
      if (cmid === null) continue;
      const modname = readString(entry, 'modname') ?? 'unknown';
      // A subsection is a container, not something anyone completes.
      if (modname === 'subsection') continue;
      const completion = readNumber(entry, 'completion');
      if (completion === 0) continue;
      modules.push({
        cmid,
        name: readString(entry, 'name') ?? `Activity ${cmid}`,
        modname,
        section: label,
        sectionOrder: order,
      });
    }
  }
  return modules;
}

export interface ActivityCompletionStatus {
  /** Course module id. */
  cmid: number;
  /** 0 = incomplete, 1 = complete, 2 = complete-pass, 3 = complete-fail. */
  state: number;
  /** 0 = completion not tracked, 1 = manual, 2 = automatic. */
  tracking: number;
  /**
   * Unix seconds when the activity was completed, or null.
   *
   * This is the whole basis of the all-time chart: Moodle has been recording it since
   * long before Moodify existed, so history can be reconstructed exactly rather than
   * scraped out of the log store. Null (Moodle sends 0) for anything not completed, and
   * occasionally for completions restored from a backup, which carry no timestamp.
   */
  timecompleted: number | null;
}

/** core_completion_get_activities_completion_status → {statuses:[…]}. */
export async function getActivitiesCompletion(
  conn: MoodleConnection,
  courseId: number,
  userId: number,
): Promise<ActivityCompletionStatus[]> {
  const raw = await callWs<unknown>(conn, 'core_completion_get_activities_completion_status', {
    courseid: courseId,
    userid: userId,
  });
  const statuses: ActivityCompletionStatus[] = [];
  for (const entry of readArray(raw, 'statuses')) {
    const cmid = readNumber(entry, 'cmid');
    if (cmid === null) continue;
    const completed = readNumber(entry, 'timecompleted');
    statuses.push({
      cmid,
      state: readNumber(entry, 'state') ?? 0,
      tracking: readNumber(entry, 'tracking') ?? 0,
      timecompleted: completed !== null && completed > 0 ? completed : null,
    });
  }
  return statuses;
}

export interface UserBadge {
  id: number;
  name: string;
  description: string | null;
  /** null = site-wide badge (Moodle reports courseid 0 or omits it). */
  courseid: number | null;
  /** Unix seconds. */
  dateissued: number | null;
  badgeurl: string | null;
}

/**
 * core_badges_get_user_badges → {badges:[…]}. Scoped to a course when courseId is given.
 * The image URL field name varies by Moodle version (badgeurl / imageurl).
 */
export async function getUserBadges(
  conn: MoodleConnection,
  userId: number,
  courseId?: number,
): Promise<UserBadge[]> {
  const params: Record<string, string | number | undefined> = { userid: userId };
  if (courseId !== undefined && courseId > 0) params.courseid = courseId;

  const raw = await callWs<unknown>(conn, 'core_badges_get_user_badges', params);
  const badges: UserBadge[] = [];
  for (const entry of readArray(raw, 'badges')) {
    const id = readNumber(entry, 'id');
    if (id === null) continue;
    const description = readString(entry, 'description');
    const rawCourseId = readNumber(entry, 'courseid');
    const issued = readNumber(entry, 'dateissued');
    const imageUrl = readString(entry, 'badgeurl') ?? readString(entry, 'imageurl');
    badges.push({
      id,
      name: readString(entry, 'name') ?? `Badge ${id}`,
      description: description !== null && description.trim() !== '' ? description : null,
      courseid: rawCourseId !== null && rawCourseId > 0 ? rawCourseId : null,
      dateissued: issued !== null && issued > 0 ? issued : null,
      badgeurl: imageUrl !== null && imageUrl.trim() !== '' ? imageUrl : null,
    });
  }
  return badges;
}

/**
 * Turns a Moodle file URL into one a web service token can actually open.
 *
 * Plain `/pluginfile.php/...` authenticates by *session cookie* and ignores a token
 * parameter entirely — only `/webservice/pluginfile.php/...` honours one. Which of the
 * two `core_badges_get_user_badges` hands back depends on the Moodle version, so
 * normalise to the webservice variant before appending the token.
 */
function withTokenAuth(fileUrl: string, token: string): string {
  const normalized = fileUrl.includes('/webservice/pluginfile.php')
    ? fileUrl
    : fileUrl.replace('/pluginfile.php', '/webservice/pluginfile.php');
  const separator = normalized.includes('?') ? '&' : '?';
  return `${normalized}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * Badge icons and profile pictures both live behind pluginfile.php, which needs
 * authentication — the frontend must never hotlink Moodle (§9.3). Fetch once with a
 * token query param, cache locally.
 */
/**
 * Both kinds of URL end in a size suffix (`/f1`, `/f2`, `/f3`). Which sizes exist depends
 * on the Moodle version — the exporter can hand back an `f3` that badges_pluginfile()
 * then refuses — so a failed download is retried against the other sizes before giving up.
 */
function sizeVariants(imageUrl: string): string[] {
  const match = /\/f[123](\?|$)/.exec(imageUrl);
  if (match === null) return [imageUrl];
  const current = imageUrl.slice(match.index + 1, match.index + 3);
  return [imageUrl, ...['f3', 'f2', 'f1'].filter((size) => size !== current)
    .map((size) => imageUrl.slice(0, match.index) + '/' + size + imageUrl.slice(match.index + 3))];
}

/**
 * Turns a non-image pluginfile.php response into a MoodleError that names the fix.
 *
 * The common one by far is "Can download files" being off on the External Service:
 * webservice/pluginfile.php checks that flag before it looks at the file at all, so
 * every function can be enabled and every image still 403s. Moodle renders that as an
 * HTML error page rather than JSON, which is why it needs matching on the body.
 */
function refusalError(body: string, contentType: string, token: string): MoodleError {
  let payload: unknown = null;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    payload = null;
  }
  const errorcode = readString(payload, 'errorcode');
  const message = readString(payload, 'message') ?? readString(payload, 'error');

  const haystack = `${errorcode ?? ''} ${message ?? ''} ${payload === null ? body : ''}`.toLowerCase();
  if (haystack.includes('enabledirectdownload') || haystack.includes('file downloading')) {
    return new MoodleError(
      `Moodle refused to serve images: this web service is not allowed to download files. ${ENABLE_DOWNLOAD_HELP}`,
      'enabledirectdownload',
      'pluginfile.php',
    );
  }
  if (errorcode !== null || message !== null) {
    return new MoodleError(
      `Moodle refused to serve a badge image (${errorcode ?? 'accessdenied'}): ${redact(message ?? 'access denied', token)}`,
      errorcode ?? 'accessdenied',
      'pluginfile.php',
    );
  }
  // An HTML page with no recognisable error: quote its title, which is what Moodle
  // puts the reason in, rather than dumping a whole page into a log line.
  const title = /<title>([^<]{1,200})<\/title>/i.exec(body)?.[1]?.trim();
  return new MoodleError(
    `Moodle returned ${contentType} instead of an image${title ? ` ("${redact(decodeEntities(title), token)}")` : ''}. ` +
      `The usual cause is "Can download files" being off on the External Service. ${ENABLE_DOWNLOAD_HELP}`,
    'notanimage',
    'pluginfile.php',
  );
}

export async function downloadImage(
  conn: MoodleConnection,
  imageUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const [first, ...rest] = sizeVariants(imageUrl);
  let lastError: unknown;
  for (const candidate of [first ?? imageUrl, ...rest]) {
    try {
      return await fetchOneImage(conn, candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function fetchOneImage(
  conn: MoodleConnection,
  imageUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const url = withTokenAuth(imageUrl, conn.token);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'image/*' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw networkError(err, imageUrl, 'pluginfile.php');
  }

  if (!response.ok) {
    throw new MoodleError(
      `Downloading an image from Moodle failed with HTTP ${response.status}.`,
      `http_${response.status}`,
      'pluginfile.php',
    );
  }

  const headerType = response.headers.get('content-type') ?? '';
  const contentType = (headerType.split(';')[0] ?? '').trim() || 'application/octet-stream';

  // A refusal comes back as HTTP 200 with a body that is not an image: JSON when the
  // token is rejected, a rendered HTML error page when the service forbids downloads.
  // Anything that is not image/* is therefore a failure, never something to cache.
  if (!contentType.startsWith('image/')) {
    const text = await response.text().catch(() => '');
    throw refusalError(text, contentType, conn.token);
  }

  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BADGE_IMAGE_BYTES) {
    throw new MoodleError(
      `Image is larger than ${MAX_BADGE_IMAGE_BYTES / 1024 / 1024} MB; skipping it.`,
      'toolarge',
      'pluginfile.php',
    );
  }

  const body = response.body;
  if (body === null) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      throw networkError(err, imageUrl, 'pluginfile.php');
    }
    if (bytes.byteLength > MAX_BADGE_IMAGE_BYTES) {
      throw new MoodleError(
        `Image is larger than ${MAX_BADGE_IMAGE_BYTES / 1024 / 1024} MB; skipping it.`,
        'toolarge',
        'pluginfile.php',
      );
    }
    return { buffer: Buffer.from(bytes), contentType };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_BADGE_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new MoodleError(
          `Image is larger than ${MAX_BADGE_IMAGE_BYTES / 1024 / 1024} MB; skipping it.`,
          'toolarge',
          'pluginfile.php',
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof MoodleError) throw err;
    throw networkError(err, imageUrl, 'pluginfile.php');
  }

  return { buffer: Buffer.concat(chunks), contentType };
}

// ---------------------------------------------------------------------------
// Completion maths (spec §9.2) — pure, so it is unit-testable without a Moodle.
// ---------------------------------------------------------------------------

export interface CompletionSummary {
  activitiesTotal: number;
  activitiesCompleted: number;
  /** null means the course tracks no completion at all — never coerce this to 0. */
  percent: number | null;
}

export function computeCompletion(
  statuses: readonly ActivityCompletionStatus[],
): CompletionSummary {
  let activitiesTotal = 0;
  let activitiesCompleted = 0;
  for (const status of statuses) {
    if (status.tracking === 0) continue; // completion not enabled for this activity
    activitiesTotal += 1;
    if (status.state === 1 || status.state === 2) activitiesCompleted += 1; // 3 = complete-fail
  }
  if (activitiesTotal === 0) {
    return { activitiesTotal: 0, activitiesCompleted: 0, percent: null };
  }
  const percent = Math.round((activitiesCompleted / activitiesTotal) * 10000) / 100;
  return { activitiesTotal, activitiesCompleted, percent };
}

// --- self-check: `tsx src/moodle.ts` -----------------------------------------
if (process.argv[1]?.endsWith('moodle.ts')) {
  const s = (cmid: number, state: number, tracking: number): ActivityCompletionStatus => ({ cmid, state, tracking, timecompleted: null });
  assert.deepEqual(computeCompletion([]), { activitiesTotal: 0, activitiesCompleted: 0, percent: null });
  assert.deepEqual(computeCompletion([s(1, 1, 0), s(2, 0, 0)]), { activitiesTotal: 0, activitiesCompleted: 0, percent: null });
  assert.deepEqual(computeCompletion([s(1, 1, 1), s(2, 2, 2), s(3, 3, 2), s(4, 0, 1), s(5, 1, 0)]), { activitiesTotal: 4, activitiesCompleted: 2, percent: 50 });
  assert.deepEqual(computeCompletion([s(1, 2, 2), s(2, 1, 1)]), { activitiesTotal: 2, activitiesCompleted: 2, percent: 100 });
  assert.equal(computeCompletion([s(1, 1, 1), s(2, 0, 1), s(3, 0, 1)]).percent, 33.33);
  assert.equal(normalizeBaseUrl('  https://moodle.example.org/webservice/rest/server.php/ '), 'https://moodle.example.org');
  // A plain pluginfile URL must be rewritten, a webservice one left alone.
  assert.equal(withTokenAuth('https://m.example/pluginfile.php/1/badges/f/x.png', 'abc'), 'https://m.example/webservice/pluginfile.php/1/badges/f/x.png?token=abc');
  assert.equal(withTokenAuth('https://m.example/webservice/pluginfile.php/1/x.png?f=1', 'abc'), 'https://m.example/webservice/pluginfile.php/1/x.png?f=1&token=abc');
  console.log('moodle.ts self-check ok');
}
