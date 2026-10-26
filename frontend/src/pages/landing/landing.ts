function setupFeatures(): void {
  const features = document.getElementById("features")!;
  const selection = [...document.getElementById("feature-selection")!.children];
  selection.forEach((e, i) => {
    if (i === 0) e.classList.add("feature-selection-selected");
    e.addEventListener("click", () => {
      features.scrollTo({ left: i * features.clientWidth, behavior: "smooth" });
    });
  });

  features.addEventListener("scroll", () => {
    const index = Math.max(0, Math.min(selection.length - 1, Math.round(features.scrollLeft / features.clientWidth)));
    const selected = selection[index];
    if (!selected || selected.classList.contains("feature-selection-selected")) return;

    selection.forEach((e, i) => e.classList.toggle("feature-selection-selected", i === index));
    selected.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest"
    });
  }, { passive: true });
}

function timingFunction(t: number, maxVal: number): number {
  return Math.min((t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)) * maxVal, maxVal);
}

const statsDuration = 2000;

async function initStats(statsStart: number): Promise<void> {
  let res;
  try {
    const response = await fetch("/stats");
    if (!response.ok) throw new Error(`/stats responded with ${response.status}`);
    res = await response.json();
  }
  catch {
    document.getElementById("stats-section")!.hidden = true;
    return;
  }

  const firstDay = new Date(2025, 4, 1);

  const stats = [
    { name: "months", end: (new Date().getFullYear() - firstDay.getFullYear()) * 12 + (new Date().getMonth() - firstDay.getMonth()) },
    { name: "users", end: res.registeredUsers },
    { name: "classes", end: res.registeredClasses },
    { name: "content", end: res.createdHomeworkAndEvents }
  ];

  updateStats(stats, statsStart);
}

function updateStats(stats: {name: string, end: number}[], statsStart: number): void {
  const elapsed = performance.now() - statsStart;
  const t = elapsed / statsDuration;

  for (const s of stats) {
    const value = timingFunction(t, s.end);
    document.getElementById("stat-" + s.name)!.textContent = Math.round(value).toString() + "+";
  }
  if (elapsed <= statsDuration) requestAnimationFrame(() => updateStats(stats, statsStart));
}

function setupQuotes(): void {
  const container = document.getElementById("quotes")!;
  const num = container.children.length;
  const first = container.children[0];
  const second = container.children[1];
  const prevlast = container.children[num - 2];
  const last = container.children[num - 1];
  const quoteWidth = first.getBoundingClientRect().width;
  container.append(first.cloneNode(true));
  container.append(second.cloneNode(true));
  container.prepend(last.cloneNode(true));
  container.prepend(prevlast.cloneNode(true));

  container.scrollLeft = quoteWidth + 16;
  container.addEventListener("scroll", () => {
    if (Math.abs(container.scrollLeft) < 1) {
      container.scrollLeft = num * (quoteWidth + 16);
    }
    else if (Math.abs(container.scrollLeft - (num + 1) * (quoteWidth + 16)) < 1) {
      container.scrollLeft = quoteWidth + 16;
    }
  });

  document.getElementById("quotes-caroussel-left")?.addEventListener("click", () => {
    container.scrollBy({
      left: - quoteWidth - 16,
      behavior: "smooth"
    });
  });

  document.getElementById("quotes-caroussel-right")?.addEventListener("click", () => {
    container.scrollBy({
      left: quoteWidth + 16,
      behavior: "smooth"
    });
  });

  if (window.matchMedia("(hover: hover)").matches && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setInterval(() => {
      if (!document.hidden && !container.matches(":hover") && !container.matches(":focus-within")) container.scrollLeft += 1;
    }, 10);
  }
}

function toggleScrollFade(el: HTMLElement): void {
  const toBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  el.style.setProperty("--fade-progress", Math.min(32, toBottom) + "px");
}

function initScrollFade(el: HTMLElement): void {
  toggleScrollFade(el);

  new ResizeObserver(() => toggleScrollFade(el)).observe(el);

  el.addEventListener("scroll", () => {
    toggleScrollFade(el);
  });
}

window.addEventListener("load", () => {
  setupFeatures();

  const statsObserver = new IntersectionObserver((entries, observer) => {
    if (entries[0].isIntersecting) {
      initStats(performance.now());
      observer.unobserve(entries[0].target);
    }
  }, {threshold: 0.25});

  statsObserver.observe(document.querySelector("#stats")!);

  document.querySelectorAll(".scroll-fade").forEach(e => initScrollFade(e as HTMLElement));

  const scrollFadeObserver = new MutationObserver(mutations => {
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

  scrollFadeObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  document.querySelectorAll(".details").forEach(el => el.addEventListener("click", () => {
    if (el.hasAttribute("open")) {
      [...el.children].forEach(c => (c as HTMLElement).style.height = "0px");
    }
    else {
      [...el.children].forEach(c => (c as HTMLElement).style.height = c.scrollHeight + 16 + "px");
    }
    el.toggleAttribute("open");
  }));

  const fullscreenContainer = document.getElementById("img-fullscreen-container")!;
  const fullscreenImage = document.getElementById("img-fullscreen-image") as HTMLImageElement;
  const fullscreenDescription = document.getElementById("img-fullscreen-description")!;
  document.addEventListener("click", ev => {
    let src = "";
    let description = "";
    document.querySelectorAll(".img-fullscreenable").forEach(el => {
      const imgEl = el.querySelector("img") as HTMLImageElement;
      if (ev.target === imgEl && fullscreenImage.src !== imgEl.currentSrc) {
        src = imgEl.currentSrc;
        description = el.closest(".feature")?.querySelector(".feature-description")?.textContent?.trim() ?? "";
      }
    });
    fullscreenImage.src = src;
    fullscreenDescription.textContent = description;
    fullscreenContainer.classList.toggle("visible", src !== "");
  });

  document.body.style.display = "block";

  setupQuotes();
});
