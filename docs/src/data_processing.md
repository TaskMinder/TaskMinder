# Data Processing

## Introduction

This document provides a comprehensive overview of data processing practices for our educational management system. As part of our commitment to data protection and privacy compliance (GDPR/DSGVO), we document what personal and operational data is intentionally collected, stored, and processed, as well as identify potential unintentional data capture points across all system tables.

### Scope

This documentation describes all database tables defined in the current Prisma schema, with particular attention to the processing of personal data and related privacy implications. It also details the data stored in the Redis-powered cache, as well as the information collected during server monitoring (logs).

---

## Data Processing Analysis by Table

### 1. Account Table

**Purpose**: User authentication and access management.

| Field     | Data Type | Intentionally Stored                | Potentially Unintentional                            |
| :-------- | :-------- | :---------------------------------- | :--------------------------------------------------- |
| accountId | Integer   | Unique user identifier              | Could enable cross-system tracking                   |
| username  | String    | **Personal identifier** for login   | May reveal real names or personal info               |
| password  | String    | Encrypted authentication credential | Hash algorithms may become vulnerable                |
| createdAt | BigInt    | Account creation timestamp          | -                                                    |
| deletedAt | BigInt    | Account deletion timestamp          | -                                                    |
| bannedAt  | BigInt?   | Time of a moderation ban            | Records a moderation decision against the user       |
| banGround | Enum?     | Ground of a ban: `terms` (terms of use no. 3) or `illegal` | Records a moderation decision against the user |
| banReason | String?   | Statement of reasons shown to the banned user | May describe the user's misconduct          |

**Privacy Concerns**:

- Usernames might contain real names or other identifying information.
- Password security is critically dependent on the strength and implementation of the hashing algorithm.
- Personal data (`username`, `password`) is retained after the user has initiated deletion, creating a risk if the cleanup process fails.
- `bannedAt`, `banGround` and `banReason` are a moderation decision about the user and are deleted with the account. A banned account can still log in, log out and delete itself; everything else is refused with the statement of reasons.

**Solutions**:

- Hashing using bcrypt: bcrypt automatically generates a unique random salt per password, making rainbow table attacks ineffective. We use a sufficient number of salt rounds (`SALT_ROUNDS = 10`).
- Implemented a robust, automated cron job to ensure permanent deletion after the 30-day period.

---

### 2. Class Table

**Purpose**: Defines a class, acting as a central hub for all related data like students, subjects, events, homework and upload data.

| Field                  | Data Type | Intentionally Stored                           | Potentially Unintentional                                    |
| :--------------------- | :-------- | :--------------------------------------------- | :----------------------------------------------------------- |
| classId                | Integer   | Unique class identifier                        | -                                                            |
| className              | String    | The name of the class                          | May identify a specific group of students                    |
| classCode              | String    | Unique encrypted code for students to join the class     | Could lead to abusive joins if class code is breached        |
| classCodeHash          | String    | Unique hashed code for students to join the class (fast lookup)    | Could lead to abusive joins if class code is breached        |
| createdAt              | BigInt    | Timestamp of class creation                    | -                                                            |
| isTestClass            | Boolean   | Flag to identify test/demo classes             | -                                                            |
| defaultPermissionLevel | Integer   | Default user permission level for new members  | -                                                            |
| storageUsedBytes       | BigInt    | Current storage usage by the class             | May reveal class activity level and content volume           |
| storageQuotaBytes      | BigInt    | Storage limit allocated to the class           | -                                                            |
| dsbMobileActivated     | Boolean   | Flag if DSBMobile is active                    | -                                                            |
| dsbMobileUser          | String    | **Third-party service username (DSB Mobile)**  | **Risk**: Credentials for external system                    |
| dsbMobilePassword      | String    | **Third-party service password (DSB Mobile)**  | **Risk**: Enables account compromise                         |
| dsbMobileClass         | String    | Class Name to filter in substitution data      | May identify the specific class                              |


**Privacy Concerns**:
- `Class` centralizes all student data, making profile-building easier.

**Solutions**:
- Implemented change class code function/button for class members.
- Implemented strict access controls for rows containing third-party credentials.
- Implemented secure (aes-256-gcm) server-side encryption for class codes, 3rd-party (DSB Mobile) migration coming soon

---

### 3. Event & EventType Tables

