import { io } from "../vendor/socket/socket.io.esm.min.js";
import {
  ClassMemberData,
  DataAccessor,
  DataAccessorEventCallback,
  DataAccessorEventName,
  EventData,
  EventTypeData,
  HomeworkCheckedData,
  HomeworkData,
  JoinedTeamsData,
  LessonData,
  LessonGroup,
  LessonWithSubject,
  LessonWithSubstitution,
  TimetableData,
  SubjectData,
  SubstitutionsData,
  TeamsData,
  UploadData,
  SocketDataAccessor,
  RawDate,
  AjaxOptions,
  AjaxError,
  SerializedRequest,
  LessonGroupWithEvent,
  UploadRequestsData,
  ClassInfo,
  Bootstrap,
  UserEventName,
  UserEventCallback,
  SingleLessonData
} from "./types";

export const lastCommaRegex = /,(?!.*,)/;
export const weekDaysSo = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
export const weekDaysMo = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
export const monthNames = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
export const isStandalone = globalThis.matchMedia("(display-mode: standalone)").matches;
export const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

export function getSite(): string {
  return location.pathname.replace(/(^\/)|(\/$)/g, "") || "/";
}

export function isSite(...sites: (string | RegExp)[]): boolean {
  const site = getSite();
  return sites.some(s => {
    return s === site || (s instanceof RegExp && s.test(site));
  });
}

export function onlyThisSite<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T | null {
  const site = getSite();
  return function onlyThisSiteWrapper(...args: unknown[]) {
    if (isSite(site)) return fn(...args);
    return null;
  };
}

export function isValidSite(site: string): boolean {
  return [
    "404",
    "about",
    "events",
    "homework",
    "join",
    "main",
    "settings",
    "uploads"
  ].includes(site);
}

function openIndexedDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const request = indexedDB.open("app", 1);

    request.onupgradeneeded = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };

    request.onsuccess = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (db.objectStoreNames.contains("meta")) {
        res(db);
      }
      else {
        db.close();
        indexedDB.deleteDatabase("app");
        openIndexedDB().then(res => res);
      }
    };

    request.onsuccess = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      res(db);
    };

    request.onerror = event => {
      const error = (event.target as IDBOpenDBRequest).error;
      rej(error!);
    };
  });
}

export function toDate(raw: RawDate): Date {
  return new Date(raw instanceof Date ? raw : (typeof raw === "number" ? raw : Number.parseInt(raw)));
}

export function getSimpleDisplayDate(raw: RawDate): string {
  const date = toDate(raw);

  const day = String(date.getDate());
  const month = String(date.getMonth() + 1);
  return `${day}.${month}`;
}

export enum RelativeDirection {
  PAST,
  FUTURE
}
export function getDisplayDate(raw: RawDate, settings?: { relativeDirection?: RelativeDirection, alwaysDate?: boolean, withTime?: boolean }): string {
  const {
    relativeDirection: weekDaysDirection = RelativeDirection.PAST,
    alwaysDate = true,
    withTime = false
  } = settings ?? {};

  const date = toDate(raw);

  const simpleDateStr = getSimpleDisplayDate(raw);

  const msDate = (new Date(date)).setHours(0, 0, 0, 0);
  const msToday = new Date().setHours(0, 0, 0, 0);
  const daysDiff = (msDate - msToday) / (1000 * 60 * 60 * 24);

  const dateInRange = weekDaysDirection === RelativeDirection.FUTURE ? (daysDiff >= -1 && daysDiff <= 6) : (daysDiff >= -6 && daysDiff <= 2);
  const withDayStr = dateInRange ?
    `<b>${
      {"-1": "gestern", "0": "heute", "1": "morgen", "2": "übermorgen"}[daysDiff] ?? weekDaysSo[date.getDay()]
    }</b>${alwaysDate ? ", " + simpleDateStr : ""}` :

    `<b>${simpleDateStr}</b>`;
  
  const pad = (x: number): string => String(x).padStart(2, "0");
  const withTimeStr = withDayStr + (withTime ? `, um <b>${pad(date.getHours())}:${pad(date.getMinutes())}</b> Uhr` : "");
  
  return withTimeStr;
}

