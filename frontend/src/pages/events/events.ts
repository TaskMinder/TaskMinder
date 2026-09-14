import {
  dateToMs,
  eventData,
  eventTypeData,
  isSameDay,
  joinedTeamsData,
  getDisplayDate,
  msToInputDate,
  teamsData,
  lessonData,
  escapeHTML,
  dateDaysDifference,
  onlyThisSite,
  ajax,
  user,
  checkTeamInputForSuspicious,
  getInputValue,
  RelativeDirection,
  showButtonLoading
} from "../../global/global.js";
import { EventData, SingleEventData } from "../../global/types";
import { richTextToHtml, richTextToPlainText } from "../../snippets/richTextarea/richTextarea.js";
import { SearchBox } from "../../snippets/richInput/richInput.js";

async function renderEventList(): Promise<void> {
  async function getFilteredData(): Promise<EventData> {
    // Get the event data
    let data = await eventData();

    // Filter by team
    const currentJoinedTeamsData = await joinedTeamsData();
    data = data.filter(e => currentJoinedTeamsData.includes(e.teamId) || e.teamId === -1);
    
    const pinned = data.filter(e => e.isPinned);
    data = data.filter(e => ! e.isPinned);
    // Filter by min. date
    const filterDateMin = Date.parse($("#filter-date-from").val()?.toString() ?? "");
    if (! Number.isNaN(filterDateMin)) {
      data = data.filter(e => filterDateMin <= Number.parseInt(e.endDate ?? e.startDate) || isSameDay(filterDateMin, e.endDate ?? e.startDate));
    }
    // Filter by max. date
    const filterDateMax = Date.parse($("#filter-date-until").val()?.toString() ?? "");
    if (! Number.isNaN(filterDateMax)) {
      data = data.filter(e => filterDateMax >= Number.parseInt(e.startDate) || isSameDay(filterDateMax, e.startDate));
    }
    // Filter by search
    const sb = ($("#search-events")[0] as SearchBox);
    data = data.filter(e => sb.searchMatches(e.name, richTextToPlainText(e.description ?? "")));
    // Filter by type
    data = data.filter(e => $(`#filter-type-${e.eventTypeId}`).prop("checked"));

    data = pinned.concat(data);
    
    return data;
  }

  const newGalleryContent = $("<div></div>");
  const newTableContent = $("<div></div>");

  const data = await getFilteredData();

  for (const event of data) {
    const eventId = event.eventId;
    const eventTypeId = event.eventTypeId;
    const name = event.name;
    const description = event.description;
    const startDate = getDisplayDate(event.startDate, {relativeDirection: RelativeDirection.FUTURE});
    const lesson = event.lesson;

    const timeSpan = $("<span></span>");
    if (event.endDate !== null) {
      const endDate = getDisplayDate(event.endDate, {relativeDirection: RelativeDirection.FUTURE});
      if (isSameDay(event.startDate, event.endDate)) {
        timeSpan.append("<b>Ganztägig</b> ", startDate);
      }
      else {
        timeSpan.append(startDate, " - ", endDate);
      }
    }
    else if (lesson !== null && lesson !== "") {
      timeSpan.append(startDate, ` <b>(${escapeHTML(lesson)}. Stunde)</b>`);
    }
    else {
      timeSpan.append(startDate);
    }
    const variant =  `data-variant="event-${eventTypeId}"`;
    const buttons = `
      <button class="btn btn-sm btn-semivisible event-edit"
        data-id="${eventId}" aria-label="Bearbeiten">
        <i class="fas fa-edit opacity-75" ${variant} aria-hidden="true"></i>
      </button>

      <div class="dropdown">
        <button class="btn btn-sm btn-semivisible" data-bs-toggle="dropdown" aria-label="Mehr Aktionen">
          <i class="fas fa-ellipsis-vertical opacity-75" ${variant} aria-hidden="true"></i>
        </button>
        <ul class="dropdown-menu">
          <button class="dropdown-item event-pin" ${variant} data-id="${eventId}">
            <i class="fas fa-thumbtack${event.isPinned ? "-slash" : ""} opacity-75" ${variant} aria-hidden="true"></i>
            ${event.isPinned ? "Lösen" : "Anheften"}
          </button>
          <button class="dropdown-item event-clone" ${variant} data-id="${eventId}">
            <i class="fas fa-clone opacity-75" ${variant} aria-hidden="true"></i> Duplizieren
          </button>
          <button class="dropdown-item event-share" ${variant} data-id="${eventId}">
            <i class="fas fa-share-from-square opacity-75" ${variant} aria-hidden="true"></i> Teilen
          </button>
          <hr class="dropdown-divider">
          <button class="dropdown-item dropdown-item-danger event-delete" data-id="${eventId}">
            <i class="fas fa-trash opacity-75" aria-hidden="true"></i> Löschen
          </button>
        </ul>
      </div>`;
    // The template for an event
    const galleryTemplate = $(`
      <div class="col pb-3 px-2">
        <div class="card h-100 event${event.accountId === null ? "" : " event-private"}" ${variant}>
          <div class="card-body p-2">
            <div class="d-flex justify-content-between">
              <div style="min-width: 0;">
                <i class="fas fa-thumbtack ${event.isPinned ? "" : "d-none"} opacity-75" ${variant} aria-hidden="true">
                </i><i class="fas fa-user-lock ${event.accountId ? "" : "d-none"} opacity-75" ${variant} aria-hidden="true"></i>
                <span class="fw-bold event-title" ${variant}>${escapeHTML(name)}</span>
                <br>
                <span>${timeSpan.html()}</span>
              </div>
              <div class="d-flex flex-nowrap align-items-start">${buttons}</div>
            </div>
            <div class="event-description"></div>
          </div>
        </div>
      </div>
      `);

    const tableTemplate = $(`
      <tr class="event${event.accountId === null ? "" : " event-private"}">
        <td class="text-nowrap"><div class="color-display" ${variant}></div></td>
        <td class="text-break">
          <i class="fas fa-thumbtack ${event.isPinned ? "" : "d-none"} opacity-75" ${variant} aria-hidden="true">
          </i><i class="fas fa-user-lock ${event.accountId ? "" : "d-none"} opacity-75" ${variant} aria-hidden="true"></i>
          <span class="fw-bold" ${variant}>${escapeHTML(name)}</span>
          <br>
          <span class="badge badge-tertiary rounded-pill border"><i class="far fa-calendar me-1" aria-hidden="true"></i>${timeSpan.html()}</span>
        </td>
        <td class="text-break"><div class="event-description"></div></td>
        <td class="text-nowrap">
          <div class="d-flex flex-nowrap justify-content-end">
            ${buttons}
          </div>
        </td>
      </tr>
    `);

    // Add this event to the list
    newGalleryContent.append(galleryTemplate);
    newTableContent.append(tableTemplate);

    richTextToHtml(description, galleryTemplate.find(".event-description"), {
      showMoreButton: true,
      showMoreButtonChange: b => b.addClass("event-" + eventTypeId),
      parseLinks: true,
      merge: true
    });

    richTextToHtml(description, tableTemplate.find(".event-description"), {
      showMoreButton: true,
      showMoreButtonChange: b => b.addClass("event-" + eventTypeId),
      parseLinks: true,
      merge: true
    });
  }

  newTableContent.children().last().find("td").addClass("border-bottom-0");

  // If no events match, add an explanation text
  $("#no-events-found").toggle(data.length === 0);
  $("#event-gallery").empty().append(newGalleryContent.children()).toggleClass("d-none", data.length === 0);
  $("#event-table-body").empty().append(newTableContent.children());
  $("#event-table").toggleClass("d-none", data.length === 0);

  toggleShownButtons();
};

