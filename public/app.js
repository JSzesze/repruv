const form = document.querySelector("#extract-form");
const input = document.querySelector("#url");
const result = document.querySelector("#result");
const errorBox = document.querySelector("#error");
const errorMessage = document.querySelector("#error-message");
const output = document.querySelector("#output");
const title = document.querySelector("#title");
const meta = document.querySelector("#meta");
const submit = form.querySelector("button[type=submit]");
const copy = document.querySelector("#copy");
const share = document.querySelector("#share");
const download = document.querySelector("#download");
const clear = document.querySelector("#clear");
const anew = document.querySelector("#new");
const shell = document.querySelector(".input-shell");
const examples = document.querySelectorAll(".example");

let current = null;
let revealToken = 0;

const track = window.repruvTrack || (() => {});
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
input.addEventListener("input", () => track("input_engaged"), { once: true });

function setDotsMode(mode) {
  window.repruvDots?.setMode?.(mode);
}

function setLoading(loading) {
  document.body.classList.toggle("is-loading", loading);
  form.classList.toggle("is-loading", loading);
  form.setAttribute("aria-busy", String(loading));
  submit.disabled = loading;
  input.readOnly = loading;
  examples.forEach((button) => {
    button.disabled = loading;
  });
  if (clear) clear.disabled = loading;
  if (anew) anew.disabled = loading;
  submit.setAttribute("aria-label", loading ? "Converting URL" : "Convert URL");
  setDotsMode(loading ? "loading" : document.body.classList.contains("has-result") ? "result" : "idle");
}

function animateShellToResult() {
  const first = shell?.getBoundingClientRect();
  document.body.classList.add("has-result");
  // Let secondary chrome collapse before measuring the resting position.
  void document.body.offsetWidth;
  window.repruvDots?.resize?.();

  if (reduceMotion.matches || !shell || !first) return;

  const last = shell.getBoundingClientRect();
  const dy = first.top - last.top;
  if (Math.abs(dy) < 1) return;

  shell.animate(
    [
      { transform: `translateY(${dy}px)` },
      { transform: "translateY(0)" },
    ],
    {
      // Strong ease-out, sub-300ms — Emil Kowalski UI budget
      duration: 260,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      fill: "both",
    },
  );
}

function setClearVisible(visible) {
  if (!clear) return;
  clear.hidden = !visible;
}

function revealResult() {
  const token = ++revealToken;
  const alreadyOpen = document.body.classList.contains("has-result");

  if (!alreadyOpen) {
    animateShellToResult();
  } else {
    document.body.classList.add("has-result");
  }

  setClearVisible(true);
  result.hidden = false;
  result.setAttribute("aria-busy", "false");
  setDotsMode("result");

  if (reduceMotion.matches) return;

  // Restart enter animation when content changes.
  result.classList.remove("is-entering");
  // Force reflow so the animation can retrigger.
  void result.offsetWidth;
  if (token !== revealToken) return;
  result.classList.add("is-entering");
  window.setTimeout(() => {
    if (token === revealToken) result.classList.remove("is-entering");
  }, 280);
}

function resetToInput({ focus = true, clearUrl = true } = {}) {
  revealToken += 1;
  current = null;
  result.hidden = true;
  result.classList.remove("is-entering");
  errorBox.hidden = true;
  errorMessage.textContent = "";
  output.textContent = "";
  title.textContent = "";
  meta.textContent = "";
  document.body.classList.remove("has-result", "is-loading");
  form.classList.remove("is-loading");
  setClearVisible(false);
  setDotsMode("idle");

  if (clearUrl) {
    input.value = "";
  }
  history.replaceState(null, "", "/");

  if (focus) {
    input.focus();
    if (!clearUrl && input.value) input.select();
  }
}

function runConversion() {
  form.requestSubmit();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  track("conversion_submit");
  errorBox.hidden = true;
  errorMessage.textContent = "";
  result.setAttribute("aria-busy", "true");
  setLoading(true);

  try {
    const response = await fetch(`/api/extract?url=${encodeURIComponent(input.value)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "Conversion failed.");

    current = payload;
    title.textContent = payload.title || new URL(payload.finalUrl || input.value).hostname;
    output.textContent = payload.markdown;

    const words = Number(payload.stats?.words || 0).toLocaleString();
    const cache = String(payload.cache?.status || "fresh").toLowerCase();
    meta.textContent = `${words} words · ${cache} cache`;

    history.replaceState(null, "", `?url=${encodeURIComponent(input.value)}`);
    revealResult();

    if (window.matchMedia("(max-width: 600px)").matches) {
      result.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
    }
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : "Conversion failed.";
    errorBox.hidden = false;
    if (!document.body.classList.contains("has-result")) {
      result.hidden = true;
    }
  } finally {
    setLoading(false);
  }
});

examples.forEach((button) => {
  button.addEventListener("click", () => {
    const url = button.getAttribute("data-url");
    if (!url || form.classList.contains("is-loading")) return;
    track("example_click");
    input.value = url;
    runConversion();
  });
});

function handleNew() {
  if (form.classList.contains("is-loading")) return;
  track("new_conversion");
  resetToInput({ focus: true, clearUrl: true });
}

clear?.addEventListener("click", handleNew);
anew?.addEventListener("click", handleNew);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!document.body.classList.contains("has-result")) return;
  if (form.classList.contains("is-loading")) return;
  event.preventDefault();
  handleNew();
});

function shareLinkFor(sourceUrl) {
  const target = sourceUrl || current?.sourceUrl || current?.finalUrl || input.value;
  return `${location.origin}/md?url=${encodeURIComponent(target)}`;
}

copy.addEventListener("click", async () => {
  if (!current) return;

  try {
    await navigator.clipboard.writeText(current.markdown);
    copy.textContent = "Copied";
    copy.classList.add("is-success");
    track("copy_markdown");
  } catch {
    copy.textContent = "Copy failed";
    copy.classList.remove("is-success");
  }

  window.setTimeout(() => {
    copy.textContent = "Copy";
    copy.classList.remove("is-success");
  }, 1400);
});

share?.addEventListener("click", async () => {
  if (!current) return;
  const link = shareLinkFor(input.value || current.sourceUrl || current.finalUrl);

  try {
    if (navigator.share) {
      await navigator.share({
        title: current.title || "Markdown",
        text: current.title || "Converted Markdown",
        url: link,
      });
      track("share_link");
      return;
    }
  } catch (error) {
    // User cancel is fine; fall through only on unsupported/failed share.
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      return;
    }
  }

  try {
    await navigator.clipboard.writeText(link);
    share.textContent = "Link copied";
    share.classList.add("is-success");
    track("share_link");
  } catch {
    share.textContent = "Share failed";
    share.classList.remove("is-success");
  }

  window.setTimeout(() => {
    share.textContent = "Share";
    share.classList.remove("is-success");
  }, 1600);
});

download.addEventListener("click", () => {
  if (!current) return;
  track("download_markdown");

  const filename = (current.title || "document")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 80) || "document";
  const objectUrl = URL.createObjectURL(new Blob([current.markdown], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `${filename}.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
});

const initialUrl = new URL(location.href).searchParams.get("url");
if (initialUrl) {
  input.value = initialUrl;
  form.requestSubmit();
}