export function msToInputDate(raw: RawDate): string {
  if (raw === "") return "";
  const date = toDate(raw);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${year}-${month}-${day}`;
}

export function dateToMs(dateStr: string): number | null {
  if (dateStr.includes("-")) {
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getTime();
  }
  else if (dateStr.includes(".")) {
    const [day, month, year] = dateStr.split(".").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getTime();
  }
  return null;
}

export function timeToMs(timeStr: string): number {
  const time = timeStr.split(":").map(v => Number.parseInt(v));
  return (time[0] * 60 + time[1]) * 60 * 1000;
}

export function msToTime(ms: number | string): string {
  const num = typeof ms === "string" ? Number.parseInt(ms) : ms;
  return `${Math.trunc(num / 1000 / 60 / 60)
    .toString()
    .padStart(2, "0")}:${((num / 1000 / 60) % 60).toString().padStart(2, "0")}`;
}

export function secondsToDurationInSeconds(s: number): string {
  return `${Math.trunc(s / 60).toString()}:${Math.trunc(s % 60).toString().padStart(2, "0")}`;
}

export function dateDaysDifference(raw1: RawDate, raw2: RawDate): number {
  const date1 = toDate(raw1);
  const date2 = toDate(raw2);
  const utc1 = Date.UTC(date1.getFullYear(), date1.getMonth(), date1.getDate());
  const utc2 = Date.UTC(date2.getFullYear(), date2.getMonth(), date2.getDate());

  const diffMs = utc1 - utc2;
  return diffMs / (1000 * 60 * 60 * 24);
}

export function getTimeLeftString(timeLeft: number): string {
  if (timeLeft < 60 * 60 * 1000) {
    const mins = Math.ceil(timeLeft / 60 / 1000);
    return mins + " Minute" + (mins > 1 ? "n" : "");
  }
  else {
    const hours = Math.floor(timeLeft / 60 / 60 / 1000);
    const mins = Math.ceil((timeLeft % (60 * 60 * 1000)) / 60 / 1000);
    if (mins === 0) {
      return hours + " Stunde" + (hours > 1 ? "n" : "");
    }
    else {
      return hours + " Stunde" + (hours > 1 ? "n und " : " und ") + mins + " Minute" + (mins > 1 ? "n" : "");
    }
  }
}

export function isSameDay(raw1: RawDate, raw2: RawDate): boolean {
  const date1 = toDate(raw1);
  const date2 = toDate(raw2);
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

export function deepCompare(a: unknown, b: unknown): boolean {
  function deepCompareArray(a: unknown[], b: unknown[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (! deepCompare(a[i], b[i])) return false;
    }
    return true;
  }
  function deepCompareObject(a: object, b: object): boolean {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (! keysB.includes(key)) return false;
      if (! deepCompare((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
    }
    return true;
  }

  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    return deepCompareArray(a, b);
  }

  if (typeof a === "object" && typeof b === "object") {
    return deepCompareObject(a, b);
  }

  return false;
}

export function escapeHTML(str: string): string {
  return str.replace(/[&<>"']/g, char => {
    switch (char) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    case "'": return "&#39;";
    default: return char;
    }
  });
}

export function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  if (crypto.randomUUID !== undefined) {
    return crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  }) as `${string}-${string}-${string}-${string}-${string}`;
}

export function $cloneTemplate(selector: string, settings?: {id?: string, dataId?: string, disabled?: boolean}): JQuery<HTMLElement> {
  const { id = randomUUID(), dataId, disabled } = settings ?? {};

  const t = $(selector);
  if (t.length === null) {
    console.warn(`No <template> with selector "${selector}"!`);
    return $();
  }
  const template = $(selector)[0] as HTMLTemplateElement;
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const children = $(fragment).children();

  for (const attr of ["id", "for", "data-bs-target"]) {
    children.find(`[${attr}*="{{ID}}"]`).addBack(`[${attr}*="{{ID}}"]`).each(function () {
      $(this).attr(attr, $(this).attr(attr)?.replaceAll("{{ID}}", id) ?? "");
    });
  }

  if (dataId) {
    children.find("[data-id]").addBack("[data-id]").attr("data-id", dataId);
  }

  if (disabled !== undefined) {
    children.find("[disabled]").addBack("[disabled]").attr("disabled", disabled ? "" : null);
  }
  return children;
}

export function makeButtonShowCheck(btn: JQuery<HTMLElement>, duration: number): void {
  const html = btn.html();

  btn.css({ width: btn.css("width"), height: btn.css("height") });
  btn.html('<i class="fa-solid fa-circle-check" aria-hidden="true"></i>').prop("disabled", true);

  setTimeout(() => {
    btn.html(html).prop("disabled", false);
    btn.css({ width: "", height: "" });
  }, duration);
}

export async function showButtonLoading(btn: JQuery<HTMLElement>, p: Promise<unknown>): Promise<void> {
  const w = btn.outerWidth() + "px";
  const h = btn.outerHeight() + "px";
  btn[0]?.style.setProperty("width", w, "important");
  btn[0]?.style.setProperty("min-width", w, "important");
  btn[0]?.style.setProperty("height", h, "important");
  btn[0]?.style.setProperty("min-height", h, "important");

  const content = btn.contents().detach();
  btn.html('<span class="spinner-border" aria-hidden="true"></span>');
  btn.prop("disabled", true);

  try {
    await p;
  }
  finally {
    btn.css({ width: "", minWidth: "", height: "", minHeight: "" });
    btn.empty().append(content);
    btn.prop("disabled", false);
  }
}

export function cutString(str: string, maxLength: number): string {
  if (str.length < maxLength) return str;
  return str.substring(0, maxLength - 1) + "…";
}

export function clamp(min: number, val: number, max: number): number {
  return Math.min(max, Math.max(val, min));
}

export function toCommaAndAnd(strings: string[]): string {
  return strings.join(", ").replace(/,(?!.*,)/, " und");
}

export function getInputValue(element: JQuery<HTMLElement>, fallback?: string): string {
  return element.val()?.toString() ?? (fallback ?? "");
}

export function canAutocomplete(element: JQuery<HTMLElement>, unsetVal?: string): boolean {
  return element.hasClass("is-autocompleted") || getInputValue(element).trim() === (unsetVal ?? "");
}

export function forceAutocomplete(element: JQuery<HTMLElement>, val: string | string[] | number): void {
  element.val(val).addClass("is-autocompleted").trigger("autocomplete");
}

export function autocomplete(element: JQuery<HTMLElement>, val: string | string[] | number, unsetVal?: string): boolean {
  if (canAutocomplete(element, unsetVal)) { // The user hasn't decided for a specific value
    forceAutocomplete(element, val);
    return true;
  }
  return false;
}

export async function checkTeamInputForSuspicious(this: HTMLElement): Promise<void> {
  const teamId = Number.parseInt(getInputValue($(this)));
  if (Number.isNaN(teamId)) {
    $(this).removeClass("is-suspicious");
  }
  else {
    const currentJoinedTeamsData = await joinedTeamsData();
    const selectedTeamName = $(this).find("option:selected").text();
    $(this).val(teamId).find("~ .suspicious-feedback b").text(selectedTeamName);
    $(this).toggleClass("is-suspicious", !currentJoinedTeamsData.includes(teamId));
  }
}

export function getCirclePath(cx: number, cy: number, r: number, a: number, full?: boolean): string {
  if (full) {
    return `M${cx} ${cy - r} A${r} ${r} 0 1 1 ${cx} ${cy + r} A${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
  }
  const x = cx + r * Math.sin(Math.PI / 180 * a);
  const y = cy - r * Math.cos(Math.PI / 180 * a);
  return `M${cx} ${cy} l0 ${-r} A${r} ${r} 0 ${a % 360 > 180 ? 1 : 0} 1 ${x} ${y} Z`;
}

export function bytesToText(b: number): string {
  if (b < 100) {
    return Math.round(b * 10) / 10 + "B";
  }
  else {
    b /= 1024;
    if (b < 100) {
      return Math.round(b * 10) / 10 + "KB";
    }
    else {
      b /= 1024;
      if (b < 100) {
        return Math.round(b * 10) / 10 + "MB";
      }
      else {
        return Math.round(b / 1024 * 10) / 10 + "GB";
      }
    }
  }
};

export function checkSecurePassword(username: string, password: string): boolean {
  return !password.toLowerCase().includes(username.toLowerCase()) && /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{6,128}$/.test(password);
}

