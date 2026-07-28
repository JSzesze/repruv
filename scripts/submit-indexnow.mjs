const HOST = "repruv.com";
const KEY = "b6f3ef5d-6ce6-438c-a6e5-0aef0cac1cec";
const urls = [
  `https://${HOST}/`,
  `https://${HOST}/url-to-markdown/`,
  `https://${HOST}/webpage-to-markdown/`,
  `https://${HOST}/x-to-markdown/`,
];

const response = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host: HOST,
    key: KEY,
    keyLocation: `https://${HOST}/${KEY}.txt`,
    urlList: urls,
  }),
});

if (response.status !== 200 && response.status !== 202) {
  const message = await response.text();
  throw new Error(`IndexNow submission failed (${response.status}): ${message}`);
}

console.log(
  `IndexNow accepted ${urls.length} Repruv URLs (${response.status === 202 ? "key verification pending" : "verified"}).`,
);
