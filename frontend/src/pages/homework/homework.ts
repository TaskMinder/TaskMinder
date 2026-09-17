import {
  dateToMs,
  getHomeworkCheckStatus,
  homeworkCheckedData,
  homeworkData,
  isSameDay,
  joinedTeamsData,
  getDisplayDate,
  msToInputDate,
  subjectData,
  teamsData,
  lessonData,
  escapeHTML,
  getCirclePath,
  dateDaysDifference,
  onlyThisSite,
  ajax,
  user,
  getInputValue,
  autocomplete,
  getCurrentLesson,
  getNextLessonWithDate,
  checkTeamInputForSuspicious,
  RelativeDirection,
  showButtonLoading
} from "../../global/global.js";
import { HomeworkData, SingleHomeworkData } from "../../global/types";
import { richTextToHtml, richTextToPlainText } from "../../snippets/richTextarea/richTextarea.js";
import { SearchBox } from "../../snippets/richInput/richInput.js";

async function getFilteredHomeworkData(): Promise<(HomeworkData[number] & { checked: boolean })[]> {
  // Add the check value to each homework
  let data = await Promise.all(
    (await homeworkData()).map(async h => ({
      ...h,
      checked: await getHomeworkCheckStatus(h.homeworkId)
    }))
  );
  
  // Filter by team
  const currentJoinedTeamsData = await joinedTeamsData();
  data = data.filter(h => currentJoinedTeamsData.includes(h.teamId) || h.teamId === -1);
    
  const pinned = data.filter(h => h.isPinned);
  data = data.filter(h => ! h.isPinned);

  // Filter by min. date
  const filterDateMin = Date.parse($("#filter-date-from").val()?.toString() ?? "");
  if (! Number.isNaN(filterDateMin)) {
    data = data.filter(h => filterDateMin <= Number.parseInt(h.submissionDate) || isSameDay(filterDateMin, h.submissionDate));
  }
  // Filter by max. date
  const filterDateMax = Date.parse($("#filter-date-until").val()?.toString() ?? "");
  if (! Number.isNaN(filterDateMax)) {
    data = data.filter(h => filterDateMax >= Number.parseInt(h.assignmentDate) || isSameDay(filterDateMax, h.assignmentDate));
  }
  // Filter by search
  const sb = ($("#search-homework")[0] as SearchBox);
  data = data.filter(h => sb.searchMatches(richTextToPlainText(h.content)));
  // Filter by checked status
  if (! $("#filter-status-checked").prop("checked")) {
    data = data.filter(h => !h.checked);
  }
  // Filter by unchecked status
  if (! $("#filter-status-unchecked").prop("checked")) {
    data = data.filter(h => h.checked);
  }
  // Filter by subject
  data = data.filter(h => $(`#filter-subject-${h.subjectId}`).prop("checked") || h.subjectId === -1);

  data = pinned.concat(data);
  
  return data;
}

