const form = document.querySelector("#extract-form");
const input = document.querySelector("#url");
const result = document.querySelector("#result");
const errorBox = document.querySelector("#error");
const errorMessage = document.querySelector("#error-message");
const outputPanel = document.querySelector("#output-panel");
const output = document.querySelector("#output");
const title = document.querySelector("#title");
const meta = document.querySelector("#meta");
const formState = document.querySelector("#form-state");
const submit = form.querySelector("button[type=submit]");
const buttonLabel = submit.querySelector(".button-label");
const copy = document.querySelector("#copy");
const download = document.querySelector("#download");
const example = document.querySelector("#example");
const tabs = [...document.querySelectorAll(".tab")];

let current = null;
let format = "markdown";

function contentForCurrentFormat() {
  if (!current) return "";
  return format === "markdown" ? current.markdown : JSON.stringify(current, null, 2);
}

function render() {
  if (!current) return;
  output.textContent = contentForCurrentFormat();

  for (const tab of tabs) {
    const active = tab.dataset.format === format;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }

  outputPanel.setAttribute("aria-labelledby", format === "markdown" ? "tab-markdown" : "tab-json");
}

function setLoading(loading) {
  form.classList.toggle("is-loading", loading);
  form.setAttribute("aria-busy", String(loading));
  submit.disabled = loading;
  input.readOnly = loading;
  formState.textContent = loading ? "PROCESSING" : "READY";
  buttonLabel.textContent = loading ? "Working" : "Convert";
}

function resetNotices() {
  result.hidden = true;
  errorBox.hidden = true;
  errorMessage.textContent = "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resetNotices();
  setLoading(true);

  try {
    const response = await fetch(`/api/extract?url=${encodeURIComponent(input.value)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "Conversion failed.");

    current = payload;
    title.textContent = payload.title || new URL(payload.finalUrl || input.value).hostname;

    const provider = String(payload.provider || "direct").replaceAll("-", " ");
    const words = Number(payload.stats?.words || 0).toLocaleString();
    const cache = String(payload.cache?.status || "fresh").toUpperCase();
    meta.textContent = `${provider} / ${words} words / ${cache} cache`;

    format = "markdown";
    render();
    result.hidden = false;
    history.replaceState(null, "", `?url=${encodeURIComponent(input.value)}`);

    if (window.matchMedia("(max-width: 760px)").matches) {
      result.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : "Conversion failed.";
    errorBox.hidden = false;
  } finally {
    setLoading(false);
  }
});

copy.addEventListener("click", async () => {
  if (!current) return;

  try {
    await navigator.clipboard.writeText(contentForCurrentFormat());
    copy.textContent = "Copied";
  } catch {
    copy.textContent = "Copy failed";
  }

  window.setTimeout(() => { copy.textContent = "Copy"; }, 1400);
});

download.addEventListener("click", () => {
  if (!current) return;

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

example.addEventListener("click", () => {
  input.value = "https://example.com";
  input.focus();
  form.requestSubmit();
});

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    format = tab.dataset.format;
    render();
  });

  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.click();
    next.focus();
  });
}

const initialUrl = new URL(location.href).searchParams.get("url");
if (initialUrl) {
  input.value = initialUrl;
  form.requestSubmit();
}