**Purpose**: Management of class-specific events (e.g., exams, holidays) and their categories.

| Table.Field             | Data Type | Intentionally Stored                       | Potentially Unintentional                                                  |
| :---------------------- | :-------- | :----------------------------------------- | :------------------------------------------------------------------------- |
| Event.eventId           | Integer   | Unique event identifier                    | -                                                                          |
| Event.classId           | Integer   | Links event to a specific class            | -                                                                          |
| Event.eventTypeId       | Integer   | Links event to a specific event type       | -                                                                          |
| Event.name / desc.      | String    | Event title and details                    | **Risk**: May contain personal info (student names, sensitive topics)      |
| Event.isPinned          | Boolean   | Event pinning                              | -                                                                          |
| Event.startDate/endDate | BigInt    | Event scheduling                           | Reveals attendance/activity patterns                                       |
| Event.lesson            | String    | Specific lesson block reference            | -                                                                          |
| Event.teamId            | Integer   | Links event to a specific team             | Reveals group-specific activities                                          |
| Event.accountId         | Integer?  | Owner account for private events; `null` for shared events | Links private event data to a specific user; may enable activity profiling |
| Event.createdAt         | BigInt    | Record creation timestamp                  | -                                                                          |
| Event.authorAccountId   | Integer?  | Private authorship for moderation: account that created the event, never changes; `null` after an anonymous create | Links shared content to the person who wrote it |
| Event.lastEditorAccountId | Integer? | Private authorship for moderation: last account that created or edited the event; `null` after an anonymous edit | Links shared content to the person who last changed it |
| EventType.eventTypeId   | Integer   | Unique event type identifier               | -                                                                          |
| EventType.classId       | Integer   | Links type to a specific class             | -                                                                          |
| EventType.name          | String    | Category name (e.g., "Exam", "Field Trip") | Adds context that could have privacy implications (e.g., "Detention")      |
| EventType.color         | String    | Event type color configuration             | -                                                                          |
| EventType.createdAt     | BigInt    | Record creation timestamp                  | -                                                                          |

**Privacy Concerns**:

- Free-text fields (`name`, `description`) are high-risk for unintentional storage of personal data.
- The combination of event data, when linked to a `Class`, can reveal detailed schedules and activities for a specific group of students.
- For private events, `accountId` links the event and its contents to the owning account and restricts visibility to that user.
- `authorAccountId` and `lastEditorAccountId` record who created and who last changed an event. They are never returned by the API, are not part of the cached event data in Redis and are set to `null` when the account is permanently deleted.

**Solutions**:

- Provided clear guidance or input masks to discourage users from entering personal data in event names and descriptions.
- Regularly audit event data for inappropriate content.

---

### 4. Homework & HomeworkCheck Tables

**Purpose**: Management of homework assignments and tracking student completion.

| Table.Field              | Data Type | Intentionally Stored   | Potentially Unintentional                                            |
| :----------------------- | :-------- | :--------------------- | :------------------------------------------------------------------- |
| Homework.homeworkId      | Integer   | Assignment identifier  | -                                                                    |
| Homework.classId         | Integer   | Links homework to a specific class | -                                                        |
| Homework.isPinned        | Boolean   | Homework pinning       | -                                                                    |
| Homework.content         | String    | Assignment details     | May contain student-specific instructions or references              |
| Homework.subjectId       | Integer   | Links homework to a specific subject | -                                                      |
| Homework.assignmentDate  | BigInt    | Assignment date        | Reveals grading/teaching pacing                                      |
| Homework.submissionDate  | BigInt    | Deadline management    | Reveals individual work patterns                                     |
| Homework.teamId          | Integer   | Links homework to a specific team  | Reveals team-based assignments                           |
| Homework.accountId       | Integer?  | Owner account for private homework; `null` for shared homework | Links private homework to a specific user; may enable activity profiling |
| Homework.createdAt       | BigInt    | Record creation timestamp | -                                                                 |
| Homework.authorAccountId | Integer? | Private authorship for moderation: account that created the homework, never changes; `null` after an anonymous create | Links shared content to the person who wrote it |
| Homework.lastEditorAccountId | Integer? | Private authorship for moderation: last account that created or edited the homework; `null` after an anonymous edit | Links shared content to the person who last changed it |
| HomeworkCheck.checkId    | Integer   | Unique check identifier| -                                                                    |
| HomeworkCheck.accountId  | Integer   | Student identifier     | Direct link to student performance                                   |
| HomeworkCheck.homeworkId | Integer   | Assignment reference   | Creates detailed academic profile when combined with `accountId`     |
| HomeworkCheck.createdAt  | BigInt    | Record creation timestamp | -                                                                 |