async function renderHomeworkList(): Promise<void> {
  const newContent = $("<div></div>");

  const data = await getFilteredHomeworkData();

  let foundNextWeek = false;
  let foundLater = false;
  let foundPinned = false;

  for (const homework of data) {
    function showCheckAnimation(): void {
      if (homework.checked && justCheckedHomeworkId === homeworkId && animations) {
        justCheckedHomeworkId = -1;
        template.find(".homework-check-wrapper").append($("<div></div>".repeat(8)).each(
          function (id) {
            $(this).attr("data-id", id);
            setTimeout(() => {
              $(this).remove();
            }, 400);
          }
        ));
      }
    }
    function showSections(): void {
      if (homework.isPinned) {
        foundPinned = true;
      }
      else {
        if (foundPinned) {
          foundPinned = false;
          newContent.append(`
            <hr class="border-2 text-primary mb-0 mt-2">
            <div class="form-text text-primary opacity-75 mt-0 section-divider">Diese Woche</div>
          `);
        }
        if (!foundNextWeek && Number.parseInt(homework.submissionDate) > nextWeekDate.getTime()) {
          foundNextWeek = true;
          newContent.append(`
            <hr class="border-2 text-primary mb-0 mt-2">
            <div class="form-text text-primary opacity-75 mt-0 section-divider">Nächste Woche</div>
          `);
        }
        if (!foundLater && Number.parseInt(homework.submissionDate) > laterDate.getTime()) {
          foundLater = true;
          newContent.append(`
            <hr class="border-2 text-primary mb-0 mt-2">
            <div class="form-text text-primary opacity-75 mt-0 section-divider">Später</div>
          `);
        }
      }
    }

    const nextWeekDate = new Date();
    nextWeekDate.setDate(nextWeekDate.getDate() + 7 - nextWeekDate.getDay());
    const laterDate = new Date();
    laterDate.setDate(laterDate.getDate() + 14 - laterDate.getDay());
    showSections();

    const homeworkId = homework.homeworkId;

    // Get the information for the homework
    const subject = (await subjectData()).find(s => s.subjectId === homework.subjectId)?.subjectNameLong ?? "Sonstiges";
    const content = homework.content;
    const assignmentDate = getDisplayDate(homework.assignmentDate, {relativeDirection: RelativeDirection.PAST});
    const submissionDate = getDisplayDate(homework.submissionDate, {relativeDirection: RelativeDirection.FUTURE});

    // The template for a homework with checkbox and edit options
    const template = $(`
      <div class="mb-1 mt-2 d-flex">
        <div class="form-check flex-grow-1 homework${homework.accountId === null ? "" : " homework-private"}">
          <div class="homework-check-wrapper form-check-input invisible">
            <input type="checkbox" class="form-check-input homework-check visible" id="homework-check-${homeworkId}"
              data-id="${homeworkId}" ${homework.checked ? "checked" : ""}>
          </div>
          <label class="form-check-label" for="homework-check-${homeworkId}">
            <i class="fas fa-thumbtack ${homework.isPinned ? "" : "d-none"} opacity-75" aria-hidden="true">
            </i><i class="fas fa-user-lock ${homework.accountId ? "" : "d-none"} opacity-75" aria-hidden="true"></i>
            <b>${escapeHTML(subject)}</b>
          </label>
          <span class="homework-content"></span>
          <span class="ms-4 d-block">Von ${assignmentDate} auf ${submissionDate}</span>
        </div>

        <div class="ms-2 d-flex flex-nowrap align-items-start">
          <button class="btn btn-sm btn-semivisible homework-edit"
            data-id="${homeworkId}" aria-label="Bearbeiten">
            <i class="fas fa-edit opacity-75" aria-hidden="true"></i>
          </button>

          <div class="dropdown">
            <button class="btn btn-sm btn-semivisible homework-more" data-bs-toggle="dropdown" aria-label="Mehr Aktionen">
              <i class="fas fa-ellipsis-vertical opacity-75" aria-hidden="true"></i>
            </button>
            <ul class="dropdown-menu">
              <button class="dropdown-item homework-pin" data-id="${homeworkId}">
                <i class="fas fa-thumbtack${homework.isPinned ? "-slash" : ""} opacity-75" aria-hidden="true"></i>
                ${homework.isPinned ? "Lösen" : "Anheften"}
              </button>
              <button class="dropdown-item homework-clone" data-id="${homeworkId}">
                <i class="fas fa-clone opacity-75" aria-hidden="true"></i> Duplizieren
              </button>
              <hr class="dropdown-divider">
              <button class="dropdown-item dropdown-item-danger homework-delete" data-id="${homeworkId}">
                <i class="fas fa-trash opacity-75" aria-hidden="true"></i> Löschen
              </button>
            </ul>
          </div>
        </div>
      </div>
    `);
    
    showCheckAnimation();

    // Add this homework to the list
    newContent.append(template);

    richTextToHtml(content, template.find(".homework-content"), {
      showMoreButton: true,
      parseLinks: true,
      displayBlockIfNewline: true,
      merge: true
    });
  }

  newContent.find(".section-divider").each(function () {
    if (!$(this).next().length || $(this).next().is("hr")) {
      $(this).prev().addBack().remove();
    }
  });

  // If no homeworks match, add an explanation text
  $("#no-homework-found").toggle(data.length === 0);
  $("#homework-list").empty().append(newContent.children()).toggleClass("d-none", data.length === 0);

  toggleShownButtons();

  renderHomeworkFeedback();
};

async function renderHomeworkFeedback(): Promise<void> {
  const todoHomeworkData = await getFilteredHomeworkData();

  let todo = 0;
  for (const h of todoHomeworkData) {
    if (!await getHomeworkCheckStatus(h.homeworkId)) {
      todo++;
    }
  }
  const total = todoHomeworkData.length;

  if (todo > 0) {
    $("#homework-feedback-body").html(`
      <span>Du musst noch <b>${todo}</b> von <b>${total}</b> Hausaufgaben machen.</span>
      ${todo > 1 ? '<button id="homework-feedback-random" class="btn btn-primary btn-sm fw-semibold ms-2">Zufällige auswählen</button>' : ""}
    `);
    $("#homework-feedback-done").hide();
    $("#homework-feedback-outer-circle").show();

    const halfSize = ($("#homework-feedback-inner-circle").outerWidth() ?? 0) / 2;
    const percentage = 1 - todo / total;
    let animationPercentage = (homeworkFeedbackLastPercentage !== null && animations) ? homeworkFeedbackLastPercentage : percentage;

    const baseChange = 0.1 / total;
    function animateCircle(): void {
      if (Math.abs(animationPercentage - percentage) < baseChange) {
        animationPercentage = percentage;
        $("#homework-feedback-inner-circle").css("clip-path", `path("${getCirclePath(halfSize, halfSize, halfSize, animationPercentage * 360)}")`);
        homeworkFeedbackLastPercentage = percentage;
        return;
      }

      const change = (animationPercentage < percentage ? baseChange : -baseChange);
      animationPercentage += change;

      $("#homework-feedback-inner-circle").css("clip-path", `path("${getCirclePath(halfSize, halfSize, halfSize, animationPercentage * 360)}")`);

      requestAnimationFrame(animateCircle);
    }
    animateCircle();
  }
  else {
    $("#homework-feedback-body").html("Super, du hast alle Hausaufgaben erledigt!");
    $("#homework-feedback-outer-circle").hide();
    $("#homework-feedback-done").show();
  }
}

