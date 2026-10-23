import { getSite, user } from "../../global/global.js";

function calculateHeight(): void {
  let height = 38 + Math.max(8, globalThis.innerWidth / 100 * 1.5) * 1.5;
  if (globalThis.innerWidth >= 992) height = 0;
  $("body").css("--bottombar-height", height + "px");
}

export async function init(): Promise<void> {
  siteName = getSite();
  $(".bottombar-link").removeClass("bottombar-current-link").filter(`[href="/${siteName}"]`).addClass("bottombar-current-link");
}

calculateHeight();
$(globalThis).on("resize", calculateHeight);

let siteName: string;

function toggleShownLinks(): void {
  $(".bottombar-joined").toggle(user.classJoined ?? false);
  $(".bottombar-not-joined").toggle(! user.classJoined);
}

user.on("change", toggleShownLinks);
toggleShownLinks();

$(".bottombar-overlay").hide();

$(".bottombar-link").on("click", function() {
  $(this).addClass("pop");
  setTimeout(() => {
    $(this).removeClass("pop");
  }, 300);
});

let startX = 0;
let startY = 0;
let endX = 0;
let endY = 0;
let startTime = 0;
let dragging = false;
let startSide: "left" | "right";
let endSide: "left" | "right";

$(document).on("pointerdown", ev => {
  if (ev.pointerType !== "touch") return;
  if (screen.width / window.innerWidth !== 1) return;
  if ($(".modal, .offcanvas").is(".show")) return;

  startTime = Date.now();
  startX = endX = ev.clientX ?? 0;
  startY = endY = ev.clientY ?? 0;

  if (startX < window.innerWidth * 0.2) {
    startSide = "left";
    endSide = "right";
  }
  else if (startX > window.innerWidth * 0.8) {
    startSide = "right";
    endSide = "left";
  }
  else return;

  const $currentLink = $(".bottombar .row:visible .bottombar-current-link");
  const $navigatedToLink = { left: $currentLink.prev(), right: $currentLink.next()}[startSide];

  if ($navigatedToLink.length === 0) return;

  dragging = true;

  $(".bottombar-overlay").css("transition", "");
  $(".bottombar-overlay i").attr("class", $navigatedToLink.find("i").attr("class") + " fs-1");
  $(".bottombar-overlay span").text($navigatedToLink.find("span").text());
});

$(document).on("pointermove", ev => {
  if (!dragging) return;

  endX = ev.clientX ?? 0;
  endY = ev.clientY ?? 0;
  const diffX = endX - startX;
  const diffY = endY - startY;

  if (Math.abs(diffX) > Math.abs(diffY)) {
    $(".bottombar-overlay").css({
      opacity: Math.abs(diffX) / globalThis.innerWidth * 2,
      [startSide]: 0,
      [endSide]: endSide === "left" ? endX : (globalThis.innerWidth - endX)
    }).show();
  }
});

$(document).on("pointerup pointercancel", async () => {
  if (!dragging) return;
  dragging = false;

  async function changeSite(): Promise<void> {
    const $currentLink = $(".bottombar .row:visible .bottombar-current-link");
    const $navigatedToLink = { left: $currentLink.prev(), right: $currentLink.next()}[startSide];
    const loadingBarMod = await import("../loadingBar/loadingBar.js");
    await loadingBarMod.replaceSitePJAX($navigatedToLink.attr("href") ?? siteName);
  }
  function hasBeenDraggedEnough(): boolean {
    return Math.abs(diffX) > (window.innerWidth * 0.4) || (Math.abs(diffX) > (window.innerWidth * 0.2) && timePassed < 500);
  }
  
  const timePassed = Date.now() - startTime;
  const diffX = endX - startX;

  $(".bottombar-overlay").css("transition", "0.3s ease-in-out");
  if (hasBeenDraggedEnough()) {
    $(".bottombar-overlay").css({
      opacity: 1,
      [endSide]: 0
    });

    await changeSite();

    $(".bottombar-overlay").css({ opacity: 0 });
    setTimeout(() => {
      $(".bottombar-overlay").hide();
    }, 300);
  }
  else {
    $(".bottombar-overlay").css({
      opacity: 0,
      [endSide]: "100%"
    });
  }
});