export async function loadTimetableData(date: Date): Promise<TimetableData[]> {
  await joinedTeamsData.init(); await subjectData.init(); await lessonData.init(); await classSubstitutionsData.init(); await eventData.init();

  const currentJoinedTeamsData = await joinedTeamsData();
  const currentSubjectData = (await subjectData()).filter(s => s.teamId === -1 || currentJoinedTeamsData.includes(s.teamId));
  const currentLessonData = await lessonData();
  const currentSubstitutionsData = await classSubstitutionsData();
  const currentEventData = await eventData();

  const lessonsWithSubject: LessonWithSubject[] = currentLessonData.filter(l => l.weekDay === date.getDay() - 1)
    .filter(l => (currentJoinedTeamsData.includes(l.teamId) || l.teamId === -1))
    .map(l => {
      const subject = currentSubjectData.find(s => s.subjectId === l.subjectId) ?? {
        subjectId: -1,
        subjectNameLong: "Pause",
        subjectNameShort: "Pause",
        subjectNameSubstitution: [],
        teacherGender: "d",
        teacherNameLong: "-",
        teacherNameSubstitution: []
      };

      return {
        lessonNumber: l.lessonNumber,
        startTime: Number.parseInt(l.startTime),
        endTime: Number.parseInt(l.endTime),
        room: l.subjectId === -1 ? "-" : l.room,
        teamId: l.teamId,

        subjectId: l.subjectId,
        subjectNameLong: subject.subjectNameLong,
        subjectNameShort: subject.subjectNameShort,
        subjectNameSubstitution: subject.subjectNameSubstitution ?? [],
        teacherName:
          (subject.teacherGender === "w" ? "Frau " : "") +
          (subject.teacherGender === "m" ? "Herr " : "") +
          subject.teacherNameLong,
        teacherNameSubstitution: subject.teacherNameSubstitution ?? []
      };
    });

  let lessonsWithSubstitutions: LessonWithSubstitution[] = lessonsWithSubject;
  
  if (currentSubstitutionsData.data !== "No data") {
    let planId;
    if (isSameDay(date, dateToMs(currentSubstitutionsData.data.plan1.date) ?? 0)) {
      planId = 1;
    }
    else if (isSameDay(date, dateToMs(currentSubstitutionsData.data.plan2.date) ?? 0)) {
      planId = 2;
    }
    if (planId) {
      const substitutions = currentSubstitutionsData.data["plan" + planId as "plan1" | "plan2"].substitutions;
      for (const substitution of substitutions) {
        lessonsWithSubstitutions = lessonsWithSubstitutions.map(l => {
          if (
            matchesLessonNumber(l.lessonNumber, substitution.lesson)
            && (l.teacherNameSubstitution.includes(substitution.teacherOld) || l.subjectId === -1)
          ) {
            const substitutionSubjectId = currentSubjectData.find(s => s.subjectNameSubstitution?.includes(substitution.subject))?.subjectId ?? null;
            return {
              ...l,
              substitution: {
                ...substitution,
                subjectId: substitutionSubjectId
              }
            };
          }
          return l;
        });
      }
    }
  }

  const groupedLessonData = lessonsWithSubstitutions
    .reduce((acc: LessonGroup[], curr) => {
      const group = acc.find(l => l.lessonNumber === curr.lessonNumber);
      if (group) {
        group.lessons = [...group.lessons, curr].sort((l1, l2) => l1.subjectId - l2.subjectId);
      }
      else {
        acc.push({
          lessonNumber: curr.lessonNumber,
          startTime: curr.startTime,
          endTime: curr.endTime,
          lessons: [curr]
        });
      }
      return acc;
    }, [])
    .sort((group1, group2) => group1.lessonNumber - group2.lessonNumber);

  let lessonGroupsWithEvent: LessonGroupWithEvent[] = groupedLessonData;
    
  currentEventData.filter(e =>
    (currentJoinedTeamsData.includes(e.teamId) || e.teamId === -1) && isSameDay(e.startDate, date)
  ).forEach(e => {
    lessonGroupsWithEvent = lessonGroupsWithEvent.map(l => {
      if (matchesLessonNumber(l.lessonNumber, e.lesson ?? "")) {
        l.events = [...l.events ?? [], e].sort((e1, e2) => e1.eventId - e2.eventId);
      }
      return l;
    });
  });

  function isDoubleLesson(lg1: LessonGroup | TimetableData, lg2?: LessonGroup | TimetableData): boolean {
    function checkForSubstitutions(l1: LessonWithSubstitution, l2: LessonWithSubstitution): boolean {
      if (!(l1.substitution === undefined && l2.substitution === undefined)) {
        if (l1.substitution === undefined || l2.substitution === undefined
          || !checkKeys(l1.substitution, l2.substitution, ["subject", "teacher", "room", "type"])) return false;
      }
      return true;
    }

    function checkForEvents(l1: LessonGroupWithEvent, l2: LessonGroupWithEvent): boolean {
      if (!(l1.events === undefined && l2.events === undefined)) {
        if (l1.events === undefined || l2.events === undefined) return false;
        else {
          if (l1.events.length !== l2.events.length) return false;
          for (const i in l1.events) {
            if (l1.events[i].eventId !== l2.events[i].eventId) return false;
          }
        };
      }
      return true;
    }
    
    const checkKeys = <T>(obj1: T, obj2: T, keys: (keyof T)[]): boolean => {
      return keys.every(key => obj1[key] === obj2[key]);
    };

    if (! (lg1 && lg2)) return false;
    if (lg1.lessons.length !== lg2?.lessons.length) return false;
    if (!checkForEvents(lg1, lg2)) return false;

    for (const lessonId in lg1.lessons) {
      const l1 = lg1.lessons[lessonId];
      const l2 = lg2.lessons[lessonId];

      if (!checkKeys(l1, l2, ["subjectId", "room"])) return false;
      if (!checkForSubstitutions(l1, l2)) return false;
    }
    return true;
  }

  const multiLessonGroups: TimetableData[] = groupedLessonData.reduce((acc: TimetableData[], curr) => {
    const last = acc.at(-1);
    const isFirst = last === undefined;

    if (isFirst || ! isDoubleLesson(curr, last)) {
      acc.push({
        startLessonNumber: curr.lessonNumber,
        endLessonNumber: curr.lessonNumber,
        lessonTimes: [{startTime: curr.startTime, endTime: curr.endTime}],
        ...curr
      });
    }
    else {
      last.endLessonNumber = curr.lessonNumber;
      last.endTime = curr.endTime;
      last.lessonTimes.push({startTime: curr.startTime, endTime: curr.endTime});
    }

    return acc;
  }, []);

  return multiLessonGroups;
}

export async function getCurrentLesson(): Promise<TimetableData | undefined> {
  const now = new Date();
  const timeNow = (now.getHours() * 60 + now.getMinutes() - 5) * 60 * 1000; // Pretend it's 5min earlier, in case the lesson was just over
  const currentTimetableData = await loadTimetableData(new Date());
  return currentTimetableData.find(l => l.startTime < timeNow && l.endTime > timeNow);
}

export async function getNextLessonWithDate(subjectId: number): Promise<{lesson: SingleLessonData, date: Date, otherWeekDays: number[]} | null> {
  const currentLessonData = await lessonData();
  // The next lessons of the new selected subject
  const nextLessons = currentLessonData.filter(lesson => lesson.subjectId === subjectId);

  const now = new Date();
  let minDiff = 7;
  let minLesson: SingleLessonData | null = null;
  const otherWeekDays: number[] = [];
  for (const l of nextLessons) {
    otherWeekDays.push(l.weekDay);
    let diff = (l.weekDay - (now.getDay() - 1) + 7) % 7; // The difference in days
    if (diff === 0) diff = 7;
    if (diff <= minDiff) {
      minDiff = diff;
      minLesson = l;
    }
  }

  if (minLesson === null) return null;

  const nextLessonDate = now;
  nextLessonDate.setDate(nextLessonDate.getDate() + minDiff);
  return {
    otherWeekDays,
    lesson: minLesson,
    date: nextLessonDate
  };
}

async function loadJoinedTeamsData(settings?: {silent?: boolean}): Promise<void> {
  await user.awaitAuthed();
  if (!user.classJoined) return;

  if (user.loggedIn) {
    const res = await ajax("GET", "/api/teams/joined", { forceOffline: true });
    if (!res.ok) throw new Error("HTTP error during fetch of joinedTeams: " + res.status + " " + await res.text());
    joinedTeamsData.set(await res.json(), settings);
  }
  else {
    return new Promise<void>(res => {
      try {
        joinedTeamsData.set(JSON.parse(localStorage.getItem("joinedTeamsData") ?? "[]"), settings);
      }
      catch {
        joinedTeamsData.set([], settings);
      }
      res();
    });
  }
}

async function loadClassSubstitutionsData(): Promise<void> {
  await substitutionsData.init();

  const currentSubstitutionsData = await substitutionsData();
  if (currentSubstitutionsData.data === "No data") {
    classSubstitutionsData({data: "No data", classFilterRegex: currentSubstitutionsData.classFilterRegex});
    return;
  }

  const data = structuredClone(currentSubstitutionsData.data);
  for (let planId = 1 as 1 | 2; planId <= 2; planId++) {
    const key = ("plan" + planId) as "plan1" | "plan2";
    data[key].substitutions = data[key].substitutions.filter((entry: Record<string, string>) =>
      new RegExp(currentSubstitutionsData.classFilterRegex ?? "").test(entry.class)
    );
  }
  classSubstitutionsData({data: data, classFilterRegex: currentSubstitutionsData.classFilterRegex});
}