**Privacy Concerns**:

- The `HomeworkCheck` table creates a direct, persistent record of individual student performance and behavior (completion status).
- This data is highly valuable for academic analytics but is privacy-sensitive and can be used for student profiling.
- For private homework, `accountId` links the assignment and its contents to the owning account and restricts visibility to that user.
- `authorAccountId` and `lastEditorAccountId` record who created and who last changed a homework entry. They are never returned by the API, are not part of the cached homework data in Redis and are set to `null` when the account is permanently deleted.

---

### 5. JoinedClass & JoinedTeams Tables

**Purpose**: Manage the relationship between `Account`s and the `Class` or `Team` they belong to.

| Table.Field                 | Data Type | Intentionally Stored                 | Potentially Unintentional                              |
| :-------------------------- | :-------- | :----------------------------------- | :----------------------------------------------------- |
| JoinedClass.joinedClassId   | Integer   | Unique joined class identifier       | -                                                      |
| JoinedClass.accountId       | Integer   | Student/user identifier              | Links a specific user to a class                       |
| JoinedClass.classId         | Integer   | Class identifier                     | -                                                      |
| JoinedClass.permissionLevel | Integer   | User's role/permissions in the class | -                                                      |
| JoinedClass.createdAt       | BigInt    | Record creation timestamp            | -                                                      |
| JoinedTeams.joinedTeamId    | Integer   | Unique joined team identifier        | -                                                      |
| JoinedTeams.accountId       | Integer   | Student/user identifier              | Creates social network mapping within a class          |
| JoinedTeams.teamId          | Integer   | Group association                    | Could reveal social connections and group dynamics     |
| JoinedTeams.createdAt       | BigInt    | Record creation timestamp            | -                                                      |

**Privacy Concerns**:

- **Social Graph**: The `JoinedTeams` table explicitly maps out social connections and group affiliations within a class, which can be highly sensitive.
- This data can be used to analyze social dynamics, peer relationships, and potential cliques.

---

### 6. Lesson Table

**Purpose**: Defines the weekly class schedule, including subjects, times, and locations.

| Field                | Data Type | Intentionally Stored   | Potentially Unintentional                    |
| :------------------- | :-------- | :--------------------- | :------------------------------------------- |
| lessonId             | Integer   | Unique lesson identifier | -                                          |
| lessonNumber/weekDay | Integer   | Schedule structure     | Reveals attendance patterns                  |
| classId/teamId       | Integer   | Class/group assignment | Links schedule to specific groups            |
| subjectId            | Integer   | Subject reference      | -                                            |
| room                 | String    | Location management    | **May reveal physical presence patterns**    |
| startTime/endTime    | BigInt    | Time management        | **Enables detailed daily schedule tracking** |
| createdAt            | BigInt    | Record creation timestamp | -                                         |

**Privacy Concerns**:

- The combination of fields in this table allows for the reconstruction of a detailed daily schedule for student groups, including their physical location (`room`) at specific times.

---

### 7. Subjects Table

**Purpose**: Stores information about school subjects and their assigned teachers for a specific class.

| Field          | Data Type         | Intentionally Stored              | Potentially Unintentional                                   |
| :------------- | :---------------- | :-------------------------------- | :---------------------------------------------------------- |
| subjectId      | Integer           | Unique subject identifier         | -                                                           |
| subjectName... | String / String[] | Subject name and variations       | -                                                           |
| teacherGender  | String            | Teacher gender for display/admin  | **Privacy concern**: May enable discrimination or profiling |
| teacherName... | String / String[] | **Full and short teacher name**   | **Direct personal identifiers** of staff                    |
| classId        | Integer           | Links subject to a specific class | -                                                           |
| createdAt      | BigInt            | Record creation timestamp         | -                                                           |

**Privacy Concerns**:

- **Teacher's Personal Data**: This table directly stores identifiable personal data about teachers (`teacherNameLong`, `teacherNameShort`, `teacherGender`).
- **Consent**: Ensure teacher consent is obtained for storing and displaying this information.

---