async function renderRandomHomeworkWheel(todoHomework: HomeworkData): Promise<void> {
  const currentSubjectData = await subjectData();

  $("#random-homework-wheel").toggle(animations);
  $("#random-homework-result").empty();
  $("#random-homework-modal").modal("show");
  $("#random-homework-next").prop("disabled", true);
  const todo = todoHomework.length;
  const full = todo === 1;
  const angle = 360 / todo;
  const r = ($("#random-homework-wheel-rotate").outerWidth() ?? 0) / 2;
  const diff = todo > 5 ? 360 / todoHomework.length : 30;
  $("#random-homework-wheel-rotate").empty().append(todoHomework.map((h, i) => {
    const subject = currentSubjectData.find(s => s.subjectId === h.subjectId) ?? {subjectNameLong: "Sonstiges", subjectNameShort: "Sonstiges"};
    const subjectName = subject.subjectNameLong.length >= 25 ? subject.subjectNameShort : subject.subjectNameLong;
    return $(`
        <div>
          <div class="random-homework-wheel-option w-100 h-100"></div>
          <span class="position-absolute translate-middle fw-bold">
            ${escapeHTML(subjectName)}
          </span>
        </div>
      `)
      .find("div").css({
        "clip-path": `path("${getCirclePath(r, r, r, angle, full)}")`,
        "--hue": 187 + diff * i,
        "rotate": angle * i + "deg"
      }).end()
      .find("span").css({
        "left": r + (full ? 0 : 0.75 * r * Math.sin(Math.PI / 180 * angle * (i + 0.5))),
        "top":  r - (full ? 0 : 0.75 * r * Math.cos(Math.PI / 180 * angle * (i + 0.5))),
        "rotate": full ? 0 : angle * (i + 0.5) + "deg"
      }).end();
  }));

  $("#random-homework-wheel-rotate").css("rotate", "0deg");
}

function chooseRandomHomework(todoHomework: HomeworkData): void {
  const todo = todoHomework.length;
  const full = todo === 1;
  let constantSpin = Math.random() * 90 + 90;
  let rotation = animations ? 0 : Math.random() * 360;
  let speed = 4;

  function rotateWheel(): void {
    $("#random-homework-wheel-rotate").css("rotate", Math.round(rotation) + "deg");
    if (speed < 0.5) {
      showResult();
      return;
    }
    if (full || !animations) {
      showResult();
      return;
    }
    rotation += speed;
    if (constantSpin > 0) constantSpin --;
    else speed -= Math.random() / (speed * 5);
    requestAnimationFrame(rotateWheel);
  }
  rotateWheel();

  async function showResult(): Promise<void> {
    const h = todoHomework[full ? 0 : Math.floor((360 - rotation % 360) / 360 * todo)];
    const subject = (await subjectData()).find(s => s.subjectId === h.subjectId)?.subjectNameLong ?? "Sonstiges";
    const content = h.content;
    const assignmentDate = getDisplayDate(h.assignmentDate, {relativeDirection: RelativeDirection.PAST});
    const submissionDate = getDisplayDate(h.submissionDate, {relativeDirection: RelativeDirection.FUTURE});
    $("#random-homework-result").html(`
      <h5>Ausgewählte Hausaufgabe:</h5>
      <div>
        <b>${escapeHTML(subject)}</b>
        <span class="homework-content"></span>
        <span class="ms-4 d-block">Von ${assignmentDate} auf ${submissionDate}</span>
      </div>
    `);

    const $contentEl = $("#random-homework-result").find(".homework-content");
    richTextToHtml(content, $contentEl, {
      showMoreButton: true,
      parseLinks: true,
      displayBlockIfNewline: true,
      merge: true
    });

    $("#random-homework-next").prop("disabled", false).off("click").on("click", async () => {
      checkHomework(h.homeworkId, true);
      if (todo === 1) {
        $("#random-homework-modal").modal("hide");
      }
      else {
        const newData = todoHomework.filter(homework => homework.homeworkId !== h.homeworkId);
        renderRandomHomeworkWheel(newData);
        chooseRandomHomework(newData);
      }
    });
  }
}