async function loadClassInfo(settings?: {silent?: boolean}): Promise<void> {
  await user.awaitAuthed();
  if (!user.classJoined) return;

  const res = await ajax("GET", `/api/classes/${user.classId}`, { forceOffline: true });
  classInfo.set(await res.json(), settings);
}

async function loadClassMemberData(settings?: {silent?: boolean}): Promise<void> {
  await user.awaitAuthed();
  if (!user.classJoined) return;
  
  const res = await ajax("GET",  `/api/classes/${user.classId}/members`, { forceOffline: true });
  classMemberData.set(await res.json(), settings);
}

async function loadHomeworkCheckedData(settings?: {silent?: boolean}): Promise<void> {
  await user.awaitAuthed();
  if (!user.classJoined) return;

  if (user.loggedIn) {
    // If the user is logged in, get the data from the server
    const res = await ajax("GET", "/api/homework/checked", { forceOffline: true });
    if (!res.ok) throw new Error("HTTP error during fetch of homeworkCheckedData: " + res.status + " " + await res.text());
    homeworkCheckedData.set(await res.json(), settings);
  }
  else {
    return new Promise<void>(res => {
      try {
        // If the user is not logged in, get the data from the local storage
        homeworkCheckedData.set(JSON.parse(localStorage.getItem("homeworkCheckedData") ?? "[]"), settings);
      }
      catch {
        homeworkCheckedData.set([], settings);
      }
      res();
    });
  }
}

export async function getHomeworkCheckStatus(homeworkId: number): Promise<boolean> {
  return ((await homeworkCheckedData()) ?? []).includes(homeworkId);
}

export async function checkReloadEventTypeStyles(): Promise<void> {
  if (! user.classJoined) return;
  let currentEventTypeData = (await eventTypeData());
  currentEventTypeData = currentEventTypeData.sort((a, b) => a.eventTypeId - b.eventTypeId);
  const cache = JSON.parse(localStorage.getItem("eventTypeDataCache") ?? '{"data":""}');
  const eventTypeString = JSON.stringify(Object.fromEntries(currentEventTypeData.map(e => [e.eventTypeId, e.color])));
  const version = (await bootstrap()).version;

  if (eventTypeString !== cache.data || cache.css === undefined || cache.version !== version) {
    cache.data = eventTypeString;
    cache.css = await (await fetch("/api/events/types/styles")).text();
    cache.version = version;
  }
  $("#event-type-styles").text(cache.css);
  localStorage.setItem("eventTypeDataCache", JSON.stringify(cache));
}

export function matchesLessonNumber(lessonNumber: number, testForLessonNumbers: string): boolean {
  if (testForLessonNumbers.includes("-")) {
    const [start, end] = testForLessonNumbers.replace(" ", "").split("-").map(Number);
    if (start > lessonNumber || lessonNumber > end) {
      return false;
    }
  }
  else if (Number.parseInt(testForLessonNumbers) !== lessonNumber) {
    return false;
  }
  return true;
}

export function highlightUnavailable(): void {
  $("#unavailable-hint").addClass("fa-beat");
  setTimeout(() => $("#unavailable-hint").removeClass("fa-beat"), 1500);
  $("#unavailable-popup").show();
}

export function openRequestQueueDB(): Promise<IDBDatabase> {
  return new Promise(res => {
    const db = indexedDB.open("request-queue", 1);

    db.addEventListener("upgradeneeded", () => {
      db.result.createObjectStore("queue", {
        keyPath: "id",
        autoIncrement: true
      });
    });

    db.addEventListener("success", () => {
      res(db.result);
    });
  });
}

async function queueRequest(request: Request): Promise<void> {
  const headers = Object.fromEntries(request.headers.entries());

  const serializedReq = {
    url: request.url,
    method: request.method,
    headers,
    body: await request.clone().arrayBuffer()
  };

  const db = await openRequestQueueDB();
  const tx = db.transaction("queue", "readwrite");
  const store = tx.objectStore("queue");
  store.add(serializedReq);
  
  renderRequestQueue();
}

async function getRequestDescription(req: SerializedRequest): Promise<string> {
  const richTextareaMod = await import("../snippets/richTextarea/richTextarea.js");
  function getText(text: string, isRich?: boolean): string {
    return cutString(escapeHTML((isRich ?? false) ? richTextareaMod.richTextToPlainText(text) : text), 40);
  }

  const rawBody = req.body;
  const textBody = rawBody instanceof ArrayBuffer ? new TextDecoder().decode(rawBody) : rawBody;
  let jsonBody;
  try {
    jsonBody = JSON.parse(textBody);
  }
  catch {
    jsonBody = null;
  }
  const url = new URL(req.url, globalThis.location.origin);
  let path = url.pathname.replace(/^\/api/, "");
  const ids = Array.from(
    path.matchAll(/\/(\d+)/g),
    m => Number.parseInt(m[1])
  );
  path = path.replaceAll(/\/\d+/g, "/:id");

  switch (req.method + " " + path) {
  case "POST /events": {
    return `Ereignis "${getText(jsonBody.name)}" hinzufügen`;
  }
  case "PATCH /events/:id": {
    return `Ereignis zu "${getText(jsonBody.name)}" bearbeiten`;
  }
  case "DELETE /events/:id": {
    await eventData.init();
    const name = (await eventData()).find(e => e.eventId === ids[0])?.name ?? "?";
    return `Ereignis "${getText(name)}" löschen`;
  }
  case "PATCH /events/:id/pin": {
    await eventData.init();
    const name = (await eventData()).find(e => e.eventId === ids[0])?.name ?? "?";
    return `Ereignis "${getText(name)}" ${jsonBody.pinStatus === true ? "anheften" : "lösen"}`;
  }
  case "POST /homework": {
    return `Hausaufgabe "${getText(jsonBody.content, true)}" hinzufügen`;
  }
  case "PATCH /homework/:id": {
    return `Hausaufgabe zu "${getText(jsonBody.content, true)}" bearbeiten`;
  }
  case "DELETE /homework/:id": {
    await homeworkData.init();
    const content = (await homeworkData()).find(h => h.homeworkId === ids[0])?.content ?? "?";
    return `Hausaufgabe "${getText(content, true)}" löschen`;
  }
  case "PATCH /homework/:id/check": {
    await homeworkData.init();
    const content = (await homeworkData()).find(h => h.homeworkId === ids[0])?.content ?? "?";
    return `Hausaufgabe "${getText(content, true)}" ${jsonBody.checkStatus === true ? "erledigt" : "nicht erledigt"}`;
  }
  case "PATCH /homework/:id/pin": {
    await homeworkData.init();
    const content = (await homeworkData()).find(h => h.homeworkId === ids[0])?.content ?? "?";
    return `Hausaufgabe "${getText(content, true)}" ${jsonBody.pinStatus === true ? "anheften" : "lösen"}`;
  }
  case "POST /uploads": {
    const match = /name="uploadName"\r?\n\r?\n([\s\S]*?)\r?\n------/.exec(textBody);
    const name = match ? match[1].trim() : "?";
    return `Datei "${getText(name)}" hochladen`;
  }
  case "PATCH /uploads/:id": {
    const match = /name="uploadName"\r?\n\r?\n([\s\S]*?)\r?\n------/.exec(textBody);
    const name = match ? match[1].trim() : "?";
    return `Datei zu "${getText(name)}" bearbeiten`;
  }
  case "DELETE /uploads/:id": {
    await uploadData.init();
    const name = (await uploadData()).uploads.find(u => u.uploadId === ids[0])?.uploadName ?? "?";
    return `Datei "${getText(name)}" löschen`;
  }
  case "PATCH /uploads/:id/pin": {
    await uploadData.init();
    const name = (await uploadData()).uploads.find(u => u.uploadId === ids[0])?.uploadName ?? "?";
    return `Datei "${getText(name)}" ${jsonBody.pinStatus === true ? "anheften" : "lösen"}`;
  }
  case "POST /uploads/requests": {
    return `Anfrage für Datei "${getText(jsonBody.uploadRequestName)}" hinzufügen`;
  }
  case "DELETE /uploads/requests/:id": {
    await uploadRequestsData.init();
    const name = (await uploadRequestsData()).find(u => u.uploadRequestId === ids[0])?.uploadRequestName ?? "?";
    return `Anfrage für Datei "${getText(name)}" löschen`;
  }

  case "PUT /teams/joined": {
    return "Beigetretene Teams auswählen";
  }
  case "PATCH /classes/:id/name": {
    return `Klassennamen zu ${getText(jsonBody.classDisplayName)} ändern`;
  }
  case "PATCH /classes/:id/code": {
    return "Neuen Klassencode anfordern";
  }
  case "POST /classes/:id/upgrade-test-class": {
    return "Testklasse zu normaler Klasse machen";
  }
  case "PATCH /classes/:id/default-permission": {
    return "Standardrolle der Klasse ändern";
  }
  case "DELETE /classes/:id/members": {
    return "Einige Klassenmitglieder entfernen";
  }
  case "PATCH /classes/:id/members/permissions": {
    return "Berechtigungen einiger Klassenmitglieder ändern";
  }
  case "PUT /teams": {
    return "Verfügbare Teams bearbeiten";
  }
  case "PUT /events/types": {
    return "Verfügbare Ereignisarten bearbeiten";
  }
  case "PUT /subjects": {
    return "Verfügbare Fächer bearbeiten";
  }
  case "PUT /lessons": {
    return "Stundenplan bearbeiten";
  }

  default:
    return "?";
  }
}