async function renderEventTypeList(): Promise<void> {
  const currentEventTypeData = await eventTypeData();

  const manageEventTypeVal = $("#manage-event-type").val() ?? "";
  // Clear the select element in the manage event modal
  $("#manage-event-type").html('<option value="" disabled selected>Art</option>');
  // Clear the list for filtering by type
  $("#filter-type-list").empty();

  const filterData = JSON.parse(localStorage.getItem("eventFilter") ?? "{}") ?? {};
  filterData.type ??= {};

  for (const eventType of currentEventTypeData) {
    // Get the event type data
    const eventTypeId = eventType.eventTypeId;
    const eventTypeName = escapeHTML(eventType.name);

    filterData.type[eventTypeId] ??= true;
    const checkedStatus = filterData.type[eventTypeId] ? "checked" : "";
    if (checkedStatus !== "checked") $("#filter-changed").show();

    // Add the template for filtering by type
    const templateFilterType = `
      <label class="form-check flex-grow-1 text-center mb-0 ps-2rem pe-2 py-1 border rounded bg-body-tertiary">
        <input type="checkbox" class="form-check-input filter-type-option me-2"
          id="filter-type-${eventTypeId}" data-id="${eventTypeId}" ${checkedStatus}>
        ${eventTypeName}
      </label>
      `;
    $("#filter-type-list").append(templateFilterType);

    // Add the template for the select elements
    $("#manage-event-type").append(`<option value="${eventTypeId}">${eventTypeName}</option>`);
  };

  if (manageEventTypeVal !== "") $("#manage-event-type").val(manageEventTypeVal);

  localStorage.setItem("eventFilter", JSON.stringify(filterData));

  $("#manage-event-no-types").toggleClass("d-none", currentEventTypeData.length !== 0).find("b").text(
    user.permissionLevel < 3 ?
      "Bitte einen Admin / ein:e Manager:in, welche hinzuzufügen!" :
      "Füge in den Einstellungen unter \"Klasse\" > \"Ereignisarten\" welche hinzu!"
  );
};