async function prepareRandomHomework(): Promise<void> {
  $("#random-homework-list, #random-homework-list-explanation").show();
  const newContent = $("<div></div>");

  const data = await getFilteredHomeworkData();

  const todoHomework: HomeworkData = [];
  for (const h of data) {
    if (!await getHomeworkCheckStatus(h.homeworkId)) {
      todoHomework.push(h);
    }
  }

  randomHomeworkDeactivated = randomHomeworkDeactivated.filter(d => todoHomework.some(h => h.homeworkId === d));


  for (const homework of todoHomework) {
    const homeworkId = homework.homeworkId;

    // Get the information for the homework
    const subject = (await subjectData()).find(s => s.subjectId === homework.subjectId)?.subjectNameLong ?? "Sonstiges";
    const content = homework.content;
    const assignmentDate = getDisplayDate(homework.assignmentDate, {relativeDirection: RelativeDirection.PAST});
    const submissionDate = getDisplayDate(homework.submissionDate, {relativeDirection: RelativeDirection.FUTURE});

    const deactivated = randomHomeworkDeactivated.includes(homeworkId) ? "random-homework-deactivated" : "";

    // The template for a homework with checkbox and edit options
    const template = $(`
      <div class="btn btn-semivisible border rounded p-2 mb-2 w-100 random-homework-deactivate-option ${deactivated}" data-id="${homeworkId}">
        <b>${escapeHTML(subject)}</b>
        <span class="homework-content"></span>
        <span class="ms-4 d-block">Von ${assignmentDate} auf ${submissionDate}</span>
      </div>
    `);

    // Add this homework to the list
    newContent.append(template);

    richTextToHtml(content, template.find(".homework-content"), {
      showMoreButton: true,
      parseLinks: true,
      displayBlockIfNewline: true,
      merge: true
    });
  }

  $("#random-homework-list").empty().append(newContent.children());

  $(".random-homework-deactivate-option").on("click", function () {
    const id = Number.parseInt($(this).attr("data-id") ?? "");
    if (randomHomeworkDeactivated.includes(id)) {
      randomHomeworkDeactivated.splice(randomHomeworkDeactivated.indexOf(id), 1);
    }
    else {
      if (randomHomeworkDeactivated.length === todoHomework.length - 1) return;
      randomHomeworkDeactivated.push(id);
    }
    $(this).toggleClass("random-homework-deactivated");
    renderRandomHomeworkWheel(todoHomework.filter(h => !randomHomeworkDeactivated.includes(h.homeworkId)));
  });

  renderRandomHomeworkWheel(todoHomework.filter(h => !randomHomeworkDeactivated.includes(h.homeworkId)));

  $("#random-homework-wheel").off("click").one("click", () => {
    $("#random-homework-list, #random-homework-list-explanation").hide();
    chooseRandomHomework(todoHomework.filter(h => !randomHomeworkDeactivated.includes(h.homeworkId)));
  });
}

async function renderSubjectList(): Promise<void> {
  const manageHomeworkSubjectVal = $("#manage-homework-subject").val() ?? "";

  // Clear the select element in the manage homework modal
  $("#manage-homework-subject").html('<option value="" disabled selected>Fach</option>');
  // Clear the list for filtering by subject
  $("#filter-subject-list").empty();

  const filterData = JSON.parse(localStorage.getItem("homeworkFilter") ?? "{}") ?? {};
  filterData.subject ??= {};

  const currentJoinedTeamsData = await joinedTeamsData();

  for (const subject of [
    ...(await subjectData()).filter(s => s.teamId === -1 || currentJoinedTeamsData.includes(s.teamId)),
    {subjectId: -1, subjectNameLong: "Sonstiges"}
  ]) {
    // Get the subject data
    const subjectId = subject.subjectId;
    const subjectName = subject.subjectNameLong;

    filterData.subject[subjectId] ??= true;
    const checkedStatus = filterData.subject[subjectId] ? "checked" : "";
    if (checkedStatus !== "checked") $("#filter-changed").show();

    // Add the template for filtering by subject
    const templateFilterSubject = `
      <label class="form-check flex-grow-1 text-center mb-0 ps-2rem pe-2 py-1 border rounded bg-body-tertiary">
        <input type="checkbox" class="form-check-input filter-subject-option me-2"
          id="filter-subject-${subjectId}" data-id="${subjectId}" ${checkedStatus}>
        ${escapeHTML(subjectName)}
      </label>`;
    $("#filter-subject-list").append(templateFilterSubject);

    // Add the template for the select elements
    const templateFormSelect = `<option value="${subjectId}">${escapeHTML(subjectName)}</option>`;
    $("#manage-homework-subject").append(templateFormSelect);
  };

  if (manageHomeworkSubjectVal !== "") $("#manage-homework-subject").val(manageHomeworkSubjectVal);

  localStorage.setItem("homeworkFilter", JSON.stringify(filterData));

  $("#manage-homework-no-subjects").toggleClass("d-none", (await subjectData()).length !== 0).find("b").text(
    user.permissionLevel < 3 ?
      "Bitte einen Admin / ein:e Manager:in, welche hinzuzufügen!" :
      "Füge in den Einstellungen unter \"Klasse\" > \"Fächer\" welche hinzu!"
  );
};

async function renderTeamList(): Promise<void> {
  const manageHomeworkTeamVal = $("#manage-homework-visibility-team-select").val() ?? "-1";

  // Clear the select element in the manage homework modal
  $("#manage-homework-visibility-team-select").html('<option value="-1" disabled selected>Team</option>');

  const currentJoinedTeamsData = await joinedTeamsData();
  for (const team of (await teamsData()).filter(t => currentJoinedTeamsData.includes(t.teamId))) {
    // Add the template for the select elements
    $("#manage-homework-visibility-team-select").append(`<option value="${team.teamId}">${escapeHTML(team.name)}</option>`);
  }

  $("#manage-homework-visibility-team-select").val(manageHomeworkTeamVal);
};

