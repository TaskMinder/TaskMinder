export const __placeholder;

type AjaxError = {
  status: number;
  responseText: string;
}

type AjaxOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  queueable?: boolean;
  forceOffline?: boolean;
  passFailedRequests?: boolean;
  expectedErrors?: AjaxError[];
}

type SerializedRequest = {
  url: string,
  method: string,
  headers: Record<string, string>,
  body: ArrayBuffer
}

type RawDate = number | string | Date

// Month Dates
type MonthDates = Date[][];

export type UserEventName = "change";
export type UserEventCallback = (...args: unknown[]) => void;

type Bootstrap = { version: string, maintenance: boolean, online: boolean }

// Data Accessors
type DataAccessorEventName = "update" | "change";
type DataAccessorEventCallback = (...args: unknown[]) => void;
type DataAccessor<DataType> = {
  (value?: DataType | null): Promise<DataType>;
  get(): Promise<DataType>;
  getCurrent(): DataType | null;
  set(value: DataType | null, settings?: {silent?: boolean}): DataAccessor<DataType>;
  on(event: DataAccessorEventName, callback: DataAccessorEventCallback): DataAccessor<DataType>;
  trigger(event: DataAccessorEventName, ...args: unknown[]): DataAccessor<DataType>;
  reload(settings?: {silent?: boolean}): Promise<DataAccessor<DataType>>;
  init(): Promise<DataAccessor<DataType>>;
  isInitialized(): boolean;
}
type SocketDataAccessor<DataType> = DataAccessor<DataType>;

//  ╭───────────╮
//  │ RESOURCES │
//  ╰───────────╯

// Class Info
type ClassInfo = {
  classCode: string;
  className: string;
  isTestClass: boolean;
  createdAt: string;
  defaultPermission: number;
}

// Class Members
type ClassMemberPermissionLevel = 0 | 1 | 2 | 3
type ClassMemberData = {
  accountId: number;
  username: string;
  permissionLevel: ClassMemberPermissionLevel | null;
}[];

// Events
type SingleEventData = {
  eventId: number;
  eventTypeId: number;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  lesson: string | null;
  teamId: number;
  isPinned: boolean;
  accountId: number | null;
};
type EventData = SingleEventData[];

// Event Types
type EventTypeData = {
  eventTypeId: number;
  name: string;
  color: string;
}[];

// Homework
type SingleHomeworkData = {
  homeworkId: number;
  content: string;
  subjectId: number;
  assignmentDate: string;
  submissionDate: string;
  teamId: number;
  isPinned: boolean;
  accountId: number | null;
};
type HomeworkData = SingleHomeworkData[];

// Homework Checked
type HomeworkCheckedData = number[];

// Joined Teams
type JoinedTeamsData = number[];

// Lessons
type SingleLessonData = {
  lessonId: number;
  lessonNumber: number;
  weekDay: 0 | 1 | 2 | 3 | 4;
  teamId: number;
  subjectId: number;
  room: string;
  startTime: string;
  endTime: string;
};
type LessonData = SingleLessonData[];

// Subjects
type SubjectData = {
  subjectId: number;
  subjectNameLong: string;
  subjectNameShort: string;
  subjectNameSubstitution: string[] | null;
  teacherGender: "d" | "w" | "m";
  teacherNameLong: string;
  teacherNameShort: string;
  teacherNameSubstitution: string[] | null;
  teamId: number;
}[];

// Substitutions
type SubstitutionEntry = {
  class: string;
  lesson: string;
  room: string;
  subject: string;
  teacher: string;
  teacherOld: string;
  text: string;
  time: string;
  type: string;
}
type SubstitutionPlan = {
  date: string;
  substitutions: SubstitutionEntry[]
};
type SubstitutionsData = {
  data: "No data" | {
    plan1: SubstitutionPlan;
    plan2: SubstitutionPlan;
    updated: string;
  };
  classFilterRegex: string | null;
};

// Teams
type TeamsData = {
  teamId: number;
  name: string;
}[];

// Timetable
type LessonWithSubject = {
  lessonNumber: number;
  subjectId: number,
  subjectNameLong: string;
  subjectNameShort: string;
  subjectNameSubstitution: string[];
  teacherName: string;
  teacherNameSubstitution: string[];
  room: string;
  startTime: number;
  endTime: number;
  teamId: number;
};
type LessonWithSubstitution = LessonWithSubject & {
  substitution?: SubstitutionEntry & { subjectId: number | null }
};
type LessonGroup = {
  lessonNumber: number;
  startTime: number;
  endTime: number;
  lessons: LessonWithSubstitution[];
};
type LessonGroupWithEvent = LessonGroup & {
  events?: SingleEventData[]
};
type TimetableData = LessonGroupWithEvent & {
  startLessonNumber: number;
  endLessonNumber: number;
  lessonTimes: {
    startTime: number;
    endTime: number;
  }[]
};

// Uploads
type SingleUploadData = {
  uploadId: number;
  uploadName: string;
  uploadDescription: string | null;
  uploadType: string;
  teamId: number;
  status: string;
  errorReason: string | null;
  accountName: string | null;
  filesCount: number;
  createdAt: string;
  isPinned: boolean;
  files: {
    fileMetaDataId: 1;
    mimeType: string;
    size: number;
    createdAt: string;
  }[]
}

type UploadData = {
  totalUploads: number;
  totalStorage: string;
  usedStorage: string;
  sizeLimitPerFile: number;
  maxFilesPerClass: number;
  uploads: SingleUploadData[];
}

type UploadRequestsData = {
  uploadRequestId: number;
  uploadRequestName: string;
  classId: number;
  teamId: number;
}[]