async function renderTeamList(): Promise<void> {
  const manageEventTeamVal = $("#manage-event-visibility-team-select").val() ?? "-1";

  // Clear the select element in the manage event modal
  $("#manage-event-visibility-team-select").html('<option value="-1" disabled selected>Team</option>');

  const currentJoinedTeamsData = await joinedTeamsData();
  for (const team of (await teamsData()).filter(t => currentJoinedTeamsData.includes(t.teamId))) {
    // Add the template for the select elements
    $("#manage-event-visibility-team-select").append(`<option value="${team.teamId}">${escapeHTML(team.name)}</option>`);
  }

  $("#manage-event-visibility-team-select").val(manageEventTeamVal);
};

function toggleManageEventDisabled(): void {
  const type = $("#manage-event-type").val();
  const name = $("#manage-event-name").val()?.toString().trim();
  const startDate = $("#manage-event-start-date").val();

  $(".manage-event-button").prop("disabled",
    [name, startDate].includes("") ||
    type === null ||
    $("#manage-event-end-date").hasClass("is-invalid") ||
    ($("#manage-event-visibility-team").prop("checked") && $("#manage-event-visibility-team-select").val() === null)
  );
}

function manageEvent(mode: "add" | "edit", event: Partial<SingleEventData>): void {
  // Reset the data inputs in the manage event modal
  $("#manage-event-type").val(event?.eventTypeId ?? "");
  $("#manage-event-name").val(event?.name ?? "");
  $("#manage-event-description").val(event?.description ?? "");
  $("#manage-event-description").trigger("change");
  $("#manage-event-start-date").val(msToInputDate(event?.startDate ?? ""));
  $("#manage-event-lesson").val(event?.lesson ?? "");
  $("#manage-event-end-date").val(msToInputDate(event?.endDate ?? ""));
  const visibility = user.permissionLevel === 0 ? "private" : (event?.accountId ? "private" : (event?.teamId ?? -1) === -1 ? "all" : "team");
  $("#manage-event-visibility-private").prop("checked", visibility === "private");
  $("#manage-event-visibility-team").prop("checked", visibility === "team");
  $("#manage-event-visibility-all").prop("checked", visibility === "all");
  $("#manage-event-visibility-team-select").val(event?.teamId ?? "-1");

  $(".manage-event-input").removeClass("is-autocompleted is-suspicious is-invalid");
  $("#manage-event-description").trigger("change");

  // Adjust according to the mode
  $("#manage-event-modal-label").text(mode === "add" ? "Ereignis hinzufügen" : "Ereignis bearbeiten");
  $(".manage-event-button").prop("disabled", true);
  $("#manage-event-add-button").toggle(mode === "add");
  $("#manage-event-delete-button, #manage-event-edit-button").toggle(mode === "edit");

  // Show the manage event modal
  $("#manage-event-modal").modal("show");

  // Called when the user clicks the primary button in the modal
  // Note: .off("click") removes the existing click event listener from a previous call of this function
  $(".manage-event-button").off("click").on("click", async () => {
    // Save the given information in variables
    const eventTypeId = $("#manage-event-type").val();
    const name = $("#manage-event-name").val()?.toString().trim();
    const description = $("#manage-event-description").val()?.toString().trim();
    const startDate = $("#manage-event-start-date").val()?.toString() ?? "";
    const lesson = $("#manage-event-lesson").val()?.toString().trim();
    const endDate = $("#manage-event-end-date").val()?.toString() ?? "";
    const isPersonal = $("#manage-event-visibility-private").prop("checked");
    const teamId = $("#manage-event-visibility-team").prop("checked") ? $("#manage-event-visibility-team-select").val() : -1;
    const body = {
      eventTypeId,
      name,
      description,
      startDate: dateToMs(startDate),
      lesson,
      endDate: dateToMs(endDate) ?? null,
      isPersonal,
      teamId
    };

    const ajaxPromise = mode === "add"
      ? ajax("POST", "/api/events", { body, queueable: true })
      : ajax("PATCH", `/api/events/${event!.eventId}`, { body, queueable: true });

    showButtonLoading($(".manage-event-button:visible"), ajaxPromise);
    await ajaxPromise;

    $("#manage-event-modal").modal("hide");
  });

  $("#manage-event-delete-button").off("click").on("click", () => {
    deleteEvent(event?.eventId ?? -1);
  });
}