function toggleManageHomeworkDisabled(): void {
  const subject = $("#manage-homework-subject").val();
  const content = $("#manage-homework-content").val()?.toString().trim();
  const assignmentDate = $("#manage-homework-date-assignment").val();
  const submissionDate = $("#manage-homework-date-submission").val();

  $(".manage-homework-button").prop("disabled",
    [content, assignmentDate, submissionDate].includes("")
    || subject === null
    || $("#manage-homework-date-submission").hasClass("is-invalid")
    || ($("#manage-homework-visibility-team").prop("checked") && $("#manage-homework-visibility-team-select").val() === null)
  );
}

async function manageHomework(mode: "add" | "edit", homework: Partial<SingleHomeworkData>): Promise<void> {
  // Reset the data inputs in the manage homework modal
  $("#manage-homework-subject").val(homework?.subjectId ?? "");
  $("#manage-homework-content").val(homework?.content ?? "");
  $("#manage-homework-date-assignment").val(msToInputDate(homework?.assignmentDate ?? ""));
  $("#manage-homework-date-submission").val(msToInputDate(homework?.submissionDate ?? ""));
  const visibility = user.permissionLevel === 0 ? "private" : (homework?.accountId ? "private" : (homework?.teamId ?? -1) === -1 ? "all" : "team");
  $("#manage-homework-visibility-private").prop("checked", visibility === "private");
  $("#manage-homework-visibility-team").prop("checked", visibility === "team");
  $("#manage-homework-visibility-all").prop("checked", visibility === "all");
  $("#manage-homework-visibility-team-select").val(homework?.teamId ?? "-1");

  $(".manage-homework-input").removeClass("is-autocompleted is-suspicious is-invalid");
  $("#manage-homework-content").trigger("change");

  if (! homework.subjectId) {
    const currentLesson = (await getCurrentLesson())?.lessons[0];
    if (currentLesson) {
      autocomplete($("#manage-homework-subject"), currentLesson.substitution?.subjectId ?? currentLesson.subjectId);
    }
  }
  if (! homework.assignmentDate) {
    autocomplete($("#manage-homework-date-assignment"), msToInputDate(Date.now()));
  }

  // Adjust according to the mode
  $("#manage-homework-modal-label").text(mode === "add" ? "Hausaufgabe hinzufügen" : "Hausaufgabe bearbeiten");
  $(".manage-homework-button").prop("disabled", true);
  $("#manage-homework-add-button").toggle(mode === "add");
  $("#manage-homework-delete-button, #manage-homework-edit-button").toggle(mode === "edit");

  // Show the manage homework modal
  $("#manage-homework-modal").modal("show");

  // Called when the user clicks the primary button in the modal
  // Note: .off("click") removes the existing click event listener from a previous call of this function
  $(".manage-homework-button").off("click").on("click", async () => {
    // Save the given information in variables
    const subjectId = $("#manage-homework-subject").val();
    const content = $("#manage-homework-content").val()?.toString().trim();
    const assignmentDate = $("#manage-homework-date-assignment").val()?.toString() ?? "";
    const submissionDate = $("#manage-homework-date-submission").val()?.toString() ?? "";
    const canCreateSharedHomework = user.permissionLevel >= 1;
    const isPersonal = !canCreateSharedHomework || $("#manage-homework-visibility-private").prop("checked");
    const teamId = !isPersonal && $("#manage-homework-visibility-team").prop("checked")
      ? $("#manage-homework-visibility-team-select").val()
      : -1;
    const body = {
      subjectId,
      content,
      assignmentDate: dateToMs(assignmentDate),
      submissionDate: dateToMs(submissionDate),
      isPersonal,
      teamId
    };

    const ajaxPromise = mode === "add"
      ? ajax("POST", "/api/homework", { body, queueable: true })
      : ajax("PATCH", `/api/homework/${homework!.homeworkId}`, { body, queueable: true });

    showButtonLoading($(".manage-homework-button:visible"), ajaxPromise);
    await ajaxPromise;

    $("#manage-homework-modal").modal("hide");
  });

  $("#manage-homework-delete-button").off("click").on("click", () => {
    deleteHomework(homework?.homeworkId ?? -1);
  });
}

async function pinHomework(homeworkId: number): Promise<void> {
  const homework = (await homeworkData()).find(h => h.homeworkId === homeworkId);
  if (!homework) return;

  await ajax("PATCH", `/api/homework/${homeworkId}/pin`, {
    body: {
      pinStatus: !homework.isPinned
    },
    queueable: true
  });
}

function deleteHomework(homeworkId: number): void {
  //
  // CALLED WHEN THE USER CLICKS THE "DELETE" OPTION OF A HOMEWORK, NOT WHEN USER ACTUALLY DELETES A HOMEWORK
  //

  // Show a confirmation notification
  $("#delete-homework-confirm-toast").toast("show");

  // Called when the user clicks the "confirm" button in the notification
  // Note: .off("click") removes the existing click event listener from a previous call of this function
  $("#delete-homework-confirm-toast-button")
    .off("click")
    .on("click", async () => {
      // Hide the confirmation toast
      $("#delete-homework-confirm-toast").toast("hide");

      const ajaxPromise = ajax("DELETE", `/api/homework/${homeworkId}`, {
        queueable: true
      });
      showButtonLoading($("#delete-homework-confirm-toast-button"), ajaxPromise);
      await ajaxPromise;

      $("#manage-homework-modal").modal("hide");
      $("#delete-homework-success-toast").toast("show");
    });
}

