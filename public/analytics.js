(() => {
  const pages = new Map([
    ["/", "home"],
    ["/url-to-markdown/", "url-guide"],
    ["/webpage-to-markdown/", "webpage-guide"],
    ["/x-to-markdown/", "x-guide"],
  ]);
  const page = pages.get(location.pathname) || "other";

  window.repruvTrack = (event) => {
    const body = JSON.stringify({ event, page });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/event",
        new Blob([body], { type: "application/json" }),
      );
      return;
    }
    fetch("/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  };

  window.repruvTrack("browser_page_view");
})();

