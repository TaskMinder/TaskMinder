import { RequestError } from "../@types/requestError.js";
import { prisma } from "../config/prisma.js";
import { Session, SessionData } from "express-session";

function checkUsername(username: string): boolean {
  return /^\w{4,20}$/.test(username);
}

async function isValidEventTypeId(eventTypeId: number, session: Session & Partial<SessionData>): Promise<void> {
  const eventTypeExists = await prisma.eventType.findUnique({
    where: {
      eventTypeId: eventTypeId,
      classId: parseInt(session.classId!, 10)
    }
  });
  if (!eventTypeExists) {
    const err: RequestError = {
      name: "Not Found",
      status: 404,
      message: "Invalid eventTypeId (eventType does not exist) for this class: " + eventTypeId,
      expected: true
    };
    throw err;
  }
}

async function isValidTeamId(teamId: number, session: Session & Partial<SessionData>): Promise<void> {
  if (teamId !== -1) {
    const teamExists = await prisma.team.findUnique({
      where: {
        teamId: teamId,
        classId: parseInt(session.classId!, 10)
      }
    });
    if (!teamExists) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Invalid teamId (Team does not exist) for this class: " + teamId,
        expected: true
      };
      throw err;
    }
  }
  else {
    return;
  }
}

// @codescene(disable:"Code Duplication")
// see explaination for isValidTeamId
async function isValidSubjectId(subjectId: number, session: Session & Partial<SessionData>): Promise<void> {
  if (subjectId !== -1) {
    const subjectExists = await prisma.subjects.findUnique({
      where: {
        subjectId: subjectId,
        classId: parseInt(session.classId!, 10)
      }
    });
    if (!subjectExists) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Invalid subjectId (Subject does not exist) for this class: " + subjectId,
        expected: true
      };
      throw err;
    }
  }
  else {
    return;
  }
}

function isValidColor(color: string): void {
  const hexColorRegex = /^#[0-9a-f]{6}$/i;
  const colorValid = hexColorRegex.test(color);
  if (!colorValid) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "Color must be a 6-digit hex code",
      expected: true
    };
    throw err;
  }
  else {
    return;
  }
}

// checks if submission date is after/equal to assignment date
function dateChecker(startDate: number, endDate: number): void {
  if (startDate > endDate) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "startDate/assignmentDate is after endDate/submissionDate",
      expected: true
    };
    throw err;
  }
}

function lessonDateEventAtLeastOneNull(endDate: number | null, lesson: string | null): void {
  if (
    !(
      ["", undefined, null].includes(endDate as string | null | undefined) ||
      ["", undefined, null].includes(lesson as string | null | undefined)
    )
  ) {
    const err: RequestError = {
      name: "Unprocessable Entity",
      status: 422,
      message: "Only one entry (lesson or endDate) are allowed",
      expected: true
    };
    throw err;
  }
}

export {
  checkUsername,
  isValidColor,
  isValidSubjectId,
  isValidTeamId,
  isValidEventTypeId,
  lessonDateEventAtLeastOneNull,
  dateChecker
};