async function shareEvent(eventId: number): Promise<void> {
  async function parseLessonEvent(event: SingleEventData, lesson: string): Promise<void> {
    async function findLessonWithLessonNumber(lessonNumber: number):
      Promise< {
        lessonId: number;
        lessonNumber: number;
        weekDay: 0 | 1 | 2 | 3 | 4;
        teamId: number;
        subjectId: number;
        room: string;
        startTime: string;
        endTime: string;
      } | undefined > {
      return (await lessonData()).find(lesson =>
        lesson.lessonNumber === lessonNumber
        && (lesson.teamId === -1 || currentJoinedTeamsData.includes(lesson.teamId))
        && lesson.weekDay === start.getDay() - 1
      );
    }
    const start = new Date(Number.parseInt(event.startDate));
    const end = new Date(Number.parseInt(event.startDate));
    const currentJoinedTeamsData = (await joinedTeamsData());
    
    let startLesson, endLesson;
    if (event.lesson?.includes("-")) {
      event.lesson = event.lesson.replace(" ", "");
      startLesson = await findLessonWithLessonNumber(Number.parseInt(event.lesson.split("-")[0]));
      endLesson = await findLessonWithLessonNumber(Number.parseInt(event.lesson.split("-")[1]));
    }
    else {
      startLesson = endLesson = await findLessonWithLessonNumber(Number.parseInt(lesson));
    }

    if (! (startLesson && endLesson)) {
      throw new Error("startLesson or endLesson is undefined");
    }
    const lessonStart = Number.parseInt(startLesson.startTime) / 1000 / 60;
    start.setHours(Math.trunc(lessonStart / 60), lessonStart % 60);
    
    const lessonEnd = Number.parseInt(endLesson.endTime) / 1000 / 60;
    end.setHours(Math.trunc(lessonEnd / 60), lessonEnd % 60);
    timeContent = `
      DTSTART:${formatDateAndTime(start)}
      DTEND:${formatDateAndTime(end)}
    `;
  }
  const event = (await eventData()).find(e => e.eventId === eventId);
  if (!event) throw new Error("No event with this id found");

  const name = event.name;
  let description = "";
  $(richTextToHtml(event.description ?? "")).each(function () {
    if ($(this).is("br")) {
      description += String.raw`\n`;
    }
    else {
      description += $(this).html();
    }
  });

  const format = (num: number): string => String(num).padStart(2, "0");

  function formatDateAndTime (date: Date): string {
    return date.getUTCFullYear().toString() +
      format(date.getUTCMonth() + 1) +
      format(date.getUTCDate()) + "T" +
      format(date.getUTCHours()) +
      format(date.getUTCMinutes()) +
      format(date.getUTCSeconds()) + "Z";
  };

  function formatDate (date: Date): string {
    return date.getUTCFullYear().toString() +
      format(date.getUTCMonth() + 1) +
      format(date.getUTCDate());
  };

  let timeContent = "";

  if (event.lesson !== null && event.lesson !== "") {
    try {
      await parseLessonEvent(event, event.lesson);
    }
    catch {
      $("#share-event-error-toast").toast("show");
      return;
    }
  }
  else {
    if (event.endDate === null || event.endDate === "") {
      event.endDate = event.startDate;
    }
    const start = new Date(Number.parseInt(event.startDate));
    const end = new Date(Number.parseInt(event.endDate) + 1000 * 60 * 60 * 24);
    timeContent = `
      DTSTART;VALUE=DATE:${formatDate(start)}
      DTEND;VALUE=DATE:${formatDate(end)}
    `;
  }

  const icsContent = `
    BEGIN:VCALENDAR
    VERSION:2.0
    PRODID:-//https://taskminder.de
    BEGIN:VEVENT
    UID:event-${eventId}@taskminder.de
    DTSTAMP:${formatDateAndTime(new Date())}
    ${timeContent}
    SUMMARY:${name}
    DESCRIPTION:${description?.replaceAll("\n", String.raw`\n`)}
    END:VEVENT
    END:VCALENDAR
  `.split("\n").map(l => l.trim()).join("\n");

  const blob = new Blob([icsContent], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "event.ics";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();

  a.remove();
  URL.revokeObjectURL(url);
}

async function pinEvent(eventId: number): Promise<void> {
  const event = (await eventData()).find(e => e.eventId === eventId);
  if (!event) return;

  await ajax("PATCH", `/api/events/${eventId}/pin`, {
    body: {
      pinStatus: !event.isPinned
    },
    queueable: true
  });
}

function deleteEvent(eventId: number): void {
  //
  // CALLED WHEN THE USER CLICKS THE "DELETE" OPTION OF AN EVENT, NOT WHEN USER ACTUALLY DELETES AN EVENT
  //

  // Show a confirmation notification
  $("#delete-event-confirm-toast").toast("show");

  // Called when the user clicks the "confirm" button in the notification
  // Note: .off("click") removes the existing click event listener from a previous call of this function
  $("#delete-event-confirm-toast-button")
    .off("click")
    .on("click", async () => {
      // Hide the confirmation toast
      $("#delete-event-confirm-toast").toast("hide");

      const ajaxPromise = ajax("DELETE", `/api/events/${eventId}`, {
        queueable: true
      });
      showButtonLoading($("#delete-event-confirm-toast-button"), ajaxPromise);
      await ajaxPromise;
      
      $("#manage-event-modal").modal("hide");
      $("#delete-event-success-toast").toast("show");
    });
}

async function updateFilters(ingoreEventTypes?: boolean): Promise<void> {
  return new Promise(res => {
    $("#filter-changed").hide();

    const filterData = JSON.parse(localStorage.getItem("eventFilter") ?? "{}") ?? {};

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

    if (! ingoreEventTypes) {
      renderEventTypeList();
    }
    res();
  });
}

function toggleShownButtons(): void {
  $("#manage-event-only-private").toggle(user.permissionLevel === 0);
  $("#manage-event-visibility-label, #manage-event-visibility").toggle(user.permissionLevel >= 1);
  $("#show-add-event-button").toggle(user.permissionLevel >= 1 || (user.loggedIn ?? false));
  $(".event:not(.event-private)").find(".event-edit, .event-pin, .event-delete, .dropdown-divider:has(~ .event-delete)")
    .toggle(user.permissionLevel >= 1);
}

function toggleView(): void {
  if (view === View.Gallery || globalThis.innerWidth < 768) {
    $("#view-toggle").html("<i class=\"fa-solid fa-table-list\" aria-hidden=\"true\"></i> Tabelle");
    $("#event-gallery").show();
    $("#event-table").hide();
  }
  else {
    $("#view-toggle").html("<i class=\"fa-solid fa-grip\" aria-hidden=\"true\"></i> Galerie");
    $("#event-gallery").hide();
    $("#event-table").show();
  }
  localStorage.setItem("eventView", view);
}

export async function init(): Promise<void> {
  return new Promise(res => {
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
      $("#search-events").toggle(checked);
      if (checked) $("#search-events input").trigger("focus");
      else $("#search-events").val("").trigger("input");
    }).prop("checked", false).trigger("change");

    view = localStorage.getItem("eventView") as View ?? View.Gallery;
    toggleView();
    $("#view-toggle").on("click", () => {
      view = view === View.Gallery ? View.Table : View.Gallery;
      toggleView();
    });

    updateFilters(true);
    $(".filter-reset").on("click", () => {
      localStorage.setItem("eventFilter", "{}");
      updateFilters();
      renderEventList();
    });

    $("#search-events").on("input", renderEventList);

    const checkEndDateAfterStartDate = (): void => {
      const start = getInputValue($("#manage-event-start-date"));
      const end = getInputValue($("#manage-event-end-date"));
      if (start === "" || end === "") return;
      $("#manage-event-end-date").toggleClass("is-invalid", new Date(start).getTime() > new Date(end).getTime());
    };

    function startDateInputCallback(this: HTMLElement): void {
      checkEndDateAfterStartDate();
    }

    function endDateInputCallback(this: HTMLElement): void {
      const val = getInputValue($(this));
      if (val === "") {
        $(this).removeClass("is-suspicious is-invalid");
        return;
      }

      checkEndDateAfterStartDate();

      const date = new Date(val);
      const now = new Date();

      $(this).toggleClass("is-suspicious", date.getTime() < now.getTime() && !isSameDay(date, now));
    }
    
    $("#manage-event-start-date").on("input autocomplete", function () {
      startDateInputCallback.call(this);
    });
    $("#manage-event-end-date").on("input autocomplete", function () {
      endDateInputCallback.call(this);
    });
    $("#manage-event-visibility-team-select").on("input autocomplete", function () {
      $("#manage-event-visibility-team").prop("checked", true);
      checkTeamInputForSuspicious.call(this);
    });

    // On changing any information in the manage event modal, disable the manage button if any information is empty
    $(".manage-event-input").on("input change", function () {
      toggleManageEventDisabled();
      if ($(this).is("#manage-event-end-date")) {
        $("#manage-event-lesson").val("");
      }
      if ($(this).is("#manage-event-lesson")) {
        $("#manage-event-end-date").val("");
      }
    });

    $("#app").on("click", "#show-add-event-button", () => {
      manageEvent("add", {});
    });

    // Request editing the event on clicking its edit icon
    $("#app").on("click", ".event-edit", async function () {
      manageEvent("edit", (await eventData()).find(e => e.eventId === $(this).data("id")) ?? {});
    });

    // Pin the event on clicking its pin icon
    $("#app").on("click", ".event-pin", function () {
      pinEvent($(this).data("id"));
    });

    // Share the event on clicking its share icon
    $("#app").on("click", ".event-share", function () {
      shareEvent($(this).data("id"));
    });

    // Clone the event on clicking its clone icon
    $("#app").on("click", ".event-clone", async function () {
      manageEvent("add", (await eventData()).find(e => e.eventId === $(this).data("id")) ?? {});
    });

    // Request deleting the event on clicking its delete icon
    $("#app").on("click", ".event-delete", function () {
      deleteEvent($(this).data("id"));
    });

    // On clicking the all types option, check all and update the event list
    $("#filter-type-all").on("click", () => {
      const filterData = JSON.parse(localStorage.getItem("eventFilter") ?? "{}") ?? {};
      $(".filter-type-option").prop("checked", true);
      $(".filter-type-option").each(function () {
        filterData.type[$(this).data("id")] = true;
      });
      localStorage.setItem("eventFilter", JSON.stringify(filterData));
      updateFilters();
      renderEventList();
    });

    // On clicking the none types option, uncheck all and update the event list
    $("#filter-type-none").on("click", () => {
      const filterData = JSON.parse(localStorage.getItem("eventFilter") ?? "{}") ?? {};
      $(".filter-type-option").prop("checked", false);
      $(".filter-type-option").each(function () {
        filterData.type[$(this).data("id")] = false;
      });
      localStorage.setItem("eventFilter", JSON.stringify(filterData));
      updateFilters();
      renderEventList();
    });

    // If any type filter gets changed, update the shown events
    $("#app").on("change", ".filter-type-option", function () {
      renderEventList();
      const filterData = JSON.parse(localStorage.getItem("eventFilter") ?? "{}") ?? {};
      filterData.type ??= {};
      filterData.type[$(this).data("id")] = $(this).prop("checked");
      localStorage.setItem("eventFilter", JSON.stringify(filterData));
      updateFilters();
    });

    // On changing any filter date option, update the event list
    $("#filter-date-from").on("change", function () {
      const selectedDate = new Date($(this).val()?.toString() ?? "");
      const normalDate = new Date();
      const diff = dateDaysDifference(selectedDate, normalDate);

      const filterData = JSON.parse(localStorage.getItem("eventFilter") ?? "{}") ?? {};
      filterData.dateFromOffset = Number.isNaN(diff) ? "NaN" : diff;
      localStorage.setItem("eventFilter", JSON.stringify(filterData));

      updateFilters();
      renderEventList();
    });

    // On changing any filter date option, update the event list
    $("#filter-date-until").on("change", function () {
      const selectedDate = new Date($(this).val()?.toString() ?? "");
      const normalDate = new Date();
      normalDate.setMonth(normalDate.getMonth() + 1);
      const diff = dateDaysDifference(selectedDate, normalDate);

      const filterData = JSON.parse(localStorage.getItem("eventFilter") ?? "{}") ?? {};
      filterData.dateUntilOffset = Number.isNaN(diff) ? "NaN" : diff;
      localStorage.setItem("eventFilter", JSON.stringify(filterData));
      
      updateFilters();
      renderEventList();
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

enum View {
  Gallery = "gallery",
  Table = "table"
}
let view: View;

$(globalThis).on("resize", toggleView);

(await eventData.init()).on("update", onlyThisSite(renderEventList));
(await eventTypeData.init()).on("update", onlyThisSite(renderEventTypeList));
(await teamsData.init()).on("update", onlyThisSite(() => {
  renderTeamList();
  renderEventList(); 
}));

(await joinedTeamsData.init()).on("update", onlyThisSite(renderEventList));

export async function renderAllFn(): Promise<void> {
  await renderEventTypeList();
  await renderEventList();
  await renderTeamList();

  toggleShownButtons();
};
