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
const download = document.querySelector("#download");

let current = null;

function setLoading(loading) {
  form.classList.toggle("is-loading", loading);
  form.setAttribute("aria-busy", String(loading));
  submit.disabled = loading;
  input.readOnly = loading;
  submit.setAttribute("aria-label", loading ? "Converting URL" : "Convert URL");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  result.hidden = true;
  errorBox.hidden = true;
  errorMessage.textContent = "";
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

    result.hidden = false;
    history.replaceState(null, "", `?url=${encodeURIComponent(input.value)}`);

    if (window.matchMedia("(max-width: 600px)").matches) {
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
    await navigator.clipboard.writeText(current.markdown);
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

const initialUrl = new URL(location.href).searchParams.get("url");
if (initialUrl) {
  input.value = initialUrl;
  form.requestSubmit();
}