export async function renderRequestQueue(): Promise<void> {
  const db = await openRequestQueueDB();
  const tx = db.transaction("queue", "readwrite");
  const store = tx.objectStore("queue");
  
  const allRequest = store.getAll();
  const requests = await new Promise<({id: number} & SerializedRequest)[]>(res => {
    allRequest.addEventListener("success", () => {
      res(allRequest.result);
    });
  });
  if ($("#unavailable-queue-circle").text() === "0" && requests.length > 0) highlightUnavailable();
  $("#unavailable-queue-title, #unavailable-queue-description, #unavailable-queue-circle").toggle(requests.length > 0);
  $(".unavailable-queue-length").text(requests.length);

  const newList = $("<div></div>");
  
  for (const req of requests) {
    newList.append(`
      <li>${await getRequestDescription(req)}</li>
    `);
  }

  $("#unavailable-queue-list").empty().append(newList.children());
}

function getDirtyDataAccessor(req: SerializedRequest): DataAccessor<unknown> | null {
  const path = (new URL(req.url, globalThis.location.origin)).pathname.replace("/api", "");

  if (path === "/events/types") {
    return eventTypeData as DataAccessor<unknown>;
  }
  if (path.startsWith("/events")) {
    return eventData as DataAccessor<unknown>;
  }
  if (/\/homework\/\d+\/check/.exec(path)) {
    return homeworkCheckedData as DataAccessor<unknown>;
  }
  if (path.startsWith("/homework")) {
    return homeworkData as DataAccessor<unknown>;
  }
  if (path.startsWith("/uploads/requests")) {
    return uploadRequestsData as DataAccessor<unknown>;
  }
  if (path.startsWith("/uploads")) {
    return uploadData as DataAccessor<unknown>;
  }
  if (/\/classes\/\d+\/members/.exec(path)) {
    return classInfo as DataAccessor<unknown>;
  }
  if (path.startsWith("/classes")) {
    return classInfo as DataAccessor<unknown>;
  }
  if (path === "/teams/joined") {
    return joinedTeamsData as DataAccessor<unknown>;
  }
  if (path === "/teams") {
    return teamsData as DataAccessor<unknown>;
  }
  if (path === "/subjects") {
    return subjectData as DataAccessor<unknown>;
  }
  if (path === "/lessons") {
    return lessonData as DataAccessor<unknown>;
  }
  return null;
}

async function clearRequestQueue(): Promise<void> {
  const db = await openRequestQueueDB();
  const tx = db.transaction("queue", "readwrite");
  const store = tx.objectStore("queue");

  const allRequest = store.getAll();
  const all = await new Promise<({id: number} & SerializedRequest)[]>(res => {
    allRequest.onsuccess = () => res(allRequest.result);
  });

  const reqAndRes: {request: SerializedRequest, response: Response}[] = [];
  const dirtyData: Set<DataAccessor<unknown>> = new Set();

  for (const item of all) {
    const res = await ajax(item.method, item.url, { headers: item.headers, body: item.body, passFailedRequests: true });
    reqAndRes.push({
      request: item,
      response: res
    });
    const dirtyDataAccessor = getDirtyDataAccessor(item);
    if (dirtyDataAccessor !== null) dirtyData.add(dirtyDataAccessor);
    await new Promise<void>(res => setTimeout(res, 75));
  }

  const clearDb = await openRequestQueueDB();
  clearDb.transaction("queue", "readwrite").objectStore("queue").clear();

  await clearedRequestQueue(reqAndRes);

  if (user.classJoined) {
    for (const d of dirtyData) d.reload();
    if (! (await bootstrap()).maintenance) {
      socket.connect();
    }
  }
}

async function getResponseFailReason(req: SerializedRequest, res: Response): Promise<string> {
  const rawResBody = res.body;
  const textResBody = rawResBody instanceof ArrayBuffer ? new TextDecoder().decode(rawResBody) : rawResBody;
  const path = (new URL(req.url, globalThis.location.origin)).pathname.replace("/api", "");
  if (res.ok) return "";
  if (res.status === 401)
    return "Du hast nicht mehr die Berechtigung, diese Änderung auszuführen. "
      + "Entweder deine Rolle wurde aktualisiert oder du musst dich erneut anmelden";
  if (res.status === 500) return "Auf unserem Server ist ein Problem aufgetreten.";
  if (res.status === 404) {
    let type = "";
    if (path.startsWith("/homework")) type = "Die Hausaufgabe";
    if (path.startsWith("/events")) type = "Das Ereignis";
    if (path.startsWith("/uploads")) type = "Die Datei";
    return type + " wurde in der Zwischenzeit gelöscht.";
  }
  if (res.status === 413) {
    if (textResBody === "NGINX request size limit exceeded") {
      return "Diese Anfrage ist zu groß für unseren Server. Bitte versuche, sie in kleinere Anfragen aufzuteilen.";
    }
    if (path === "/uploads") {
      const currentUploadData = await uploadData();
      if (textResBody === "Upload limit reached: this class already has the maximum number of files allowed.") {
        return `Deine Klasse hat das Limit von ${currentUploadData.maxFilesPerClass} Dateien erreicht. Bitte lösche ältere Dateien.`;
      }
      else if (textResBody === "Class storage quota will be exceeded") {
        const totalStorage = Number.parseInt(currentUploadData.totalStorage);
        return `Deine Klasse hat das Speicherlimit von ${bytesToText(totalStorage)} erreicht. Bitte lösche ältere Dateien.`;
      }
    }
  }
  return "Ein unbekannter Fehler ist aufgetreten.";
}