async function checkHomework(homeworkId: number, checkStatus?: boolean): Promise<void> {
  justCheckedHomeworkId = homeworkId;
  // Save whether the user has checked or unchecked the homework
  checkStatus ??= $(`.homework-check[data-id="${homeworkId}"]`).prop("checked");

  // Check whether the user is logged in
  if (user.loggedIn) {
    await ajax("PATCH", `/api/homework/${homeworkId}/check`, {
      body: { checkStatus: checkStatus },
      queueable: true
    });
  }
  else {
    // The user is not logged in

    // Get the already saved data
    let dataString = localStorage.getItem("homeworkCheckedData");
    const data = JSON.parse(dataString ?? "[]");

    if (checkStatus) {
      data.push(homeworkId);
    }
    else {
      data.splice(data.indexOf(homeworkId), 1);
    }

    dataString = JSON.stringify(data);

    localStorage.setItem("homeworkCheckedData", dataString);
    
    homeworkCheckedData.reload();
    renderHomeworkList();
  }
}

function updateFilters(ignoreSubjects?: boolean): void {
  $("#filter-changed").hide();

  const filterData = JSON.parse(localStorage.getItem("homeworkFilter") ?? "{}") ?? {};

  filterData.statusUnchecked ??= true;
  $("#filter-status-unchecked").prop("checked", filterData.statusUnchecked);
  if (! filterData.statusUnchecked) $("#filter-changed").show();

  filterData.statusChecked ??= true;
  $("#filter-status-checked").prop("checked", filterData.statusChecked);
  if (! filterData.statusChecked) $("#filter-changed").show();

  filterData.dateFromOffset ??= 0;
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() + filterData.dateFromOffset);
  $("#filter-date-from").val(msToInputDate(dateFrom.getTime()));
  if (filterData.dateFromOffset !== 0) $("#filter-changed").show();

  filterData.dateUntilOffset ??= 0;
  const dateUntil = new Date();
  dateUntil.setMonth(dateUntil.getMonth() + 1);
  dateUntil.setDate(dateUntil.getDate() + filterData.dateUntilOffset);
  $("#filter-date-until").val(msToInputDate(dateUntil.getTime()));
  if (filterData.dateUntilOffset !== 0) $("#filter-changed").show();
  
  if (! ignoreSubjects) {
    renderSubjectList();
  }
}

function toggleShownButtons(): void {
  $("#manage-homework-only-private").toggle(user.permissionLevel === 0);
  $("#manage-homework-visibility-label, #manage-homework-visibility").toggle(user.permissionLevel >= 1);
  $("#show-add-homework-button").toggle(user.permissionLevel >= 1 || (user.loggedIn ?? false));
  $(".homework:not(.homework-private)")
    .find(".homework-edit, .homework-pin, .homework-delete, .dropdown-divider:has(~ .homework-delete)").toggle(user.permissionLevel >= 1);
}