### 8. Team Table

**Purpose**: Defines a specific group (team) within a class.

| Field   | Data Type | Intentionally Stored           | Potentially Unintentional                                     |
| :------ | :-------- | :----------------------------- | :------------------------------------------------------------ |
| teamId  | Integer   | Unique team identifier         | -                                                             |
| name    | String    | Name of the team               | May be revealing (e.g., "Advanced Group", "Remedial Reading") |
| classId | Integer   | Links team to a specific class | -                                                             |
| createdAt | BigInt  | Record creation timestamp      | -                                                             |

**Privacy Concerns**:

- The `name` of a team could imply academic level, behavioral status, or other sensitive classifications about its members.

---

### 9. Upload & FileMetadata Tables

**Purpose**: Management of file uploads, upload requests and their metadata. An upload can contain one or multiple files.

| Table.Field             | Data Type | Intentionally Stored                         | Potentially Unintentional                                           |
| :---------------------- | :-------- | :------------------------------------------- | :------------------------------------------------------------------ |
| Upload.uploadId         | Integer   | Unique upload job identifier                 | -                                                                   |
| Upload.uploadName       | String    | User-provided name for the upload            | **May contain personal info or sensitive content descriptions**     |
| Upload.uploadDescription| String    | User-provided description for the upload     | **May contain personal info or sensitive content descriptions**     |
| Upload.uploadType       | String    | Category/type of upload                      | Could reveal the nature of shared content                           |
| Upload.isPinned         | Boolean   | Upload pinning                               | -                                                                   |
| Upload.status           | String    | Processing state of upload                   | Reveals system usage patterns                                       |
| Upload.errorReason      | String    | Error details if upload failed               | **May leak technical details or file content information**          |
| Upload.reservedBytes    | BigInt    | Storage space reserved for upload            | Indicates size/scope of content being shared                        |
| Upload.createdAt        | BigInt    | Upload timestamp                             | **Reveals user activity patterns and collaboration timing**         |
| Upload.teamId           | Integer   | Links upload to a specific team              | **Creates connection between users and shared content**             |
| Upload.accountId        | Integer   | Identifier of user who uploaded              | **Direct link to user and their shared content**                    |
| Upload.classId          | Integer   | Links upload to a specific class             | -                                                                   |
| Upload.lastEditorAccountId | Integer? | Private authorship for moderation: last account that uploaded or edited the upload (also only its name or description); `null` after an anonymous edit | Links shared content to the person who last changed it |
| UploadRequest.uploadRequestId   | Integer   | Unique upload request identifier             | -                                                         |
| UploadRequest.uploadRequestName | String    | User-provided title of the upload request    | **May contain personal or sensitive descriptions**        |
| UploadRequest.classId           | Integer   | Links request to a specific class            | Reveals class involvement                                 |
| UploadRequest.teamId            | Integer   | Links request to a specific team             | Maps request to social/working groups                     |
| FileMetadata.fileMetaDataId | Integer | Unique file metadata identifier            | -                                                                   |
| FileMetadata.uploadId   | Integer   | Links file to its upload job                 | -                                                                   |
| FileMetadata.storedFileName | String | UUID-based filename on disk                 | Prevents direct file access but enables file tracking               |
| FileMetadata.mimeType   | String    | File type information                        | **Reveals nature of content** (documents, images, videos, etc.)     |
| FileMetadata.size       | Integer   | File size in bytes                           | Combined with mime type, may identify specific content              |
| FileMetadata.createdAt  | BigInt    | File creation timestamp                      | Enables detailed activity tracking                                  |

**Privacy Concerns**:

- **Content Profiling**: The combination of `uploadName`, `uploadDescription`, `uploadType`, `mimeType`, and `size` can create detailed profiles of what type of content users and teams are sharing.
- **User Attribution**: The `accountId` field directly links uploaded content to specific users, creating a permanent record of who shared what.
- `lastEditorAccountId` records who last changed an upload. It is never returned by the API, is not part of the cached upload metadata in Redis and is set to `null` when the account is permanently deleted.
- **Team Dynamics**: Upload patterns (frequency, size, type) can reveal team collaboration dynamics and potentially identify active vs. inactive members.
- **Temporal Tracking**: Timestamps enable detailed analysis of when users are active and how they collaborate over time.

**Solutions**:

- Implement strict file type validation and size limits to prevent abuse.
- Ensure `errorReason` messages are sanitized and do not expose sensitive details.
- Implement retention policies for old uploads and automatic cleanup.
- Monitor storage usage patterns to detect potential abuse.

---

### 10. Report Table

**Purpose**: Reporting content and users (EU DSA notice-and-action, Art. 16) and keeping the decision for appeals; a banned account gets its statement of reasons (Art. 17) from its ban fields (see Account).

| Table.Field                     | Data Type | Intentionally Stored                                          | Potentially Unintentional                                        |
| :------------------------------ | :-------- | :------------------------------------------------------------ | :--------------------------------------------------------------- |
| Report.reportId                 | Integer   | Unique report identifier                                      | -                                                                |
| Report.classId                  | Integer?  | Class the report was filed in                                 | -                                                                |
| Report.targetType / targetId    | Enum / Integer | Reported shared homework, event, upload or account      | -                                                                |
| Report.targetAccountId          | Integer?  | Original author of the reported content, or the reported account | **Links a user to an accusation**, even if it is dismissed    |
| Report.editorAccountId          | Integer?  | Last editor of the reported homework, event or upload at report time (the author's id when the author edited last, empty after an anonymous edit) | **Links a user to an accusation**, even if it is dismissed |
| Report.reporterKey              | String    | `account:<id>` or HMAC of the session id for anonymous reporters; prevents duplicate reports | Reveals who reported whom to the operator |
| Report.reporterContact          | String?   | Optional reporter email, encrypted (aes-256-gcm)              | **Personal contact data**                                        |
| Report.category / description   | Enum / String | Report reason and free-text explanation                   | **Free text may contain personal data about others**             |
| Report.snapshot                 | JSON      | Copy of the reported content (text, subject/team/event type names, file metadata, uploader name; never file contents) | **Keeps content after it was deleted** |
| Report.action / decisionReason  | Enum / String | Moderation decision and its reasons                       | -                                                                |
| Report.decisionGround           | Enum?     | `terms` (terms of use no. 3) or `illegal`; empty for dismissed reports | -                                                       |
| Report.resolvedAt / createdAt   | BigInt    | Report and decision timestamps; `resolvedAt` is empty while the report is open | -                                               |

**Privacy Concerns**:

- Reports link a user to an accusation and keep a copy of the reported content, even after the content or the reporter's account is deleted.
- Reporters can enter any email address, so the service could be used to send mails to third parties.

**Solutions**:

- **Contact data**: `reporterContact` is encrypted and cleared once the report is resolved; the decision mail to it waits in `MailQueue` (encrypted as well) until it is sent. Reporters can enter any address, so one email address can be stored on 3 reports per day; beyond that the report is filed without contact data or mail. All other mail volume is bounded by the daily mail budget, and mails past it wait in `MailQueue`.
- **Retention**: open reports are kept until decided. Resolved reports are kept for **six months**, then deleted by the daily cleanup, only to check appeals against the original content and decision. Appeals have no deadline: the complaint system of DSA Art. 20 (open for at least six months) does not apply to micro and small providers (Art. 19(1)).
- **Legal basis**: Art. 6(1)(c) GDPR with DSA Art. 16 and 17; Art. 6(1)(f) GDPR for keeping decisions for appeals. The privacy policy (about page, no. 6) states data, purpose and retention.
- **Account deletion**: references are set to `null`; the account id inside `reporterKey` stays until the report is deleted.
- **Operator mail**: the operator is mailed for 50 reports per day, the rest goes into a daily digest. Mails hold only report id, category, target type, time and panel address, never content.
- **Panel**: password, own session cookie, 3-hour login. The password is shared, so each login and decision is logged with the IP address and a hash of the panel session id
- **Visibility**: class members cannot see whether an item was reported; private author ids are never returned by the API.
- **Decisions**: made by a person. The decision mail and ban message (DSA Art. 16(5), 17) state decision, ground, reasons and how to appeal: by mail to support@taskminder.de, naming the report number or username, plus the right to go to court. A ban also resolves the open reports on the banned account from every class. Accepted ban appeals are lifted in the panel; removed content cannot be restored.
- **Banned admins**: a banned admin cannot act, so a ban takes its admin role (an unban does not give it back). If the class then has no active admin, its longest active member becomes admin; a class without another active member stays without admin.

### 11. MailQueue Table

**Purpose**: Mails reporters are owed (receipt, DSA Art. 16(4); decision, Art. 16(5)), queued in the same transaction as the report or decision so neither commits without its mail, then sent and retried until they go out.

| Table.Field                     | Data Type | Intentionally Stored                                          | Potentially Unintentional                                        |
| :------------------------------ | :-------- | :------------------------------------------------------------ | :--------------------------------------------------------------- |
| MailQueue.mailId                | Integer   | Unique mail identifier                                        | -                                                                |
| MailQueue.recipient             | String    | Reporter email, encrypted (aes-256-gcm)                       | **Personal contact data**                                        |
| MailQueue.subject / text        | String    | Receipt or decision text: report number, decision, ground, reasons, way to appeal | Decision reasons may describe the reported user's misconduct |
| MailQueue.nextAttemptAt / createdAt | BigInt | When to send next and when the mail was queued      | -                                                                |

**Solutions**:

- **Retention**: a mail is deleted as soon as it is sent. One that fails or is held back by the daily mail budget is tried again an hour later, and dropped once it has failed for 7 days (logged without the address).
- **Key rotation**: the rotation script (`encrypt:rotate`) re-encrypts every recipient, reporter contact and class code that is not yet under the new primary key. Contacts that neither key decrypts are unusable and removed; such class codes are left as they are and listed in the log (an admin can generate a new class code).

---

## Cross-Table Privacy Risks

The `Class` schema as a central entity increases cross-table risks.

### 1. Granular Profile Building

Combining data across tables enables the creation of highly detailed user profiles:

- Student Profile: Academic performance (`HomeworkCheck`) + social connections (`JoinedTeams`) + daily schedule and location (`Lesson`) + specific activities (`Event`). All this data can be correlated through a combination of `accountId` and `classId`.

### 2. Behavioral and Social Analytics

- The normalized structure allows for analytics on student behavior, such as correlating homework completion (`HomeworkCheck`) with team membership (`JoinedTeams`) or specific lessons (`Lesson`).
- Social network graphs can be generated from the `JoinedTeams` and `Account` tables, revealing peer influence and group dynamics.

---

## Data Collected and Stored in Redis and Telemetry Systems (Prometheus/Loki)

### Redis

Our Redis architecture serves as a cache to temporarily store data, reducing database load and improving performance. Cached data is automatically cleared when the corresponding data is deleted from the database. The following types of content are stored:

* Homework, events, lessons, timetables, teams, substitutions and upload metadata for each class (without the private author and last editor ids of homework, events and uploads)
* Authenticated user and class information
* User sessions (from express-session) and moderation panel sessions (3 hours)
* Daily counters of reports per contact address, keyed by a hash of the email address, and of operator mails (expire after 24 hours)
* Daily counter of all mails sent, without any address (expires after 2 days)

---

### Email (Brevo)

Moderation mails are sent through [Brevo](https://www.brevo.com) (Brevo SAS, Paris), which acts as a processor under the data processing agreement in its [terms of service](https://www.brevo.com/legal/termsofuse/#appendix-3-data-processing-agreement-dpa). Its servers are in France and Belgium; sub-processors may in individual cases act outside the EU, safeguarded by standard contractual clauses and the EU-US Data Privacy Framework. Brevo keeps a log of each sent mail (recipient, subject, time and a preview of the content, which can be turned off in the Brevo settings). It receives:

* Operator mails to support@taskminder.de: report id, category, target type, time and the address of the moderation panel; once a day a mail with the number of open reports
* For reporters who entered an email: the address, plus the receipt and the decision text with its reasons and the way to appeal

---

### Telemetry Data

To maintain and improve our service quality, we collect certain telemetry data, which is stored in server logs:

* Date and time of the request
* Endpoint path and HTTP method
* HTTP status code
* Size of the returned data
* Referrer information
* User agent details (e.g., browser name and version, operating system, etc.)
* For moderation panel logins and decisions: the IP address and a hash of the panel session id

**Retention:** Logs are stored for **14 days (±2h)** and are permanently deleted thereafter.

---

- **Document Version:** 2.7
- **Stable Version Alignment:** v2.4.0
- **Last Updated:** November 26th, 2026
- **Next Scheduled Review:** Quarterly – December 31st, 2026
- **Technical Contact:** [info@taskminder.de](mailto:info@taskminder.de)