export async function clearedRequestQueue(requestsAndResponses: {request: SerializedRequest, response: Response}[]): Promise<void> {
  renderRequestQueue();

  const newList = $("<div></div>");
  
  for (const reqAndRes of requestsAndResponses) {
    const req = reqAndRes.request;
    const res = reqAndRes.response;
    newList.append(`
      <li class="list-group-item d-flex align-items-center gap-2">
        <i class="fas ${res.ok ? "fa-circle-check text-success" : "fa-circle-xmark text-danger"} ms-n1"
          role="img" aria-label="${res.ok ? "Erfolgreich" : "Fehler"}"></i>
        <div>
          ${await getRequestDescription(req)}
          <div class="form-text text-danger mt-0">${await getResponseFailReason(req, res)}</div>
        </div>
      </li>
    `);
  }

  $("#request-queue-cleared-modal-list").empty().append(newList.children());

  if (requestsAndResponses.length > 0) $("#request-queue-cleared-modal").modal("show");
}

export async function ajax(method: string, url: string, options?: AjaxOptions): Promise<Response> {
  const {
    body,
    headers = {},
    queueable = false,
    forceOffline = false,
    passFailedRequests = false,
    expectedErrors = []
  } = options ?? {};
  
  const mergedHeaders = new Headers(headers);
  mergedHeaders.set("Accept", "application/json");
  mergedHeaders.set("X-CSRF-Token", await csrfToken());
  mergedHeaders.set("X-API-Version", (await bootstrap()).version);

  const fetchOptions: RequestInit = {
    method,
    headers: mergedHeaders
  };

  if (body) {
    if (Object.getPrototypeOf(body) === Object.prototype) {
      mergedHeaders.set("Content-Type", "application/json");
      fetchOptions.body = JSON.stringify(body);
    }
    else if (body instanceof FormData || body instanceof ArrayBuffer) {
      fetchOptions.body = body;
    }
  }

  const req = new Request(url, fetchOptions);

  const b = await bootstrap();
  if ((b.online && !b.maintenance) || forceOffline) {
    const timeout = setTimeout(() => {
      $("#error-request-timeout-toast").toast("show");
    }, 5000);

    const res = await fetch(req.clone());
    
    clearTimeout(timeout);

    if (!res.ok && !passFailedRequests) {
      const text = await res.clone().text();

      const error: AjaxError = {
        status: res.status,
        responseText: text
      };

      if (res.status === 500) {
        $("#error-server-toast").toast("show");
        throw error;
      }
      else if (res.status === 413 && text === "NGINX request size limit exceeded") {
        $("#nginx-size-limit-toast").toast("show");
        throw error;
      }
      else if (res.status === 503) {
        highlightUnavailable();
      }
      else if (expectedErrors.some(exp => exp.status === error.status && exp.responseText === error.responseText)) {
        throw error;
      }
      else {
        $("#unknown-error-toast").toast("show");
        $("#unknown-error-toast-copy").off("click").on("click", async function () {
          const textToCopy = 
            `Fetching ${method} ${url} returned an unexpected error: ${res.status} ${res.statusText}\n\n` +
            "Request body:\n" +
            await req.clone().text() + "\n\n" +
            "Response body:\n" +
            await res.clone().text() + "\n\n";
            
          try {
            await navigator.clipboard.writeText(textToCopy);
            
            makeButtonShowCheck($(this), 1000);
            setTimeout(() => {
              $("#unknown-error-toast").toast("hide");
            }, 1000);
          }
          catch (err) {
            console.error("Error copying unknown error to clipboard: ", err);
          }
        });
        throw error;
      }
    }

    return res;
  }
  else if (queueable === true) {
    await queueRequest(req);
    return new Response("Request queued, waiting for the network to become available", { status: 202 });
  }
  else {
    highlightUnavailable();
    return new Response("Request cannot be queued and no network available", { status: 503 });
  }
}

export async function renderAll(): Promise<void> {
  if (!setRenderOnUserChangeListener) {
    setRenderOnUserChangeListener = true;
  }
  const s = getSite();
  const mod = await import(`../../pages/${s}/${s}.js`);
  if (mod.renderAllFn) {
    await mod.renderAllFn();
  }
  $("body").css({ display: "flex" });
}
let setRenderOnUserChangeListener = false;

export async function reloadAll(): Promise<void> {
  for (const d of socketDataAccessors) await d.reload({ silent: true });
  await renderAll();
}

// Global socket variable that can be accessed from any script
export const socket = io({
  autoConnect: false
});

export enum ColorTheme {
  DARK = "dark",
  LIGHT = "light"
};
export const colorTheme = createDataAccessor<ColorTheme>("colorTheme");

// Data accessors
export function createDataAccessor<DataType>(name: string, config?: {
  reload?: string | ((settings?: {silent?: boolean}) => Promise<void>)
}): DataAccessor<DataType> {
  let data: DataType | null = null;
  const _eventListeners = {} as Record<DataAccessorEventName, DataAccessorEventCallback[]>;
  let _initialized = false;
  
  const reload = config?.reload;

  const reloadFunction = typeof reload === "string" ? async (settings?: {silent?: boolean}) => {
    const res = await ajax("GET", reload, { forceOffline: true });
    if (res.redirected) {
      accessor.set(null, settings);
      return;
    }
    try {
      accessor.set(await res.clone().json(), settings); 
    }
    catch {
      console.warn(
        `Getting the value for the data accessor %c${name}%c produced invalid JSON: `,
        "font-weight: bold",
        "font-weight: normal",
        res.clone()
      );
    }
  } : reload ?? null;

  const accessor = async (value?: DataType | null): Promise<DataType> => {
    if (value !== undefined) {
      accessor.set(value);
    }
    return accessor.get();
  };

  accessor.get = () => {
    if (data !== null) {
      return Promise.resolve(data);
    }

    return new Promise<DataType>(resolve => {
      const handler = (): void => {
        if (data !== null) {
          accessor.off("change", handler);
          resolve(data);
        }
      };

      accessor.on("change", handler);
    });
  };

  accessor.getCurrent = () => {
    return data;
  };

  accessor.set = (value: DataType | null, settings?: {silent?: boolean}) => {
    data = value;
    if (!settings?.silent) {
      accessor.trigger("update");
    }
    accessor.trigger("change");
    _initialized = true;
    return accessor;
  };

  accessor.on = (event: DataAccessorEventName, callback: DataAccessorEventCallback) => {
    _eventListeners[event] ??= [];
    _eventListeners[event].push(callback);
    return accessor;
  };

  accessor.off = (event: DataAccessorEventName, callback?: DataAccessorEventCallback) => {
    if (!_eventListeners[event]) return accessor;

    _eventListeners[event] = callback ? _eventListeners[event].filter(cb => cb !== callback) : [];

    return accessor;
  };

  accessor.trigger = (event: DataAccessorEventName, ...args: unknown[]) => {
    const callbacks = _eventListeners[event];
    if (callbacks) {
      for (const cb of callbacks) cb(...args);
    }
    return accessor;
  };

  accessor.reload = async (settings?: {silent?: boolean}) => {
    if (typeof reloadFunction === "function") {
      data = null;
      await reloadFunction(settings);
      _initialized = true;
    }
    else {
      console.warn(
        `No reload function for the data accessor %c${name}%c defined! Either define one or do not call .reload().`,
        "font-weight: bold",
        "font-weight: normal"
      );
    };
    return accessor;
  };

  accessor.init = async () => {
    if (!_initialized) {
      if (typeof reloadFunction === "function") {
        data = null;
        await reloadFunction();
        _initialized = true;
      }
      else {
        console.warn(
          `No reload function for the data accessor %c${name}%c defined! Either define one or do not call .init().`,
          "font-weight: bold",
          "font-weight: normal"
        );
      };
    }
    return accessor;
  };

  accessor.isInitialized = () => {
    return _initialized;
  };

  return accessor;
}