export async function init(): Promise<void> {
  return new Promise(res => {
    justCheckedHomeworkId = -1;
    animations = JSON.parse(localStorage.getItem("animations") ?? "true") as boolean;
    homeworkFeedbackLastPercentage = null as null | number;

    function appendFilterContent(): void {
      $("#filter-content").appendTo(`#filter-${window.innerWidth >= 768 ? "modal" : "offcanvas"}-body`);
    }

    $("#filter-toggle").on("click", function () {
      appendFilterContent();
      if (window.innerWidth >= 768) $("#filter-modal").modal("show");
      else $("#filter-offcanvas").offcanvas("show");
    });
    appendFilterContent();

    $("#search-toggle").on("change", function () {
      const checked = $(this).is(":checked");
      $("#search-homework").toggle(checked);
      if (checked) $("#search-homework input").trigger("focus");
      else $("#search-homework").val("").trigger("input");
    }).prop("checked", false).trigger("change");

    updateFilters(true);
    $(".filter-reset").on("click", () => {
      localStorage.setItem("homeworkFilter", "{}");
      updateFilters();
      renderHomeworkList();
    });

    $("#search-homework").on("input", renderHomeworkList);

    async function subjectInputCallback(this: HTMLElement): Promise<void> {
      const now = new Date();

      const selectedSubjectId = $(this).val()?.toString();
      const selectedSubjectName = $(this).find("option:selected").text();
      if (selectedSubjectId === undefined) {
        return;
      }

      const nextLessonWithDate = await getNextLessonWithDate(Number.parseInt(selectedSubjectId));

      if (selectedSubjectId === "-1" || nextLessonWithDate === null) { // "Other" or never in timetable
        $("#manage-homework-visibility-team-select").val("-1").removeClass("is-autocompleted is-suspicious");
        autocomplete($("#manage-homework-date-submission"), msToInputDate(now.setDate(now.getDate() + 7)));
        $("#manage-homework-date-submission").removeClass("is-suspicious").find("~ .autocompleted-feedback")
          .html("Automatisch: Eine Woche");
        return;
      }

      $("#manage-homework-date-submission ~ .autocompleted-feedback").html("Automatisch: Die nächste Stunde in <b></b>");

      const $submissionDate = $("#manage-homework-date-submission");
      if (autocomplete($submissionDate, msToInputDate(nextLessonWithDate.date.getTime()))) {
        // The user hasn't decided for a specific submission date
        $submissionDate.find("~ .autocompleted-feedback b").text(selectedSubjectName);
      }
      else {
        $submissionDate.trigger("autocomplete");
      }

      const teamId = nextLessonWithDate.lesson.teamId;
      autocomplete($("#manage-homework-visibility-team-select"), teamId, "");
      $("#manage-homework-visibility-team-select").find("~ .autocompleted-feedback b").text(selectedSubjectName);
      if (teamId === -1) {
        $("#manage-homework-visibility-team-select").removeClass("is-autocompleted");
      }
    }

    const checkSubmissionAfterAssignment = (): void => {
      const assignment = getInputValue($("#manage-homework-date-assignment"));
      const submission = getInputValue($("#manage-homework-date-submission"));
      if (assignment === "" || submission === "") return;
      $("#manage-homework-date-submission").toggleClass("is-invalid", new Date(assignment).getTime() > new Date(submission).getTime());
    };

    async function dateAssignmentInputCallback(this: HTMLElement): Promise<void> {
      const val = getInputValue($(this));
      if (val === "") {
        $(this).removeClass("is-suspicious");
        return;
      }

      checkSubmissionAfterAssignment();

      const date = new Date(val);
      const now = new Date();

      $(this).toggleClass("is-suspicious", date.getTime() > now.getTime() && !isSameDay(date, now));
    }

    async function dateSubmissionInputCallback(this: HTMLElement): Promise<void> {
      const val = getInputValue($(this));
      if (val === "") {
        $(this).removeClass("is-suspicious is-invalid");
        return;
      }

      checkSubmissionAfterAssignment();
      
      const date = new Date(val);
      const now = new Date();
      if (date.getTime() < now.getTime() && !isSameDay(date, now)) {
        $(this).addClass("is-suspicious").find("~ .suspicious-feedback")
          .html("Bist du dir sicher? Dieses Datum liegt in der Vergangenheit!");
        return;
      }

      const selectedSubjectId = $("#manage-homework-subject").val()?.toString() ?? "";
      const selectedSubjectName = $("#manage-homework-subject option:selected").text();

      const nextLessonWithDate = await getNextLessonWithDate(Number.parseInt(selectedSubjectId));

      if (selectedSubjectId !== "-1" && nextLessonWithDate !== null) {
        if (!nextLessonWithDate.otherWeekDays.includes(new Date(val).getDay() - 1)) {
          $(this).addClass("is-suspicious").find("~ .suspicious-feedback")
            .html(`Bist du dir sicher? An diesem Tag gibt es im Fach <b>${escapeHTML(selectedSubjectName)}</b> keinen Unterricht!`);
          return;
        }
      }

      $(this).removeClass("is-suspicious");
    }

    $("#manage-homework-subject").on("input autocomplete", function () {
      subjectInputCallback.call(this);
    });
    $("#manage-homework-date-assignment").on("input autocomplete", function () {
      dateAssignmentInputCallback.call(this);
    });
    $("#manage-homework-date-submission").on("input autocomplete", function () {
      dateSubmissionInputCallback.call(this);
    });
    $("#manage-homework-visibility-team-select").on("input autocomplete", function () {
      if (user.permissionLevel >= 1 && $(this).val() !== null) {
        $("#manage-homework-visibility-team").prop("checked", true);
      }
      checkTeamInputForSuspicious.call(this);
    });

    // On changing any information in the manage homework modal, disable the manage button if any information is empty
    $(".manage-homework-input").on("input", toggleManageHomeworkDisabled);

    $("#app").on("click", "#homework-feedback-random", prepareRandomHomework);

    $("#show-add-homework-button").on("click", () => {
      manageHomework("add", {});
    });
    
    // Request editing the homework on clicking its edit icon
    $("#app").on("click", ".homework-edit", async function () {
      manageHomework("edit", (await homeworkData()).find(h => h.homeworkId === $(this).data("id")) ?? {});
    });

    // Pin the homework on clicking its pin icon
    $("#app").on("click", ".homework-pin", function () {
      pinHomework($(this).data("id"));
    });
    
    // Clone the homework on clicking its clone icon
    $("#app").on("click", ".homework-clone", async function () {
      manageHomework("add", (await homeworkData()).find(h => h.homeworkId === $(this).data("id")) ?? {});
    });

    // Request deleting the homework on clicking its delete icon
    $("#app").on("click", ".homework-delete", function () {
      deleteHomework($(this).data("id"));
    });

    // Request checking the homework on clicking its checkbox
    $("#app").on("click", ".homework-check", function () {
      checkHomework($(this).data("id"));
    });

    // On changing the filter unchecked option, update the homework list & saved filters
    $("#filter-status-unchecked").on("change", () => {
      const filterData = JSON.parse(localStorage.getItem("homeworkFilter") ?? "{}") ?? {};
      filterData.statusUnchecked = $("#filter-status-unchecked").prop("checked");
      localStorage.setItem("homeworkFilter", JSON.stringify(filterData));
      updateFilters();
      renderHomeworkList();
    });

    // On changing the filter checked option, update the homework list & saved filters
    $("#filter-status-checked").on("change", () => {
      const filterData = JSON.parse(localStorage.getItem("homeworkFilter") ?? "{}") ?? {};
      filterData.statusChecked = $("#filter-status-checked").prop("checked");
      localStorage.setItem("homeworkFilter", JSON.stringify(filterData));
      updateFilters();
      renderHomeworkList();
    });

    // On clicking the all subjects option, check all and update the homework list
    $("#filter-subject-all").on("click", () => {
      const filterData = JSON.parse(localStorage.getItem("homeworkFilter") ?? "{}") ?? {};
      filterData.subject ??= {};
      $(".filter-subject-option").prop("checked", true);
      $(".filter-subject-option").each(function () {
        filterData.subject[$(this).data("id")] = true;
      });
      localStorage.setItem("homeworkFilter", JSON.stringify(filterData));
      updateFilters();
      renderHomeworkList();
    });

    // On clicking the none subjects option, uncheck all and update the homework list
    $("#filter-subject-none").on("click", () => {
      const filterData = JSON.parse(localStorage.getItem("homeworkFilter") ?? "{}") ?? {};
      filterData.subject ??= {};
      $(".filter-subject-option").prop("checked", false);
      $(".filter-subject-option").each(function () {
        filterData.subject[$(this).data("id")] = false;
      });
      localStorage.setItem("homeworkFilter", JSON.stringify(filterData));
      updateFilters();
      renderHomeworkList();
    });

    // If any subject filter gets changed, update the shown homework
    $("#app").on("change", ".filter-subject-option", function () {
      renderHomeworkList();
      const filterData = JSON.parse(localStorage.getItem("homeworkFilter") ?? "{}") ?? {};
      filterData.subject ??= {};
      filterData.subject[$(this).data("id")] = $(this).prop("checked");
      localStorage.setItem("homeworkFilter", JSON.stringify(filterData));
      updateFilters();
    });

    // On changing any filter date option, update the homework list
    $("#filter-date-from").on("change", function () {
      const selectedDate = new Date($(this).val()?.toString() ?? "");
      const normalDate = new Date();
      const diff = dateDaysDifference(selectedDate, normalDate);

      const filterData = JSON.parse(localStorage.getItem("homeworkFilter") ?? "{}") ?? {};
      filterData.dateFromOffset = Number.isNaN(diff) ? "NaN" : diff;
      localStorage.setItem("homeworkFilter", JSON.stringify(filterData));

      updateFilters();
      renderHomeworkList();
    });

    // On changing any filter date option, update the homework list
    $("#filter-date-until").on("change", function () {
      const selectedDate = new Date($(this).val()?.toString() ?? "");
      const normalDate = new Date();
      normalDate.setMonth(normalDate.getMonth() + 1);
      const diff = dateDaysDifference(selectedDate, normalDate);

      const filterData = JSON.parse(localStorage.getItem("homeworkFilter") ?? "{}") ?? {};
      filterData.dateUntilOffset = Number.isNaN(diff) ? "NaN" : diff;
      localStorage.setItem("homeworkFilter", JSON.stringify(filterData));
      
      updateFilters();
      renderHomeworkList();
    });
    
    const $filterOffcanvas = $("#filter-offcanvas");
    const $filterOffcanvasHeader = $("#filter-offcanvas .offcanvas-header");

    let startY = 0;
    let dragging = false;

    $filterOffcanvasHeader.on("pointerdown", ev => {
      if (ev.pointerType !== "touch") return;
      startY = ev.clientY ?? 0;
      dragging = true;
      $filterOffcanvas.css("transition", "none");
    });
    $filterOffcanvasHeader.on("pointermove", ev => {
      if (!dragging) return;
      const diff = (ev.clientY ?? 0) - startY;
      if (diff > 0) {
        $filterOffcanvas.css("transform", `translateY(${diff}px)`);
      }
    });
    $filterOffcanvasHeader.on("pointerup pointercancel", ev => {
      if (!dragging) return;
      dragging = false;
      const diff = (ev.clientY ?? 0) - startY;

      $filterOffcanvas.css({transition: "transform 0.3s ease-in-out", transform: ""});
      if (diff > 100) {
        $filterOffcanvas.offcanvas("hide");
      }
    });

    res();
  });
}

let justCheckedHomeworkId: number;
let animations: boolean;
let homeworkFeedbackLastPercentage: null | number;
let randomHomeworkDeactivated: number[] = [];

await lessonData.init();
(await homeworkData.init()).on("update", onlyThisSite(renderHomeworkList));
(await homeworkCheckedData.init()).on("update", onlyThisSite(renderHomeworkList));
(await subjectData.init()).on("update", onlyThisSite(renderSubjectList));
(await teamsData.init()).on("update", onlyThisSite(() => {
  renderTeamList(); 
  renderHomeworkList(); 
}));

(await joinedTeamsData.init()).on("update", onlyThisSite(renderHomeworkList));

export async function renderAllFn(): Promise<void> {
  await renderSubjectList();
  await renderHomeworkList();
  await renderTeamList();

  toggleShownButtons();
};
