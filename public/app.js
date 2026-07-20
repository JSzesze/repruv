const form = document.querySelector("#extract-form");
const input = document.querySelector("#url");
const result = document.querySelector("#result");
const errorBox = document.querySelector("#error");
const output = document.querySelector("#output");
const title = document.querySelector("#title");
const meta = document.querySelector("#meta");
const submit = form.querySelector("button[type=submit]");
const copy = document.querySelector("#copy");
const download = document.querySelector("#download");
const tabs = [...document.querySelectorAll(".tab")];

let current = null;
let format = "markdown";

function render() {
  if (!current) return;
  output.textContent = format === "markdown" ? current.markdown : JSON.stringify(current, null, 2);
  for (const tab of tabs) {
    const active = tab.dataset.format === format;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  result.hidden = true;
  errorBox.hidden = true;
  submit.disabled = true;
  submit.textContent = "Converting…";

  try {
    const response = await fetch(`/api/extract?url=${encodeURIComponent(input.value)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "Conversion failed.");

    current = payload;
    title.textContent = payload.title;
    const cache = `${payload.cache.status.toLowerCase()} cache`;
    meta.textContent = `${payload.provider.replaceAll("-", " ")} · ${payload.stats.words.toLocaleString()} words · ${cache}`;
    render();
    result.hidden = false;
    history.replaceState(null, "", `?url=${encodeURIComponent(input.value)}`);
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : "Conversion failed.";
    errorBox.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = "Convert";
  }
});

copy.addEventListener("click", async () => {
  if (!current) return;
  await navigator.clipboard.writeText(format === "markdown" ? current.markdown : JSON.stringify(current, null, 2));
  copy.textContent = "Copied";
  setTimeout(() => { copy.textContent = "Copy"; }, 1200);
});

download.addEventListener("click", () => {
  if (!current) return;
  const filename = current.title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 80) || "document";
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([current.markdown], { type: "text/markdown" }));
  link.download = `${filename}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
});

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    format = tab.dataset.format;
    render();
  });
}

const initialUrl = new URL(location.href).searchParams.get("url");
if (initialUrl) {
  input.value = initialUrl;
  form.requestSubmit();
}