const socketDataAccessors: DataAccessor<unknown>[] = [];
export function createSocketDataAccessor<DataType>(name: string, socketEv: string, config?: {
  reload?: string | ((settings?: {silent?: boolean}) => Promise<void>)
}): SocketDataAccessor<DataType> {
  const accessor = createDataAccessor<DataType>(name, config);

  socketDataAccessors.push(accessor as DataAccessor<unknown>);

  socket.on(socketEv, () => {
    accessor.reload();
  });

  return accessor;
}

// User
export const user = {
  isAuthed: false as boolean,
  loggedIn: null as boolean | null,
  username: "" as string,
  classJoined: null as boolean | null,
  permissionLevel: 0 as number,
  classId: 0 as number,
  accountId: 0 as number,
  changeEvents: 0,

  _eventListeners: {} as Record<UserEventName, UserEventCallback[]>,
  _authAwaits: [] as ((value: void) => void)[],

  async auth(settings?: {silent?: boolean}) {
    const res = await ajax("GET", "/api/account/auth", { forceOffline: true });
    if (!res.ok) throw new Error("HTTP error during auth: " + res.status + " " + await res.text());
    const json = await res.json();

    user.isAuthed = true;
  
    user.loggedIn = json.loggedIn;
    user.username = json.account?.username ?? "";
    user.classJoined = json.classJoined;
    user.permissionLevel = json.permissionLevel ?? 0;
    user.classId = json.classId;
    user.accountId = json.account?.accountId ?? "";

    user.changeEvents++;
    this._authAwaits.forEach(res => res());
    user.trigger("change", settings);
  },

  async awaitAuthed() {
    if (this.isAuthed) return;
    return new Promise<void>(res => {
      this._authAwaits.push(res);
    });
  },

  on(event: UserEventName, callback: UserEventCallback) {
    if (!this._eventListeners[event]) {
      this._eventListeners[event] = [];
    }
    this._eventListeners[event].push(callback);
    return this;
  },

  off(event: UserEventName) {
    this._eventListeners[event] = [];
    return this;
  },

  trigger(event: UserEventName, ...args: unknown[]) {
    for (const cb of this._eventListeners[event] ?? []) {
      cb(...args);
    }
    return this;
  }
};

// CSRF token
export const csrfToken = createDataAccessor<string>("csrfToken");

// Bootstrap
export const bootstrap = createDataAccessor<Bootstrap>("bootstrap");

// Show all uploads
export const unsavedChanges = createDataAccessor<boolean>("unsavedChanges");
unsavedChanges(false);

// Resources
export const classInfo = createSocketDataAccessor<ClassInfo>("classInfo", "updateClassInfo", {
  reload: loadClassInfo
});
export const classMemberData = createSocketDataAccessor<ClassMemberData>("classMemberData", "updateMembers", {
  reload: loadClassMemberData
});
export const classSubstitutionsData = createDataAccessor<SubstitutionsData>("classSubstitutionsData", {
  reload: loadClassSubstitutionsData
});
export const eventData = createSocketDataAccessor<EventData>("eventData", "updateEvents", {
  reload: "/api/events"
});
export const eventTypeData = createSocketDataAccessor<EventTypeData>("eventTypeData", "updateEventTypes", {
  reload: "/api/events/types"
});
export const homeworkData = createSocketDataAccessor<HomeworkData>("homeworkData", "updateHomework", {
  reload: "/api/homework"
});
export const homeworkCheckedData = createSocketDataAccessor<HomeworkCheckedData>("homeworkCheckedData", "updateCheckedHomework", {
  reload: loadHomeworkCheckedData
});
export const joinedTeamsData = createSocketDataAccessor<JoinedTeamsData>("joinedTeamsData", "updateJoinedTeams", {
  reload: loadJoinedTeamsData
});
export const lessonData = createSocketDataAccessor<LessonData>("lessonData", "updateTimetables", {
  reload: "/api/lessons"
});
export const subjectData = createSocketDataAccessor<SubjectData>("subjectData", "updateSubjects", {
  reload: "/api/subjects"
});
export const substitutionsData = createDataAccessor<SubstitutionsData>("substitutionsData", {
  reload: "/api/substitutions"
});
export const teamsData = createSocketDataAccessor<TeamsData>("teamsData", "updateTeams", {
  reload: "/api/teams"
});
export const uploadData = createSocketDataAccessor<UploadData>("uploadData", "updateUploads", {
  reload: "/api/uploads"
});
export const uploadRequestsData = createSocketDataAccessor<UploadRequestsData>("uploadRequestsData", "updateUploadRequests", {
  reload: "/api/uploads/requests"
});

async function onUnavailable(): Promise<void> {
  $("#unavailable-hint").show();
  $("#unavailable-popup").show();
  const b = await bootstrap();
  const available = b.online && !b.maintenance;
  $("#navbar-reload-button").toggle(isSite("uploads", "homework", "main", "events", "settings") && available);
  $("#login-register-button").toggle(!user.loggedIn && !isSite("join") && available);
  $("#nav-logout-button").toggle((user.loggedIn ?? false) && available);
  socket.disconnect();

  const db = await openIndexedDB();
  const lastUpdatedReq = db.transaction("meta", "readwrite").objectStore("meta").get("lastUpdated");
  const lastUpdated: number = await new Promise(res => {
    lastUpdatedReq.onsuccess = () => res(lastUpdatedReq.result);
  });
  $("#unavailable-popup-last-updated").html("<b>Stand: </b>" + getDisplayDate(lastUpdated, {
    relativeDirection: RelativeDirection.PAST, alwaysDate: false, withTime: true
  }));
}

async function onOffline(): Promise<void> {
  const b = await bootstrap();
  b.online = false;
  await bootstrap(b);
  $(".unavailable-offline").show();
  $(".unavailable-maintenance").hide();
  onUnavailable();
}

async function onOnline(): Promise<void> {
  const b = await bootstrap();
  b.online = true;
  await bootstrap(b);
  if (b.maintenance) {
    $(".unavailable-offline").hide();
    $(".unavailable-maintenance").show();
    return;
  }

  $("#unavailable-hint").hide();
  $("#unavailable-popup").hide();
  const available = b.online && !b.maintenance;
  $("#navbar-reload-button").toggle(isSite("uploads", "homework", "main", "events", "settings") && available);
  $("#login-register-button").toggle(!user.loggedIn && !isSite("join") && available);
  $("#nav-logout-button").toggle((user.loggedIn ?? false) && available);
  if (! user.classJoined && isSite("main", "events", "homework", "uploads")) {
    document.location.href = "/join" + document.location.search;
  }
  clearRequestQueue();
}

function toggleScrollFade(el: HTMLElement): void {
  const toBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  el.style.setProperty("--fade-progress", Math.min(48, toBottom) + "px");
}

export async function init(): Promise<void> {
  try {
    const res = await fetch("/csrf-token");
    if (!res.ok) {
      console.error(`initCSRF: Failed to fetch token - status: ${res.status}`);
    }
    const data = await res.json();
    csrfToken(data.csrfToken);
  }
  catch (error) {
    console.error("initCSRF: Error fetching token:", error);
  }

  try {
    const res = await fetch("/bootstrap");

    if (!res.ok) {
      console.error(`bootstrap: Failed to fetch - status: ${res.status}`);
    }
    const data = await res.json();
    data.online ??= true;
    bootstrap(data);

    if (data.maintenance) {
      $(".unavailable-offline").hide();
      $(".unavailable-maintenance").show();
      renderRequestQueue();
      onUnavailable();
    }

    await user.auth();
    user.on("change", reloadAll);
    if (data.online) {
      await onOnline();
    }
    else {
      renderRequestQueue();
      await onOffline();
    }
  }
  catch (error) {
    console.error("Error fetching bootstrap:", error);
  }

  const searchParams = new URLSearchParams(location.search);
  if (searchParams.has("legacy_origin")) {
    $("#legacy-origin-toast").toast("show");
    searchParams.delete("legacy_origin");
    const newUrl = new URL(location.href);
    newUrl.search = searchParams.toString();
    history.replaceState(null, "", newUrl);
  }

  eventTypeData.on("change", checkReloadEventTypeStyles);

  $(document).on("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      if ((await bootstrap()).online) reloadAll();
    }
  });

  $(globalThis).on("offline", onOffline);
  $(globalThis).on("online", onOnline);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js");
    window.addEventListener("load", async () => {
      navigator.serviceWorker.register("/sw.js");
    });
    navigator.serviceWorker.addEventListener("message", ev => {
      console.log("Received msg", ev.data);
    });
  }

  const themeColor = document.createElement("meta");
  themeColor.name = "theme-color";
  if (localStorage.getItem("colorTheme") === ColorTheme.DARK) {
    colorTheme(ColorTheme.DARK);
  }
  else if (localStorage.getItem("colorTheme") === ColorTheme.LIGHT) {
    colorTheme(ColorTheme.LIGHT);
  }
  else if (globalThis.matchMedia("(prefers-color-scheme: dark)").matches) {
    colorTheme(ColorTheme.DARK);
  }
  else {
    colorTheme(ColorTheme.LIGHT);
  }
  if ((await colorTheme()) === ColorTheme.LIGHT) {
    themeColor.content = "#f8f9fa";
  }
  else {
    document.getElementsByTagName("html")[0].style.background = "#212529";
    themeColor.content = "#2b3035";
  }

  document.head.appendChild(themeColor);

  $("body").attr("data-animations", localStorage.getItem("animations") ?? "true");

  $('[data-bs-toggle="tooltip"]').tooltip();
  new MutationObserver(mutationsList => {
    for (const mutation of mutationsList) {
      $(mutation.addedNodes).each(function () {
        $(this).find('[data-bs-toggle="tooltip"]').tooltip();
        $(this).filter('[data-bs-toggle="tooltip"]').tooltip();
      });
    };
  }).observe(document.body, {
    childList: true,
    subtree: true
  });

  $(document).on("shown.bs.toast", ev => {
    const $toast = $(ev.target);
    if ($toast.attr("data-bs-autohide") === "false") {
      return;
    }

    const $bar = $toast.find(".toast-progress-bar");
    if (!$bar.length) return;

    $bar.addClass("playing");

    $toast.on("mouseenter.toastProgress", () => {
      $bar.removeClass("playing");
    });

    $toast.on("mouseleave.toastProgress", () => {
      setTimeout(() => {
        $bar.addClass("playing");
      }, 1000);
    });

    $toast.one("hidden.bs.toast", () => $toast.off(".toastProgress"));
  });

  // Update everything on clicking the reload button
  $(document).on("click", "#navbar-reload-button", async function () {
    $(this).find("i").addClass("fa-spin");
    await reloadAll();
    $(this).find("i").removeClass("fa-spin fa-rotate").addClass("fa-check text-success");
    $(this).prop("disabled", true);
    setTimeout(() => {
      $(this).find("i").addClass("fa-rotate").removeClass("fa-check text-success");
      $(this).prop("disabled", false);
    }, 1000);
  });

  // Change btn group selections to vertical / horizontal
  const smallScreenQuery = globalThis.matchMedia("(max-width: 575px)");

  function handleSmallScreenQueryChange(): void {
    if (smallScreenQuery.matches) {
      $(".btn-group-dynamic").removeClass("btn-group").addClass("btn-group-vertical");
    }
    else {
      $(".btn-group-dynamic").addClass("btn-group").removeClass("btn-group-vertical");
    }
  }

  smallScreenQuery.addEventListener("change", handleSmallScreenQueryChange);
  $(globalThis).on("pushstate", handleSmallScreenQueryChange);

  handleSmallScreenQueryChange();

  (async () => {
    if ((await colorTheme()) === ColorTheme.LIGHT) {
      $("body").attr("data-bs-theme", ColorTheme.LIGHT);
    }
    else {
      $("body").attr("data-bs-theme", ColorTheme.DARK);
    }

    if (localStorage.getItem("fontSize") === "1") {
      $("html").css("font-size", "19px");
    }
    else if (localStorage.getItem("fontSize") === "2") {
      $("html").css("font-size", "22px");
    }

    $("body").attr("data-high-contrast", localStorage.getItem("highContrast"));
  })();

  if (!isSite("settings")) {
    const colorThemeSetting = localStorage.getItem("colorTheme") ?? "auto";

    if (colorThemeSetting === "auto") {
      async function updateColorTheme(): Promise<void> {
        if (globalThis.matchMedia("(prefers-color-scheme: dark)").matches) {
          colorTheme(ColorTheme.DARK);
        }
        else {
          colorTheme(ColorTheme.LIGHT);
        }

        if ((await colorTheme()) === ColorTheme.LIGHT) {
          document.getElementsByTagName("html")[0].style.background = "#ffffff";
          document.body.dataset.bsTheme = ColorTheme.LIGHT;
          $('meta[name="theme-color"]').attr("content", "#f8f9fa");
        }
        else {
          document.getElementsByTagName("html")[0].style.background = "#212529";
          document.body.dataset.bsTheme = ColorTheme.DARK;
          $('meta[name="theme-color"]').attr("content", "#2b3035");
        }
      }

      globalThis.matchMedia("(prefers-color-scheme: light)").addEventListener("change", updateColorTheme);
      globalThis.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateColorTheme);
    }
  }

  $(document).on("input", ".is-autocompleted", function () {
    $(this).removeClass("is-autocompleted");
  });

  $(document).on("focus", 'input[type="text"].is-autocompleted', function () {
    $(this).val("").removeClass("is-autocompleted");
  });

  function initScrollFade(el: HTMLElement): void {
    toggleScrollFade(el);

    new ResizeObserver(() => toggleScrollFade(el)).observe(el);

    $(el).on("scroll", () => {
      toggleScrollFade(el);
    });
  }

  $(".scroll-fade").each(function () {
    initScrollFade(this);
  });

  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;

        if (node.matches(".scroll-fade")) {
          initScrollFade(node);
        }

        node.querySelectorAll?.(".scroll-fade").forEach(el => initScrollFade(el as HTMLElement));
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}
